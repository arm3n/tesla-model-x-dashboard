import type { RawListing } from "./types.ts";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL =
  "https://api.ebay.com/buy/browse/v1/item_summary/search";
const ITEM_URL = "https://api.ebay.com/buy/browse/v1/item";

let cachedToken: { token: string; expiresAt: number } | null = null;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAppToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be set");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay OAuth failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  cachedToken = {
    token: data.access_token,
    // Refresh 5 min early to avoid edge cases
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  };

  return cachedToken.token;
}

interface EbaySearchItem {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  condition?: string;
  image?: { imageUrl: string };
  itemLocation?: { city?: string; stateOrProvince?: string; postalCode?: string };
  seller?: { username?: string; feedbackPercentage?: string };
  itemWebUrl?: string;
  itemCreationDate?: string;
}

interface EbaySearchResponse {
  total: number;
  offset: number;
  limit: number;
  itemSummaries?: EbaySearchItem[];
  next?: string;
  warnings?: { message: string }[];
}

interface EbayAspect {
  name: string;
  value: string;
}

interface EbayItemDetail {
  localizedAspects?: EbayAspect[];
}

function getAspect(aspects: EbayAspect[], ...names: string[]): string {
  for (const name of names) {
    const found = aspects.find(
      (a) => a.name.toLowerCase().includes(name.toLowerCase())
    );
    if (found?.value) return found.value;
  }
  return "";
}

export async function scrapeEbayMotors(): Promise<RawListing[]> {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[eBay] No API credentials found (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET)");
    return [];
  }

  console.log("[eBay] Starting Browse API fetch...");

  let token: string;
  try {
    token = await getAppToken();
  } catch (err) {
    console.error("[eBay] OAuth error:", err);
    return [];
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    Accept: "application/json",
  };

  // Search for used Tesla Model X 2023-2026 in category 6001 (Cars & Trucks)
  const searchItems: EbaySearchItem[] = [];
  let offset = 0;
  const limit = 200;
  const maxPages = 10;

  for (let pg = 0; pg < maxPages; pg++) {
    const params = new URLSearchParams({
      q: "Tesla Model X",
      category_ids: "6001",
      filter: "conditions:{USED},buyingOptions:{FIXED_PRICE|AUCTION}",
      aspect_filter: "categoryId:6001,Year:{2023|2024|2025|2026}",
      sort: "price",
      limit: String(limit),
      offset: String(offset),
    });

    const url = `${SEARCH_URL}?${params}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[eBay] Search API error ${res.status}: ${text}`);
      break;
    }

    const data = (await res.json()) as EbaySearchResponse;

    if (!data.itemSummaries || data.itemSummaries.length === 0) {
      break;
    }

    searchItems.push(...data.itemSummaries);
    console.log(
      `[eBay] Search page ${pg + 1}: ${data.itemSummaries.length} items (total: ${searchItems.length}/${data.total})`
    );

    if (!data.next || searchItems.length >= data.total) break;
    offset += limit;
    await delay(200);
  }

  if (searchItems.length === 0) {
    console.log("[eBay] 0 search results");
    return [];
  }

  // Fetch item details for VIN, colors, mileage (batch with concurrency limit)
  console.log(`[eBay] Fetching details for ${searchItems.length} items...`);
  const results: RawListing[] = [];
  const batchSize = 10;

  for (let i = 0; i < searchItems.length; i += batchSize) {
    const batch = searchItems.slice(i, i + batchSize);

    const details = await Promise.all(
      batch.map(async (item) => {
        try {
          const res = await fetch(`${ITEM_URL}/${item.itemId}`, { headers });
          if (!res.ok) return { item, aspects: [] as EbayAspect[] };
          const detail = (await res.json()) as EbayItemDetail;
          return { item, aspects: detail.localizedAspects ?? [] };
        } catch {
          return { item, aspects: [] as EbayAspect[] };
        }
      })
    );

    for (const { item, aspects } of details) {
      const vin = getAspect(aspects, "VIN").toUpperCase();
      if (!vin || vin.length !== 17) continue;

      const mileageStr = getAspect(aspects, "Mileage");
      const mileage = parseInt(mileageStr.replace(/[^0-9]/g, ""), 10) || 0;

      const year =
        parseInt(getAspect(aspects, "Year"), 10) ||
        parseInt(item.title.match(/\b(20\d{2})\b/)?.[1] ?? "", 10) ||
        0;

      const loc = item.itemLocation;
      const dealerLocation =
        loc?.city && loc?.stateOrProvince
          ? `${loc.city}, ${loc.stateOrProvince}`
          : loc?.city || "";

      results.push({
        vin,
        source: "ebay",
        url: item.itemWebUrl ?? "",
        price: Math.round(parseFloat(item.price?.value ?? "0")) || 0,
        mileage,
        year,
        trim: getAspect(aspects, "Trim"),
        exteriorColor: getAspect(aspects, "Exterior Color"),
        interiorColor: getAspect(aspects, "Interior Color"),
        seatCount: null,
        dealerName: item.seller?.username ?? "",
        dealerLocation,
        imageUrl: item.image?.imageUrl ?? null,
        listedDate: item.itemCreationDate ?? null,
      });
    }

    const progress = Math.min(i + batchSize, searchItems.length);
    if (progress % 50 === 0 || progress === searchItems.length) {
      console.log(
        `[eBay] Details: ${progress}/${searchItems.length} fetched, ${results.length} with VINs`
      );
    }

    if (i + batchSize < searchItems.length) {
      await delay(100);
    }
  }

  console.log(`[eBay] Done — ${results.length} listings with VINs`);
  return results;
}
