import { getEnrichmentCandidates, saveEnrichment, applyEnrichmentCache, clearEnrichmentCache, getListingsByVins, getEnrichmentByVin, clearPossiblySold, type EnrichmentData } from "../db.ts";
import { readFileSync } from "fs";
import { resolve } from "path";

// Brave Search API key (read from Claude Code MCP config)
let BRAVE_API_KEY = "";
try {
  const configPath = resolve(process.env.USERPROFILE || process.env.HOME || "", ".claude.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  BRAVE_API_KEY = config?.mcpServers?.["brave-search"]?.env?.BRAVE_API_KEY || "";
} catch {}

const SKIP_DOMAINS = new Set([
  "autotrader.com", "cars.com", "cargurus.com", "truecar.com", "edmunds.com",
  "ebay.com", "carfax.com", "kbb.com", "marketcheck.com", "auto.dev", "tesla.com",
  "autonation.com", "carvana.com", "vroom.com", "google.com", "bing.com",
  "duckduckgo.com", "yahoo.com", "facebook.com", "youtube.com", "twitter.com",
  "wikipedia.org", "reddit.com", "instagram.com", "tiktok.com", "vindecoderz.com",
  "vehiclehistory.com", "iseecars.com", "carsdirect.com", "nadaguides.com",
  "autoblog.com", "caranddriver.com", "motortrend.com", "jdpower.com",
  "yelp.com", "bbb.org", "mapquest.com", "yellowpages.com", "dealerrater.com",
  "consumeraffairs.com", "trustpilot.com", "glassdoor.com",
]);

const MAX_VINS_PER_RUN = 25;
const BRAVE_DELAY_MS = 1100; // Brave free tier: 1 req/sec
const FETCH_DELAY_MS = 500;
const ENRICH_CONCURRENCY = 3; // Concurrent VIN enrichments

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Brave rate limiter: ensures max 1 request per BRAVE_DELAY_MS globally
let _lastBraveCall = 0;
async function braveRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastBraveCall;
  if (elapsed < BRAVE_DELAY_MS) {
    await sleep(BRAVE_DELAY_MS - elapsed);
  }
  _lastBraveCall = Date.now();
}

// Simple concurrency limiter (no dependency needed)
function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          if (queue.length > 0) queue.shift()!();
        });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

function isDealerDomain(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.replace(/^www\./, "");
    for (const domain of SKIP_DOMAINS) {
      if (host === domain || host.endsWith("." + domain)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractDomain(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return u.origin; // https://www.example.com
  } catch {
    return "";
  }
}

/** Use Brave Search API to find the dealer's website */
async function findDealerDomain(dealerName: string, dealerLocation: string): Promise<string | null> {
  if (!BRAVE_API_KEY) return null;

  await braveRateLimit(); // Global rate limiter for concurrent access

  const query = encodeURIComponent(`${dealerName} ${dealerLocation} dealer`);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${query}&count=5`;

  try {
    const resp = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as any;
    const results = data?.web?.results || [];

    // Find the first result that's an actual dealer domain (not an aggregator)
    for (const r of results) {
      if (isDealerDomain(r.url)) {
        return extractDomain(r.url);
      }
    }
  } catch {}

  return null;
}

/** Search Brave for a VIN on a specific dealer domain — returns ALL matching URLs (best first) */
async function findVinUrlsOnDealerSite(dealerDomain: string, vin: string): Promise<string[]> {
  if (!BRAVE_API_KEY) return [];

  await braveRateLimit(); // Global rate limiter for concurrent access

  const host = new URL(dealerDomain).hostname;
  const query = encodeURIComponent(`${vin} site:${host}`);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${query}&count=5`;

  try {
    const resp = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": BRAVE_API_KEY,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return [];

    const data = await resp.json() as any;
    const results = data?.web?.results || [];

    const urls: string[] = [];
    for (const r of results) {
      if (r.url && r.url.includes(host)) {
        urls.push(r.url);
      }
    }
    // Prioritize VDP-looking URLs over index/search pages
    urls.sort((a, b) => {
      const aVdp = isVdpCandidate(a) ? 0 : 1;
      const bVdp = isVdpCandidate(b) ? 0 : 1;
      return aVdp - bVdp;
    });
    return urls;
  } catch {}

  return [];
}

/** Fetch a URL using curl subprocess (avoids Bun's TLS fingerprint triggering WAFs) */
async function curlFetch(url: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["curl", "-s", "-L", "--max-time", "15",
      "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      url,
    ], { stdout: "pipe", stderr: "pipe" });

    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.length > 100 ? output : null;
  } catch {
    return null;
  }
}

