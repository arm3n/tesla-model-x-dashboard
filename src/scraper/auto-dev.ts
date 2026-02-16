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

    for (const item of data.data) {
      const vin = (item.vin || item.vehicle?.vin || "").toUpperCase();
      if (!vin || vin.length !== 17) continue;

      // Skip new cars if the API returns them
      if (item.retailListing && item.retailListing.used === false) continue;

      const rl = item.retailListing;
      const v = item.vehicle;

      results.push({
        vin,
        source: "auto.dev",
        url: rl?.vdp || `https://auto.dev/listings/${vin}`,
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
      `[Auto.dev] Page ${page}: ${data.data.length} items (total: ${results.length})`
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
