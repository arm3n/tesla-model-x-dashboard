import type { RawListing } from "./types.ts";

const API_URL = "https://www.autotrader.com/rest/lsc/listing";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AutotraderListing {
  vin?: string;
  listPrice?: number;
  mileage?: number;
  year?: number;
  trim?: string;
  exteriorColorSimple?: string;
  interiorColorSimple?: string;
  ownerCount?: number;
  accidentCount?: number;
  titleType?: string;
  dealer?: {
    dealerName?: string;
    city?: string;
    state?: string;
  };
  images?: { uri?: string }[];
  listingUrl?: string;
  firstDateSeen?: string;
}

/**
 * Autotrader caps API results at 400 per query. To get more coverage,
 * we run multiple searches with different sort orders so each returns
 * a different slice of the inventory, then deduplicate by VIN.
 */
const SORT_STRATEGIES = [
  "derivedpriceDESC",  // expensive first
  "derivedpriceASC",   // cheap first
  "mileageASC",        // low mileage first
  "mileageDESC",       // high mileage first
  "yearDESC",          // newest first
  "yearASC",           // oldest first
  "distanceASC",       // closest first (varies by zip)
  "bestMatchDESC",     // relevance/default
];

export async function scrapeAutotrader(): Promise<RawListing[]> {
  const seenVins = new Set<string>();
  const allResults: RawListing[] = [];

  console.log("[Autotrader] Starting API fetch...");

  for (const sortBy of SORT_STRATEGIES) {
    const stratResults = await fetchAutotraderPage(sortBy, seenVins);
    allResults.push(...stratResults);
    if (SORT_STRATEGIES.indexOf(sortBy) < SORT_STRATEGIES.length - 1) {
      await delay(5000 + Math.random() * 3000); // pause between strategies
    }
  }

  console.log(`[Autotrader] Done — ${allResults.length} listings`);
  return allResults;
}

async function fetchAutotraderPage(
  sortBy: string,
  seenVins: Set<string>
): Promise<RawListing[]> {
  const results: RawListing[] = [];
  let firstRecord = 0;
  const pageSize = 100;
  let totalCount = Infinity;

  console.log(`[Autotrader] Strategy: ${sortBy}`);

  while (firstRecord < totalCount) {
    const params = new URLSearchParams({
      makeCode: "TESLA",
      modelCode: "TESMODX",
      listingType: "USED",
      startYear: "2023",
      endYear: "2026",
      searchRadius: "0",
      zip: "10001",
      numRecords: String(pageSize),
      firstRecord: String(firstRecord),
      sortBy,
      channel: "ATC",
    });

    let res: Response;
    try {
      res = await fetch(`${API_URL}?${params}`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.autotrader.com/cars-for-sale/used-cars/tesla/model-x",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      console.error(`[Autotrader] Fetch error:`, err);
      break;
    }

    if (res.status === 403 || res.status === 429) {
      console.log("[Autotrader] Blocked (403/429), trying Playwright fallback...");
      const pwResults = await scrapeAutotraderPlaywright();
      results.push(...pwResults);
      break;
    }

    if (!res.ok) {
      console.error(`[Autotrader] HTTP ${res.status}`);
      // Try Playwright fallback
      const pwResults = await scrapeAutotraderPlaywright();
      results.push(...pwResults);
      break;
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      // Autotrader sometimes returns HTML instead of JSON (soft rate-limit)
      console.log(`[Autotrader] Non-JSON response at offset ${firstRecord}, retrying after delay...`);
      await delay(8000 + Math.random() * 4000);
      try {
        const retry = await fetch(`${API_URL}?${params}`, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Accept: "application/json",
            "Accept-Language": "en-US,en;q=0.9",
            Referer: "https://www.autotrader.com/cars-for-sale/used-cars/tesla/model-x",
          },
          signal: AbortSignal.timeout(30_000),
        });
        data = await retry.json();
      } catch {
        console.log(`[Autotrader] Retry also failed, stopping at ${results.length} listings`);
        break;
      }
    }
    totalCount = data.totalResultCount ?? 0;
    const listings: AutotraderListing[] = data.listings ?? [];

    if (listings.length === 0) {
      console.log(`[Autotrader] Empty listings at offset ${firstRecord}, totalResultCount=${totalCount}`);
      break;
    }

    // Autotrader API uses complex objects: {name}, {value}, {label}, etc.
    const safeNum = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "string") return parseInt(v.replace(/[^0-9]/g, ""), 10) || 0;
      if (v && typeof v === "object" && "value" in v) return safeNum((v as any).value);
      return 0;
    };

    let newOnPage = 0;
    for (const item of listings) {
      const raw = item as any;
      const vin = (typeof raw.vin === "string" ? raw.vin : "").toUpperCase();
      if (!vin || vin.length !== 17) continue;
      if (seenVins.has(vin)) continue;
      seenVins.add(vin);
      newOnPage++;

      // Trim: raw.atTrim (string) or raw.trim.name (object)
      const trim = raw.atTrim ?? raw.trim?.name ?? raw.trimName ?? "";

      // Price: pricingDetail.incentive or pricingDetail.salePrice or pricingDetail.primary
      const pd = raw.pricingDetail ?? {};
      const price = safeNum(pd.salePrice ?? pd.incentive ?? pd.primary ?? raw.listPrice ?? raw.price);

      // Color: raw.color.exteriorColor / raw.color.interiorColor
      const colorObj = raw.color ?? {};
      const exteriorColor = colorObj.exteriorColor ?? colorObj.exteriorColorSimple ?? "";
      const interiorColor = colorObj.interiorColor ?? colorObj.interiorColorSimple ?? "";

      // Mileage: { label, value } object
      const mileage = safeNum(raw.mileage);

      // Dealer: under "owner" with location.address sub-object
      const owner = raw.owner ?? raw.dealer ?? {};
      const dealerName = owner.name ?? owner.dealerName ?? "";
      const addr = owner.location?.address ?? {};
      const ownerCity = addr.city ?? "";
      const ownerState = addr.state ?? "";
      const dealerLocation = ownerCity && ownerState
        ? `${ownerCity}, ${ownerState}`
        : ownerCity || ownerState;

      // Images: { primary, sources: [{ src }] }
      let imageUrl: string | null = null;
      const imgs = raw.images;
      if (imgs?.sources && Array.isArray(imgs.sources) && imgs.sources.length > 0) {
        imageUrl = imgs.sources[0]?.src ?? null;
      }

      // Vehicle history: vhrPreview = ["NO_SALVAGE_TITLE", "NO_ACCIDENTS_REPORTED", "ONE_OWNER"]
      const vhr: string[] = Array.isArray(raw.vhrPreview) ? raw.vhrPreview : [];
      let titleStatus: string | null = null;
      let accidentHistory: "clean" | "accident" | "unknown" = "unknown";

      if (vhr.includes("NO_SALVAGE_TITLE")) titleStatus = "clean";
      else if (vhr.some(v => /salvage/i.test(v))) titleStatus = "salvage";

      if (vhr.includes("NO_ACCIDENTS_REPORTED")) accidentHistory = "clean";
      else if (vhr.some(v => /accident/i.test(v) && !/no.?accident/i.test(v))) accidentHistory = "accident";

      // URL: construct from id or vin
      const url = raw.id
        ? `https://www.autotrader.com/cars-for-sale/vehicledetails.xhtml?listingId=${raw.id}`
        : `https://www.autotrader.com/cars-for-sale/vehicledetails.xhtml?vin=${vin}`;

      results.push({
        vin,
        source: "autotrader",
        url,
        price,
        mileage,
        year: typeof raw.year === "number" ? raw.year : 0,
        trim,
        exteriorColor,
        interiorColor,
        seatCount: null,
        dealerName,
        dealerLocation,
        imageUrl,
        listedDate: null,
        titleStatus,
        accidentHistory,
      });
    }

    console.log(
      `[Autotrader] Fetched ${firstRecord}-${firstRecord + listings.length} (+${newOnPage} new, ${results.length} total, sort=${sortBy})`
    );

    firstRecord += listings.length;

    // Skip remaining pages if this page found no new VINs
    if (newOnPage === 0) {
      console.log(`[Autotrader] No new VINs on this page, skipping rest of ${sortBy}`);
      break;
    }

    if (firstRecord < totalCount) {
      await delay(4000 + Math.random() * 3000);
    }
  }

  console.log(`[Autotrader] Strategy ${sortBy}: ${results.length} new listings`);
  return results;
}