/** Detect dealer search pages that returned zero results */
function isZeroResultsPage(html: string, vin: string): boolean {
  // Common "0 results" patterns on dealer DMS platforms
  const zeroPatterns = [
    /0\s*vehicles?\s*(?:matching|found|available|results)/i,
    /no\s*(?:vehicles?|results?|listings?|matches?)\s*(?:found|matching|available)/i,
    /your\s*search.*(?:did not|didn'?t)\s*(?:match|return|find)/i,
    /sorry.*no\s*(?:results|vehicles|listings)/i,
    /we\s*(?:could|couldn'?t)\s*(?:not\s*)?find/i,
  ];
  for (const re of zeroPatterns) {
    if (re.test(html)) return true;
  }

  // Check if VIN only appears inside input/meta/url contexts (not in vehicle data)
  // Strip all tags and check if VIN appears in the remaining text
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  // If VIN doesn't appear in visible text at all, it's just in URLs/inputs
  if (!stripped.includes(vin)) return true;

  return false;
}

/** Try common dealer site search URL patterns to find a VIN */
async function searchDealerSite(dealerDomain: string, vin: string): Promise<string | null> {
  // Common DMS search patterns (DealerSocket/Dealer.com uses /used-inventory/index.htm?search=)
  const patterns = [
    `${dealerDomain}/used-inventory/index.htm?search=${vin}`,
    `${dealerDomain}/search/?q=${vin}`,
    `${dealerDomain}/inventory/?q=${vin}`,
    `${dealerDomain}/vehicles/?search=${vin}`,
  ];

  for (const searchUrl of patterns) {
    const html = await curlFetch(searchUrl);
    if (!html) { await sleep(FETCH_DELAY_MS); continue; }

    // The VIN will appear in the URL/search box even on "0 results" pages.
    // Only return the HTML if the VIN appears in actual content (e.g. JSON-LD,
    // listing cards) — not just in URLs, input values, or "0 Vehicles Matching" text.
    if (isZeroResultsPage(html, vin)) {
      await sleep(FETCH_DELAY_MS);
      continue;
    }

    // Check that VIN appears in a meaningful context (JSON-LD, data attributes, listing text)
    if (html.includes(vin)) {
      return html;
    }
    await sleep(FETCH_DELAY_MS);
  }

  return null;
}

/** Given a page that contains a VIN, find and follow the link to the vehicle detail page */
async function followVdpLink(html: string, vin: string, dealerDomain: string): Promise<{ html: string; url: string } | null> {
  // Look for <a> tags whose href is near or contains a reference to this VIN
  // DealerSocket: /used/Make/Year-Make-Model-for-sale-location-hash.htm
  // CDK: /VehicleDetails/used-Year-Make-Model-Location-VIN/id
  // DealerOn: /inventory/used-Year-Make-Model/id

  const vinUpper = vin.toUpperCase();
  const vinLower = vin.toLowerCase();

  // Strategy 1: Find links containing the VIN directly
  const vinLinkRegex = new RegExp(`<a[^>]+href="([^"]*${vin}[^"]*)"`, "gi");
  for (const m of html.matchAll(vinLinkRegex)) {
    const href = resolveUrl(m[1]!, dealerDomain);
    if (href) {
      const vdpHtml = await curlFetch(href);
      if (vdpHtml && vdpHtml.length > 5000) return { html: vdpHtml, url: href };
      await sleep(FETCH_DELAY_MS);
    }
  }

  // Strategy 2: Find the link closest to where the VIN appears in the HTML
  const vinIdx = html.indexOf(vinUpper) !== -1 ? html.indexOf(vinUpper) : html.indexOf(vinLower);
  if (vinIdx !== -1) {
    // Search backwards from VIN position for the nearest <a href> (usually the card wraps the VIN)
    const before = html.slice(Math.max(0, vinIdx - 3000), vinIdx);
    const linkMatches = [...before.matchAll(/<a[^>]+href="([^"]+)"[^>]*>/gi)];
    // Take the closest link (last match)
    for (let i = linkMatches.length - 1; i >= 0; i--) {
      const href = resolveUrl(linkMatches[i]![1]!, dealerDomain);
      if (href && isVdpCandidate(href)) {
        const vdpHtml = await curlFetch(href);
        if (vdpHtml && vdpHtml.length > 5000) return { html: vdpHtml, url: href };
        await sleep(FETCH_DELAY_MS);
        break; // Only try the closest one
      }
    }
  }

  return null;
}

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    if (href.startsWith("http")) return href;
    if (href.startsWith("/")) return new URL(href, baseUrl).href;
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function isVdpCandidate(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  // Skip generic pages
  if (path === "/" || path === "/inventory/" || path === "/used-inventory/" || path.endsWith("index.htm")) return false;
  // VDP patterns: long paths with vehicle details
  return path.includes("/used/") || path.includes("/pre-owned/") ||
    path.includes("/vehicledetails/") || path.includes("/vehicle/") ||
    path.includes("-for-sale") || path.includes("/inventory/") && path.length > 30;
}

/** Parse a dealer page HTML for vehicle data matching the given VIN */
function parseDealerHtml(html: string, vin: string, pageUrl: string): EnrichmentData | null {
  const data: EnrichmentData = { dealerUrl: pageUrl };

  // Tier 1: JSON-LD structured data — look for items matching our exact VIN
  const jsonLdMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of jsonLdMatches) {
    try {
      const parsed = JSON.parse(m[1]!);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const itemVin = item.vehicleIdentificationNumber || item.mpn || item.sku || "";
        const itemType = item["@type"] || "";
        const isVehicle = itemType === "Vehicle" || itemType === "Car" || itemType === "Product" ||
          (typeof itemType === "string" && itemType.includes("Vehicle"));

        if (isVehicle && String(itemVin).includes(vin)) {
          // Exact VIN match in JSON-LD — extract everything
          const price = extractJsonLdPrice(item);
          if (price && price > 0) data.price = price;
          const mileage = extractJsonLdMileage(item);
          if (mileage && mileage > 0) data.mileage = mileage;
          if (item.color && typeof item.color === "string") data.exteriorColor = item.color;
          if (item.vehicleInteriorColor && typeof item.vehicleInteriorColor === "string") data.interiorColor = item.vehicleInteriorColor;

          // Extract detail URL if available
          if (item.url) {
            const detailUrl = item.url.startsWith("http") ? item.url : new URL(item.url, pageUrl).href;
            data.dealerUrl = detailUrl;
          }
        }
      }
    } catch {}
  }

  // Tier 2: Meta tags (only fill what JSON-LD didn't find)
  if (!data.price) {
    const priceMetaMatch = html.match(/<meta[^>]+(?:property|name)="(?:og:price:amount|product:price:amount|price)"[^>]+content="([^"]+)"/i)
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="(?:og:price:amount|product:price:amount|price)"/i);
    if (priceMetaMatch) {
      const p = parseInt(priceMetaMatch[1]!.replace(/[^0-9]/g, ""), 10);
      if (p > 1000 && p < 500000) data.price = p;
    }
  }

  // Tier 3: Regex fallback — only if page has a single vehicle (VIN appears)
  if (!data.price) {
    const priceRegex = /(?:price|asking|sale)[^$]{0,50}\$\s*([\d,]+)/i;
    const priceMatch = html.match(priceRegex);
    if (priceMatch) {
      const p = parseInt(priceMatch[1]!.replace(/,/g, ""), 10);
      if (p > 1000 && p < 500000) data.price = p;
    }
    if (!data.price) {
      const standalonePrice = html.match(/\$\s*([\d]{2,3},[\d]{3})/);
      if (standalonePrice) {
        const p = parseInt(standalonePrice[1]!.replace(/,/g, ""), 10);
        if (p > 20000 && p < 200000) data.price = p;
      }
    }
  }

  if (!data.mileage) {
    const mileageRegex = /([\d,]+)\s*(?:mi(?:les?)?|mi\.)\b/i;
    const mileageMatch = html.match(mileageRegex);
    if (mileageMatch) {
      const m = parseInt(mileageMatch[1]!.replace(/,/g, ""), 10);
      if (m > 0 && m < 200000) data.mileage = m;
    }
  }

  if (!data.interiorColor) {
    const intColorRegex = /(?:interior\s*(?:color)?)\s*[:=]\s*([A-Za-z][A-Za-z\s/&-]{1,30})/i;
    const intMatch = html.match(intColorRegex);
    if (intMatch) data.interiorColor = intMatch[1]!.trim();
  }

  if (!data.exteriorColor) {
    const extColorRegex = /(?:exterior\s*(?:color)?)\s*[:=]\s*([A-Za-z][A-Za-z\s/&-]{1,30})/i;
    const extMatch = html.match(extColorRegex);
    if (extMatch) data.exteriorColor = extMatch[1]!.trim();
  }

  // Image extraction: og:image, meta tags, pictures.dealer.com
  if (!data.imageUrl) {
    // og:image (may use name= or property=)
    const ogImageMatch = html.match(/<meta[^>]+(?:property|name)="og:image"[^>]+content="([^"]+)"/i)
      || html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="og:image"/i);
    if (ogImageMatch) {
      data.imageUrl = ogImageMatch[1]!;
    }
  }

  // JSON-LD image field
  if (!data.imageUrl) {
    const jsonLdImgs = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    for (const m of jsonLdImgs) {
      try {
        const parsed = JSON.parse(m[1]!);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const img = item.image;
          if (img) {
            const imgUrl = typeof img === "string" ? img : (Array.isArray(img) ? img[0] : img?.url);
            if (imgUrl && typeof imgUrl === "string" && imgUrl.startsWith("http")) {
              data.imageUrl = imgUrl;
              break;
            }
          }
        }
      } catch {}
      if (data.imageUrl) break;
    }
  }

  const hasData = data.price || data.mileage || data.interiorColor || data.exteriorColor || data.imageUrl;
  return hasData ? data : null;
}

