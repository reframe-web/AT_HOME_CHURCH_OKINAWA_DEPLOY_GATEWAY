import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));

const GOOGLE_DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps.";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith("--")) fail(`Unexpected argument: ${key}`);
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function readServiceAccount() {
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath) fail("GOOGLE_APPLICATION_CREDENTIALS is not set.");
  const raw = fs.readFileSync(credentialPath, "utf8");
  const json = JSON.parse(raw);
  if (!json.client_email || !json.private_key) {
    fail("Service-account JSON is missing client_email or private_key.");
  }
  return json;
}

async function getDriveAccessToken() {
  const sa = readServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(sa.private_key).toString("base64url");
  const assertion = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await response.text();
  if (!response.ok) {
    fail(`OAuth token request failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  const parsed = JSON.parse(text);
  if (!parsed.access_token) fail("OAuth response did not contain access_token.");
  return parsed.access_token;
}

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      const body = await response.text();
      const error = new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
  }
  throw lastError;
}

function validateDriveName(name, parentPath = "") {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    fail(`Unsafe or unsupported Drive name under ${parentPath || "<root>"}: ${JSON.stringify(name)}`);
  }
}

async function listChildren(token, folderId) {
  const all = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      spaces: "drive",
      pageSize: "1000",
      fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,parents)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetchWithRetry(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const payload = await response.json();
    all.push(...(payload.files || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);

  return all.sort((a, b) =>
    a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en")
  );
}

function inventoryEntry(file, relPath, kind) {
  return {
    kind,
    path: relPath.replaceAll("\\", "/"),
    id: file.id,
    mimeType: file.mimeType,
    size: file.size ?? null,
    modifiedTime: file.modifiedTime ?? null,
    md5Checksum: file.md5Checksum ?? null
  };
}

async function buildInventory(token) {
  const rootChildren = await listChildren(token, config.driveRootFolderId);
  const entries = [];
  const seenPaths = new Set();

  for (const requiredName of config.requiredRootFiles) {
    const matches = rootChildren.filter((item) => item.name === requiredName);
    if (matches.length !== 1) {
      fail(`Required root file "${requiredName}" must exist exactly once; found ${matches.length}.`);
    }
    const file = matches[0];
    if (file.mimeType === GOOGLE_DRIVE_FOLDER_MIME || file.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
      fail(`Required root file "${requiredName}" is not a raw downloadable file.`);
    }
    validateDriveName(file.name);
    const row = inventoryEntry(file, file.name, "file");
    entries.push(row);
    seenPaths.add(row.path);
  }

  async function addRequiredSourcePath(relPath) {
    const parts = String(relPath || "").split("/").filter(Boolean);
    if (parts.length < 1) fail("requiredSourcePaths contains an empty path.");

    let children = rootChildren;
    let parentLabel = "<root>";

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      validateDriveName(part, parentLabel);
      const matches = children.filter((item) => item.name === part);
      if (matches.length !== 1) {
        fail(`Required source path "${relPath}" must resolve uniquely at "${part}"; found ${matches.length}.`);
      }

      const item = matches[0];
      const isLast = index === parts.length - 1;
      if (!isLast) {
        if (item.mimeType !== GOOGLE_DRIVE_FOLDER_MIME) {
          fail(`Required source path "${relPath}" expected folder at "${parts.slice(0, index + 1).join("/")}".`);
        }
        children = await listChildren(token, item.id);
        parentLabel = parts.slice(0, index + 1).join("/");
        continue;
      }

      const normalizedPath = parts.join("/");

      if (item.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
        async function walkRequiredSource(folder, relFolder) {
          validateDriveName(folder.name, path.posix.dirname(relFolder));
          const folderPath = relFolder.replaceAll("\\", "/");
          if (seenPaths.has(folderPath)) fail(`Duplicate Drive path: ${folderPath}`);
          seenPaths.add(folderPath);
          entries.push(inventoryEntry(folder, folderPath, "folder"));

          const sourceChildren = await listChildren(token, folder.id);
          const sourceNames = new Map();
          for (const child of sourceChildren) {
            validateDriveName(child.name, folderPath);
            const count = (sourceNames.get(child.name) || 0) + 1;
            sourceNames.set(child.name, count);
            if (count > 1) {
              fail(`Duplicate Drive name in source folder ${folderPath}: ${child.name}`);
            }

            const childPath = path.posix.join(folderPath, child.name);
            if (child.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
              await walkRequiredSource(child, childPath);
              continue;
            }
            if (child.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
              fail(`Unsupported Google-native file under required source path: ${childPath} (${child.mimeType})`);
            }
            if (seenPaths.has(childPath)) fail(`Duplicate Drive path: ${childPath}`);
            seenPaths.add(childPath);
            entries.push(inventoryEntry(child, childPath, "file"));
          }
        }

        await walkRequiredSource(item, normalizedPath);
        return;
      }

      if (item.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
        fail(`Required source path "${relPath}" is not a raw downloadable file.`);
      }

      if (seenPaths.has(normalizedPath)) fail(`Duplicate Drive path: ${normalizedPath}`);
      seenPaths.add(normalizedPath);
      entries.push(inventoryEntry(item, normalizedPath, "file"));
    }
  }

  for (const requiredPath of config.requiredSourcePaths || []) {
    await addRequiredSourcePath(requiredPath);
  }

  const publicMatches = rootChildren.filter(
    (item) => item.name === config.publicFolderName && item.mimeType === GOOGLE_DRIVE_FOLDER_MIME
  );
  if (publicMatches.length !== 1) {
    fail(`Public folder "${config.publicFolderName}" must exist exactly once; found ${publicMatches.length}.`);
  }

  async function walk(folder, relFolder) {
    validateDriveName(folder.name, path.posix.dirname(relFolder));
    const folderPath = relFolder.replaceAll("\\", "/");
    if (seenPaths.has(folderPath)) fail(`Duplicate Drive path: ${folderPath}`);
    seenPaths.add(folderPath);
    entries.push(inventoryEntry(folder, folderPath, "folder"));

    const children = await listChildren(token, folder.id);
    const names = new Map();
    for (const child of children) {
      validateDriveName(child.name, folderPath);
      const count = (names.get(child.name) || 0) + 1;
      names.set(child.name, count);
      if (count > 1) {
        fail(`Duplicate Drive name in folder ${folderPath}: ${child.name}`);
      }

      const childPath = path.posix.join(folderPath, child.name);
      if (child.mimeType === GOOGLE_DRIVE_FOLDER_MIME) {
        await walk(child, childPath);
        continue;
      }
      if (child.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
        fail(`Unsupported Google-native file under public/: ${childPath} (${child.mimeType})`);
      }
      if (seenPaths.has(childPath)) fail(`Duplicate Drive path: ${childPath}`);
      seenPaths.add(childPath);
      entries.push(inventoryEntry(child, childPath, "file"));
    }
  }

  const publicFolder = publicMatches[0];
  await walk(publicFolder, config.publicFolderName);

  const normalized = entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");

  return {
    schema: 1,
    rootFolderId: config.driveRootFolderId,
    firebaseProjectId: config.firebaseProjectId,
    fingerprint,
    entries: normalized
  };
}

async function downloadFile(token, entry, destination) {
  const response = await fetchWithRetry(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  const bytes = Buffer.from(await response.arrayBuffer());

  if (entry.size !== null && Number(entry.size) !== bytes.length) {
    fail(`Size mismatch for ${entry.path}: expected ${entry.size}, got ${bytes.length}`);
  }
  if (entry.md5Checksum) {
    const actual = crypto.createHash("md5").update(bytes).digest("hex");
    if (actual.toLowerCase() !== entry.md5Checksum.toLowerCase()) {
      fail(`MD5 mismatch for ${entry.path}`);
    }
  }

  const outPath = path.join(destination, ...entry.path.split("/"));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bytes);
  if (entry.modifiedTime) {
    const when = new Date(entry.modifiedTime);
    fs.utimesSync(outPath, when, when);
  }
}

async function downloadSnapshot(outDir, manifestPath) {
  const token = await getDriveAccessToken();
  const before = await buildInventory(token);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const entry of before.entries) {
    const outPath = path.join(outDir, ...entry.path.split("/"));
    if (entry.kind === "folder") {
      fs.mkdirSync(outPath, { recursive: true });
      continue;
    }
    await downloadFile(token, entry, outDir);
  }

  const after = await buildInventory(token);
  if (before.fingerprint !== after.fingerprint) {
    fail(
      `Drive source changed during snapshot. before=${before.fingerprint} after=${after.fingerprint}`
    );
  }

  const manifest = {
    ...after,
    generatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`AHC Drive snapshot stable: ${manifest.fingerprint}`);
  console.log(`Snapshot entries: ${manifest.entries.length}`);
}

async function verifySnapshot(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const token = await getDriveAccessToken();
  const current = await buildInventory(token);

  if (manifest.fingerprint !== current.fingerprint) {
    fail(
      `Drive source changed after snapshot. snapshot=${manifest.fingerprint} current=${current.fingerprint}`
    );
  }
  console.log(`AHC Drive source still matches snapshot: ${current.fingerprint}`);
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.command === "download") {
    if (!args.out || !args.manifest) fail("download requires --out and --manifest.");
    await downloadSnapshot(path.resolve(args.out), path.resolve(args.manifest));
  } else if (args.command === "verify") {
    if (!args.manifest) fail("verify requires --manifest.");
    await verifySnapshot(path.resolve(args.manifest));
  } else {
    fail('Usage: node drive-snapshot.mjs download --out <dir> --manifest <file> | verify --manifest <file>');
  }
} catch (error) {
  console.error(`AHC_DEPLOY_GATEWAY_ERROR: ${error.message}`);
  process.exit(1);
}
