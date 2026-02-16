import type { RawListing } from "./types.ts";

const API_BASE = "https://api.auto.dev/listings";
const PAGE_LIMIT = 100;

interface AutoDevListing {
  vin: string;
  vehicle: {
    vin: string;
    year: number;
    make: string;
    model: string;
    trim: string;
    drivetrain?: string;
    engine?: string;
    fuel?: string;
    seats?: number;
    exteriorColor?: string;
    interiorColor?: string;
  };
  retailListing?: {
    vdp?: string;
    price?: number;
    used?: boolean;
    miles?: number;
    dealer?: string;
    city?: string;
    state?: string;
    zip?: string;
    primaryImage?: string;
  };
}

interface AutoDevResponse {
  data: AutoDevListing[];
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dealer backend / feed domains that aren't consumer-accessible */
const NON_CONSUMER_DOMAINS = [
  "vast.com",
  "homenetinc.com",
  "dealercenter.com",
  "vautofeed.com",
  "carstory.com",
  "forddirect.com",
  "autoboing.com",
  "shiftdigital.com",
];

function isConsumerUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !NON_CONSUMER_DOMAINS.some((d) => host.endsWith(d));
  } catch {
    return false;
  }
}

/**
 * Resolve vast.com tracking URLs to their final dealer destination.
 * These URLs require a Referer header from auto.dev to return a 302
 * redirect to the real dealer page; without it they 403.
 */
async function resolveVastUrl(vastUrl: string): Promise<string | null> {
  try {
    // Follow up to 3 redirects manually (http→https→dealer)
    let url = vastUrl;
    for (let hop = 0; hop < 3; hop++) {
      const res = await fetch(url, {
        headers: { Referer: "https://auto.dev/" },
        redirect: "manual",
      });
      const location = res.headers.get("location");
      if (!location) break;
      if (isConsumerUrl(location)) return location;
      url = location;
    }
  } catch { /* resolve failed, skip */ }
  return null;
}

export async function scrapeAutoDev(): Promise<RawListing[]> {
  const apiKey = process.env.AUTO_DEV_API_KEY;
  if (!apiKey) {
    console.error("[Auto.dev] No API key found in AUTO_DEV_API_KEY");
    return [];
  }

  const results: RawListing[] = [];
  let page = 1;
  let hasMore = true;

  console.log("[Auto.dev] Starting fetch...");

  while (hasMore) {
    const params = new URLSearchParams({
      "vehicle.make": "Tesla",
      "vehicle.model": "Model X",
      "vehicle.year": "2023-2026",
      sort: "price.asc",
      limit: String(PAGE_LIMIT),
      page: String(page),
      apiKey,
    });

    const url = `${API_BASE}?${params}`;
    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Auto.dev] API error ${res.status}: ${text}`);
      break;
    }

    const data = (await res.json()) as AutoDevResponse;

    if (!data.data || data.data.length === 0) {
      hasMore = false;
      break;
    }

    // Collect items and their vast.com URLs to resolve in batch
    const pageItems: { item: AutoDevListing; vin: string }[] = [];
    for (const item of data.data) {
      const vin = (item.vin || item.vehicle?.vin || "").toUpperCase();
      if (!vin || vin.length !== 17) continue;
      if (item.retailListing && item.retailListing.used === false) continue;
      pageItems.push({ item, vin });
    }

    // Resolve vast.com redirects in parallel (batches of 10)
    const vastUrls = new Map<string, string>();
    const vastItems = pageItems.filter(
      (p) => p.item.retailListing?.vdp?.includes("vast.com")
    );
    for (let i = 0; i < vastItems.length; i += 10) {
      const batch = vastItems.slice(i, i + 10);
      const resolved = await Promise.all(
        batch.map(async (p) => {
          const real = await resolveVastUrl(p.item.retailListing!.vdp!);
          return { vin: p.vin, url: real };
        })
      );
      for (const r of resolved) {
        if (r.url) vastUrls.set(r.vin, r.url);
      }
    }

    for (const { item, vin } of pageItems) {
      const rl = item.retailListing;
      const v = item.vehicle;

      let listingUrl = rl?.vdp || "";
      if (vastUrls.has(vin)) {
        listingUrl = vastUrls.get(vin)!;
      } else if (!listingUrl || !isConsumerUrl(listingUrl)) {
        listingUrl = `https://www.truecar.com/used-cars-for-sale/listing/${vin}/`;
      }

      results.push({
        vin,
        source: "auto.dev",
        url: listingUrl,
        price: rl?.price ?? 0,
        mileage: rl?.miles ?? 0,
        year: v?.year ?? 0,
        trim: v?.trim ?? "",
        exteriorColor: v?.exteriorColor ?? "",
        interiorColor: v?.interiorColor ?? "",
        seatCount: v?.seats ?? null,
        dealerName: rl?.dealer ?? "",
        dealerLocation:
          rl?.city && rl?.state ? `${rl.city}, ${rl.state}` : "",
        imageUrl: rl?.primaryImage ?? null,
        listedDate: null,
      });
    }

    console.log(
      `[Auto.dev] Page ${page}: ${pageItems.length} items, ${vastUrls.size} URLs resolved (total: ${results.length})`
    );

    if (data.data.length < PAGE_LIMIT) {
      hasMore = false;
    } else {
      page++;
      await delay(1000);
    }
  }

  console.log(`[Auto.dev] Done — ${results.length} listings`);
  return results;
}