function extractJsonLdPrice(item: any): number | undefined {
  if (item.price) {
    const p = parseInt(String(item.price).replace(/[^0-9]/g, ""), 10);
    if (p > 1000 && p < 500000) return p;
  }
  const offers = item.offers || item.offer;
  if (offers) {
    const offerList = Array.isArray(offers) ? offers : [offers];
    for (const o of offerList) {
      if (o.price) {
        const p = parseInt(String(o.price).replace(/[^0-9]/g, ""), 10);
        if (p > 1000 && p < 500000) return p;
      }
    }
  }
  return undefined;
}

function extractJsonLdMileage(item: any): number | undefined {
  if (item.mileageFromOdometer) {
    const val = typeof item.mileageFromOdometer === "object"
      ? item.mileageFromOdometer.value
      : item.mileageFromOdometer;
    const m = parseInt(String(val).replace(/[^0-9]/g, ""), 10);
    if (m > 0 && m < 200000) return m;
  }
  if (item.mileage) {
    const m = parseInt(String(item.mileage).replace(/[^0-9]/g, ""), 10);
    if (m > 0 && m < 200000) return m;
  }
  return undefined;
}

export type EnrichProgressCallback = (msg: string) => void;

export interface EnrichResult {
  candidates: number;
  searched: number;
  enriched: number;
  details: { vin: string; fields: string[]; dealerUrl: string | null }[];
}

