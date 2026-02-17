import type { RawListing } from "./types.ts";

const API_BASE = "https://mc-api.marketcheck.com/v2";
const PAGE_SIZE = 100;

interface MarketCheckListing {
  vin: string;
  heading: string;
  price: number;
  miles: number;
  exterior_color: string;
  interior_color: string;
  vdp_url: string;
  dealer: {
    name: string;
    city: string;
    state: string;
  };
  media?: {
    photo_links?: string[];
  };
  first_seen_at_date?: string;
  build?: {
    year: number;
    make: string;
    model: string;
    trim: string;
    std_seating: string;
    body_type: string;
  };
}

interface MarketCheckResponse {
  num_found: number;
  listings: MarketCheckListing[];
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeMarketCheck(): Promise<RawListing[]> {
  const apiKey = process.env.MARKETCHECK_API_KEY;
  if (!apiKey) {
    console.error("[MarketCheck] No API key found in MARKETCHECK_API_KEY");
    return [];
  }

  const results: RawListing[] = [];
  let start = 0;
  let total = Infinity;

  console.log("[MarketCheck] Starting fetch...");

  while (start < total) {
    const params = new URLSearchParams({
      api_key: apiKey,
      make: "Tesla",
      model: "Model X",
      car_type: "used",
      year_range: "2023-2026",
      miles_range: "0-50000",
      rows: String(PAGE_SIZE),
      start: String(start),
    });

    const url = `${API_BASE}/search/car/active?${params}`;
    const res = await fetch(url);

    if (!res.ok) {
      const text = await res.text();
      console.error(`[MarketCheck] API error ${res.status}: ${text}`);
      break;
    }

    const data = (await res.json()) as MarketCheckResponse;
    total = data.num_found;

    for (const item of data.listings) {
      if (!item.vin) continue;

      // std_seating is the factory DEFAULT (usually 5 or 7 for Model X).
      // 6-seat is a configurable option that won't appear in std_seating.
      // Only trust this field if it explicitly says 6; otherwise leave null
      // so the dashboard filter doesn't exclude potentially 6-seat cars.
      let seatCount: number | null = null;
      if (item.build?.std_seating) {
        const parsed = parseInt(item.build.std_seating, 10);
        if (parsed === 6) seatCount = 6;
        // 5 and 7 are factory defaults — not reliable for actual config
      }

      // Year from build object, fallback to parsing heading
      let year = item.build?.year ?? 0;
      if (!year && item.heading) {
        const m = item.heading.match(/^(\d{4})/);
        if (m) year = parseInt(m[1], 10);
      }

      results.push({
        vin: item.vin.toUpperCase(),
        source: "marketcheck",
        url: item.vdp_url || `https://www.marketcheck.com/cars/${item.vin}`,
        price: item.price ?? 0,
        mileage: item.miles ?? 0,
        year,
        trim: item.build?.trim ?? "",
        exteriorColor: item.exterior_color ?? "",
        interiorColor: item.interior_color ?? "",
        seatCount,
        dealerName: item.dealer?.name ?? "",
        dealerLocation: item.dealer
          ? `${item.dealer.city}, ${item.dealer.state}`
          : "",
        imageUrl: item.media?.photo_links?.[0] ?? null,
        listedDate: item.first_seen_at_date ?? null,
      });
    }

    console.log(
      `[MarketCheck] Fetched page ${Math.floor(start / PAGE_SIZE) + 1} (${results.length}/${total} listings)`
    );

    start += PAGE_SIZE;

    if (start < total) {
      await delay(1000);
    }
  }

  console.log(`[MarketCheck] Done — ${results.length} listings`);
  return results;
}
