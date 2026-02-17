import type { RawListing } from "./types.ts";

const SEARCH_URL =
  "https://www.cargurus.com/Cars/searchResults.action";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

interface CarGurusItem {
  id: number;
  vin?: string;
  carYear?: number;
  trimName?: string;
  price?: number;
  mileage?: number;
  exteriorColorName?: string;
  localizedInteriorColor?: string;
  interiorColor?: string;
  serviceProviderName?: string;
  sellerCity?: string;
  sellerRegion?: string;
  originalPictureData?: { url?: string };
  daysOnMarket?: number;
  offset?: number;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeCarGurus(): Promise<RawListing[]> {
  const results: RawListing[] = [];
  const seenVins = new Set<string>();
  let offset = 0;
  const maxResults = 48; // API caps at 48 per page regardless of requested value
  const maxPages = 10;

  console.log("[CarGurus] Starting fetch...");

  for (let pg = 0; pg < maxPages; pg++) {
    const params = new URLSearchParams({
      zip: "10001",
      inventorySearchWidgetType: "AUTO",
      sortDir: "ASC",
      sortType: "PRICE",
      "entitySelectingHelper.selectedEntity": "d2132",
      distance: "50000",
      startYear: "2023",
      endYear: "2026",
      maxMileage: "50000",
      maxResults: String(maxResults),
      offset: String(offset),
      filtersModified: "true",
    });

    const url = `${SEARCH_URL}?${params}`;

    try {
      const res = await fetch(url, { headers: FETCH_HEADERS });

      if (!res.ok) {
        console.error(`[CarGurus] HTTP ${res.status}`);
        break;
      }

      const text = await res.text();
      let items: CarGurusItem[];
      try {
        items = JSON.parse(text);
      } catch {
        console.error("[CarGurus] Invalid JSON response, likely blocked");
        break;
      }

      if (!Array.isArray(items) || items.length === 0) {
        break;
      }

      let pageCount = 0;
      for (const item of items) {
        const vin = item.vin?.toUpperCase();
        if (!vin || vin.length !== 17) continue;
        if (seenVins.has(vin)) continue;
        seenVins.add(vin);

        const interiorColor =
          item.localizedInteriorColor || item.interiorColor || "";

        results.push({
          vin,
          source: "cargurus",
          url: `https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?sourceContext=carGurusHomePageModel&entitySelectingHelper.selectedEntity=d2132&zip=10001#listing=${item.id}/NONE`,
          price: item.price ?? 0,
          mileage: item.mileage ?? 0,
          year: item.carYear ?? 0,
          trim: item.trimName ?? "",
          exteriorColor: item.exteriorColorName ?? "",
          interiorColor,
          seatCount: null,
          dealerName: item.serviceProviderName ?? "",
          dealerLocation:
            item.sellerCity && item.sellerRegion
              ? `${item.sellerCity}, ${item.sellerRegion}`
              : item.sellerCity || "",
          imageUrl: item.originalPictureData?.url ?? null,
          listedDate: null,
        });
        pageCount++;
      }

      console.log(
        `[CarGurus] Page ${pg + 1}: ${pageCount} listings (total: ${results.length})`
      );

      if (items.length < maxResults) break;
      offset += items.length;
    } catch (err) {
      console.error(`[CarGurus] Error:`, err);
      break;
    }

    if (pg < maxPages - 1) {
      await delay(2000 + Math.random() * 1500);
    }
  }

  if (results.length === 0) {
    console.log("[CarGurus] 0 listings found");
  } else {
    console.log(`[CarGurus] Done — ${results.length} listings`);
  }
  return results;
}