/** Enrich a single VIN — returns true if data was found */
async function enrichSingleVin(
  candidate: { vin: string; price: number; mileage: number; interiorColor: string; imageUrl: string; dealerName: string; dealerLocation: string },
  dealerDomainCache: Map<string, string | null>,
  log: (msg: string) => void,
): Promise<boolean> {
  const c = candidate;
  const missing: string[] = [];
  if (c.price === 0) missing.push("price");
  if (c.mileage === 0) missing.push("mileage");
  if (!c.interiorColor) missing.push("interiorColor");
  if (!c.imageUrl) missing.push("imageUrl");

  log(`[enrich] ${c.vin} (${c.dealerName}) — missing: ${missing.join(", ")}`);

  // Step 1: Find dealer domain (cached by dealer name)
  const cacheKey = `${c.dealerName}|${c.dealerLocation}`;
  let dealerDomain: string | null;
  if (dealerDomainCache.has(cacheKey)) {
    dealerDomain = dealerDomainCache.get(cacheKey)!;
  } else {
    dealerDomain = await findDealerDomain(c.dealerName, c.dealerLocation);
    dealerDomainCache.set(cacheKey, dealerDomain);
  }

  if (!dealerDomain) {
    log(`[enrich] ${c.vin}: couldn't find dealer website for "${c.dealerName}"`);
    saveEnrichment(c.vin, {});
    return false;
  }

  log(`[enrich] ${c.vin}: dealer site → ${dealerDomain}`);

  // Step 2a: Search Brave for VIN on the dealer's domain (returns multiple URLs, VDP-like first)
  const vinUrls = await findVinUrlsOnDealerSite(dealerDomain, c.vin);

  let data: EnrichmentData | null = null;

  // Step 2b: Try each Brave result URL — VDP-like URLs are tried first
  for (const vinUrl of vinUrls) {
    log(`[enrich] ${c.vin}: trying Brave result → ${vinUrl}`);
    const html = await curlFetch(vinUrl);
    await sleep(FETCH_DELAY_MS);
    if (!html) continue;

    // Skip pages that show "0 results" for this VIN
    if (isZeroResultsPage(html, c.vin)) continue;

    const hasVin = html.includes(c.vin);

    // Only trust parsed data if the page actually mentions this VIN
    // (prevents false matches from regex on generic inventory pages)
    if (hasVin) {
      data = parseDealerHtml(html, c.vin, vinUrl);
      if (data) break;
    }

    // If page has the VIN but no structured data, try following VDP links
    if (hasVin) {
      log(`[enrich] ${c.vin}: page has VIN but no data, following VDP link...`);
      const vdp = await followVdpLink(html, c.vin, dealerDomain);
      if (vdp) {
        log(`[enrich] ${c.vin}: followed VDP → ${vdp.url}`);
        data = parseDealerHtml(vdp.html, c.vin, vdp.url);
        if (data) break;
      }
    }
  }

  // Step 2c: Fall back to DMS search patterns if Brave URLs didn't yield data
  if (!data) {
    const searchHtml = await searchDealerSite(dealerDomain, c.vin);
    if (searchHtml) {
      data = parseDealerHtml(searchHtml, c.vin, `${dealerDomain}/used-inventory/index.htm?search=${c.vin}`);

      // If search page has VIN but no data, try following VDP links
      if (!data && searchHtml.includes(c.vin)) {
        log(`[enrich] ${c.vin}: search page has VIN, following VDP link...`);
        const vdp = await followVdpLink(searchHtml, c.vin, dealerDomain);
        if (vdp) {
          log(`[enrich] ${c.vin}: followed VDP → ${vdp.url}`);
          data = parseDealerHtml(vdp.html, c.vin, vdp.url);
        }
      }
    }
  }

  if (data) {
    const fields = Object.keys(data).filter(k => k !== "dealerUrl" && (data as any)[k]);
    log(`[enrich] ${c.vin}: enriched (${fields.join(", ")}) from ${data.dealerUrl}`);
    saveEnrichment(c.vin, data);
    return true;
  } else {
    log(`[enrich] ${c.vin}: no extractable data found`);
    saveEnrichment(c.vin, {});
    return false;
  }
}