async function scrapeAutotraderPlaywright(): Promise<RawListing[]> {
  const results: RawListing[] = [];

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, timeout: 30_000 });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Intercept API responses
    const intercepted: AutotraderListing[] = [];
    page.on("response", async (response) => {
      if (response.url().includes("/rest/lsc/listing") || response.url().includes("/rest/searchresults")) {
        try {
          const json = await response.json();
          if (json.listings) intercepted.push(...json.listings);
        } catch { /* not JSON */ }
      }
    });

    await page.goto(
      "https://www.autotrader.com/cars-for-sale/used-cars/tesla/model-x?startYear=2023&endYear=2026&searchRadius=0&zip=10001&numRecords=100",
      { waitUntil: "networkidle", timeout: 30_000 }
    );

    await delay(3000);

    for (const item of intercepted) {
      const vin = (item.vin ?? "").toUpperCase();
      if (!vin || vin.length !== 17) continue;

      results.push({
        vin,
        source: "autotrader",
        url: `https://www.autotrader.com/cars-for-sale/vehicledetails.xhtml?vin=${vin}`,
        price: item.listPrice ?? 0,
        mileage: item.mileage ?? 0,
        year: item.year ?? 0,
        trim: item.trim ?? "",
        exteriorColor: item.exteriorColorSimple ?? "",
        interiorColor: item.interiorColorSimple ?? "",
        seatCount: null,
        dealerName: item.dealer?.dealerName ?? "",
        dealerLocation: item.dealer
          ? `${item.dealer.city ?? ""}, ${item.dealer.state ?? ""}`
          : "",
        imageUrl: item.images?.[0]?.uri ?? null,
        listedDate: null,
        titleStatus: item.titleType ?? null,
        accidentHistory:
          item.accidentCount !== undefined
            ? item.accidentCount > 0 ? "accident" : "clean"
            : "unknown",
      });
    }

    await browser.close();
  } catch (err) {
    console.error("[Autotrader/Playwright] Error:", err);
  }

  return results;
}
