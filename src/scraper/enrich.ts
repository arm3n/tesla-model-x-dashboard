import { getEnrichmentCandidates, saveEnrichment, applyEnrichmentCache, type EnrichmentData } from "../db.ts";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Try common dealer site search URL patterns to find a VIN */
async function searchDealerSite(dealerDomain: string, vin: string): Promise<string | null> {
  // Common DMS search patterns
  const patterns = [
    `${dealerDomain}/search/?q=${vin}`,
    `${dealerDomain}/inventory/?q=${vin}`,
    `${dealerDomain}/vehicles/?search=${vin}`,
  ];

  for (const searchUrl of patterns) {
    const html = await curlFetch(searchUrl);
    if (html && html.includes(vin)) {
      return html;
    }
    await sleep(FETCH_DELAY_MS);
  }

  return null;
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

  const hasData = data.price || data.mileage || data.interiorColor || data.exteriorColor;
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

  // Cache dealer domains to avoid redundant Brave API calls
  const dealerDomainCache = new Map<string, string | null>();

  for (const c of toSearch) {
    const missing: string[] = [];
    if (c.price === 0) missing.push("price");
    if (c.mileage === 0) missing.push("mileage");
    if (!c.interiorColor) missing.push("interiorColor");

    log(`[enrich] ${c.vin} (${c.dealerName}) — missing: ${missing.join(", ")}`);
    searched++;

    // Step 1: Find dealer domain (cached by dealer name)
    const cacheKey = `${c.dealerName}|${c.dealerLocation}`;
    let dealerDomain: string | null;
    if (dealerDomainCache.has(cacheKey)) {
      dealerDomain = dealerDomainCache.get(cacheKey)!;
    } else {
      dealerDomain = await findDealerDomain(c.dealerName, c.dealerLocation);
      dealerDomainCache.set(cacheKey, dealerDomain);
      await sleep(BRAVE_DELAY_MS);
    }

    if (!dealerDomain) {
      log(`[enrich] ${c.vin}: couldn't find dealer website for "${c.dealerName}"`);
      saveEnrichment(c.vin, {});
      continue;
    }

    log(`[enrich] ${c.vin}: dealer site → ${dealerDomain}`);

    // Step 2: Search dealer site for VIN
    const html = await searchDealerSite(dealerDomain, c.vin);
    if (!html) {
      log(`[enrich] ${c.vin}: VIN not found on dealer site`);
      saveEnrichment(c.vin, {});
      continue;
    }

    // Step 3: Parse vehicle data
    const data = parseDealerHtml(html, c.vin, `${dealerDomain}/search/?q=${c.vin}`);
    if (data) {
      const fields = Object.keys(data).filter(k => k !== "dealerUrl" && (data as any)[k]);
      log(`[enrich] ${c.vin}: enriched (${fields.join(", ")}) from ${data.dealerUrl}`);
      saveEnrichment(c.vin, data);
      enriched++;
    } else {
      log(`[enrich] ${c.vin}: page had VIN but no extractable data`);
      saveEnrichment(c.vin, {});
    }
  }

  // Apply all cached enrichment to fill blanks in listings
  applyEnrichmentCache();
  log(`[enrich] Done. Searched ${searched}, enriched ${enriched} of ${candidates.length} candidates`);

  return { candidates: candidates.length, searched, enriched };
}