function getEnrichmentDetails(vin: string): { vin: string; fields: string[]; dealerUrl: string | null } | null {
  const entry = getEnrichmentByVin(vin);
  if (!entry || entry.fields.length === 0) return null;
  return { vin, fields: entry.fields, dealerUrl: entry.dealerUrl };
}

/** Run VIN enrichment: find dealer sites, search for VINs, extract data */
export async function runEnrichment(onProgress?: EnrichProgressCallback): Promise<EnrichResult> {
  const log = (msg: string) => {
    console.log(msg);
    onProgress?.(msg);
  };

  if (!BRAVE_API_KEY) {
    log("[enrich] No Brave Search API key found — skipping enrichment");
    return { candidates: 0, searched: 0, enriched: 0 };
  }

  const candidates = getEnrichmentCandidates();
  const toSearch = candidates.slice(0, MAX_VINS_PER_RUN);
  log(`[enrich] ${candidates.length} candidates, searching ${toSearch.length}`);

  let searched = 0;
  let enriched = 0;
  const details: EnrichResult["details"] = [];
  const dealerDomainCache = new Map<string, string | null>();
  const limit = pLimit(ENRICH_CONCURRENCY);

  const tasks = toSearch.map(c => limit(async () => {
    searched++;
    const found = await enrichSingleVin(c, dealerDomainCache, log);
    if (found) {
      enriched++;
      const saved = getEnrichmentDetails(c.vin);
      if (saved) details.push(saved);
    }
  }));

  await Promise.all(tasks);

  applyEnrichmentCache();
  // Clear "possibly sold" flag for VINs that were successfully enriched
  const enrichedVins = details.map(d => d.vin);
  if (enrichedVins.length > 0) clearPossiblySold(enrichedVins);
  log(`[enrich] Done. Searched ${searched}, enriched ${enriched} of ${candidates.length} candidates`);

  return { candidates: candidates.length, searched, enriched, details };
}

