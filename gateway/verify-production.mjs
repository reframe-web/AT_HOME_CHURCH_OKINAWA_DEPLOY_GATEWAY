import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));

function fail(message) {
  throw new Error(message);
}

function withCacheBust(url, key) {
  const target = new URL(url);
  target.searchParams.set(key, Date.now().toString());
  return target;
}

async function fetchChecked({ url, label, userAgent, requireIdentity = false, requireText, validateResponse }) {
  const response = await fetch(withCacheBust(url, "ahc_verify"), {
    redirect: "follow",
    headers: {
      "cache-control": "no-cache",
      "user-agent": userAgent
    }
  });

  if (!response.ok) {
    fail(`${label} failed: HTTP ${response.status} at ${response.url || url}`);
  }

  const body = await response.text();
  if (!body.trim()) {
    fail(`${label} returned an empty response at ${response.url || url}`);
  }

  if (requireIdentity) {
    const hasIdentity =
      body.includes("AT HOME CHURCH OKINAWA") ||
      body.includes("アットホームチャーチ沖縄");
    if (!hasIdentity) {
      fail(`${label} did not contain the expected AHC identity marker.`);
    }
  }

  if (requireText && !body.includes(requireText)) {
    fail(`${label} did not contain required text: ${requireText}`);
  }

  if (validateResponse) {
    await validateResponse({ response, body });
  }

  console.log(`${label} passed: ${response.status} ${response.url || url}`);
  return { response, body };
}

// Firebase Hosting may briefly return a stale 404 immediately after a successful
// release. Retry the requested production route, but never treat a 404 as success.
async function fetchRequestedRouteAfterRelease(options) {
  const delaysMs = [0, 5000, 10000, 20000, 30000, 45000, 60000];
  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    if (delaysMs[attempt] > 0) {
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
    try {
      return await fetchChecked(options);
    } catch (error) {
      const message = String(error?.message || error);
      const transient = /HTTP (?:404|429|500|502|503|504)\b|fetch failed|timed out/i.test(message);
      if (!transient || attempt === delaysMs.length - 1) {
        throw error;
      }
      console.warn(`Production route not ready (attempt ${attempt + 1}/${delaysMs.length}): ${message}`);
    }
  }
}

const requestedPath = process.argv[2] || "/";
if (!requestedPath.startsWith("/") || requestedPath.includes("://") || requestedPath.includes("\\")) {
  fail(`Invalid verification path: ${requestedPath}`);
}

const production = new URL(config.productionUrl);
const requestedUrl = new URL(requestedPath, production);
const homeUrl = new URL("/", production);
const robotsUrl = new URL("/robots.txt", production);
const sitemapUrl = new URL("/sitemap.xml", production);

const OAI_SEARCHBOT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot";
const CHATGPT_USER_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const GOOGLEBOT_SMARTPHONE_UA =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

try {
  await fetchRequestedRouteAfterRelease({
    url: requestedUrl,
    label: "Production runtime verification",
    userAgent: "AHC-Deploy-Gateway/1.1",
    requireIdentity: requestedPath === "/"
  });

  await fetchChecked({
    url: homeUrl,
    label: "OAI-SearchBot Home verification",
    userAgent: OAI_SEARCHBOT_UA,
    requireIdentity: true
  });

  const { body: robotsBody } = await fetchChecked({
    url: robotsUrl,
    label: "OAI-SearchBot robots.txt verification",
    userAgent: `${OAI_SEARCHBOT_UA}; robots.txt`,
    requireText: "Sitemap: https://athchurch.org/sitemap.xml"
  });

  if (/User-agent:\s*OAI-SearchBot[\s\S]*?Disallow:\s*\/\s*(?:\r?\n|$)/i.test(robotsBody)) {
    fail("robots.txt explicitly blocks OAI-SearchBot from the site root.");
  }

  await fetchChecked({
    url: sitemapUrl,
    label: "OAI-SearchBot sitemap verification",
    userAgent: OAI_SEARCHBOT_UA,
    requireText: "https://athchurch.org/",
    validateResponse: ({ response, body }) => {
      const contentType = response.headers.get("content-type") || "";
      if (!/(application|text)\/xml/i.test(contentType)) {
        fail(`Sitemap returned unexpected Content-Type for OAI-SearchBot: ${contentType || "(missing)"}`);
      }
      if (!/<urlset\b[^>]*xmlns=["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["'][^>]*>/i.test(body)) {
        fail("Sitemap is missing the required sitemaps.org urlset namespace.");
      }
      if (!/<\/urlset>\s*$/i.test(body.trim())) {
        fail("Sitemap does not end with a closing urlset element.");
      }
      const urlCount = (body.match(/<url>/gi) || []).length;
      if (urlCount < 1 || urlCount > 50000) {
        fail(`Sitemap URL count is outside Google sitemap limits: ${urlCount}`);
      }
      if (Buffer.byteLength(body, "utf8") > 50 * 1024 * 1024) {
        fail("Sitemap exceeds the 50 MB uncompressed limit.");
      }
      console.log(`Sitemap structure verification passed: content-type=${contentType}; urls=${urlCount}`);
    }
  });

  await fetchChecked({
    url: sitemapUrl,
    label: "Googlebot sitemap verification",
    userAgent: GOOGLEBOT_SMARTPHONE_UA,
    requireText: "https://athchurch.org/",
    validateResponse: ({ response, body }) => {
      const contentType = response.headers.get("content-type") || "";
      if (!/(application|text)\/xml/i.test(contentType)) {
        fail(`Sitemap returned unexpected Content-Type for Googlebot: ${contentType || "(missing)"}`);
      }
      if (!/<urlset\b[^>]*xmlns=["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["'][^>]*>/i.test(body)) {
        fail("Googlebot sitemap response is not a valid sitemap urlset.");
      }
      console.log(`Googlebot sitemap response passed: content-type=${contentType}`);
    }
  });

  await fetchChecked({
    url: homeUrl,
    label: "ChatGPT-User Home verification",
    userAgent: CHATGPT_USER_UA,
    requireIdentity: true
  });

  console.log("AHC_CRAWLER_ACCESS_VERIFICATION_PASSED");
} catch (error) {
  console.error(`AHC_PRODUCTION_VERIFY_ERROR: ${error.message}`);
  process.exit(1);
}