/** Run enrichment for specific VINs (clears cache first to force re-search) */
export async function runEnrichmentForVins(vins: string[], onProgress?: EnrichProgressCallback): Promise<EnrichResult> {
  const log = (msg: string) => {
    console.log(msg);
    onProgress?.(msg);
  };

  if (!BRAVE_API_KEY) {
    log("[enrich] No Brave Search API key found — skipping enrichment");
    return { candidates: 0, searched: 0, enriched: 0 };
  }

  // Clear cache for these VINs so they get re-searched
  clearEnrichmentCache(vins);
  log(`[enrich] Cleared cache for ${vins.length} VINs`);

  const listings = getListingsByVins(vins);
  log(`[enrich] ${listings.length} listings found for ${vins.length} VINs`);

  let searched = 0;
  let enriched = 0;
  const details: EnrichResult["details"] = [];
  const dealerDomainCache = new Map<string, string | null>();
  const limit = pLimit(ENRICH_CONCURRENCY);

  const tasks = listings.map(c => limit(async () => {
    searched++;
    const found = await enrichSingleVin(c, dealerDomainCache, log);
    if (found) {
      enriched++;
      const saved = getEnrichmentDetails(c.vin);
      if (saved) details.push(saved);
    }
  }));

  await Promise.all(tasks);

  applyEnrichmentCache();
  // Clear "possibly sold" flag for VINs that were successfully enriched
  const enrichedVins = details.map(d => d.vin);
  if (enrichedVins.length > 0) clearPossiblySold(enrichedVins);
  log(`[enrich] Done. Searched ${searched}, enriched ${enriched} of ${listings.length} VINs`);

  return { candidates: listings.length, searched, enriched, details };
}
