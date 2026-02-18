import * as cheerio from "cheerio";
import type { RawListing } from "./types.ts";
import { runScraperInNode } from "./run-in-node.ts";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Ch-Ua": '"Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSearchPage(html: string): { url: string; price: number; mileage: number; year: number; trim: string; dealer: string; location: string; imageUrl: string | null }[] {
  const $ = cheerio.load(html);
  const items: ReturnType<typeof parseSearchPage> = [];

  // Find all vehicle detail links
  $('a[href*="vehicledetail"]').each((_i, el) => {
    const $a = $(el);
    const href = $a.attr("href") ?? "";
    if (!href.includes("vehicledetail")) return;

    const fullUrl = href.startsWith("http") ? href : `https://www.cars.com${href}`;

    // Get the closest card container
    const card = $a.closest("div, spark-card, section").first();
    const cardText = card.length ? card.text() : "";

    const priceMatch = cardText.match(/\$([\d,]+)/);
    const mileageMatch = cardText.match(/([\d,]+)\s*mi/);
    const yearMatch = cardText.match(/(\d{4})\s+Tesla\s+Model\s+X/i);
    const trimMatch = cardText.match(/Model\s+X\s+(.*?)(?:\n|$)/i);

    const imgEl = card.find("img").first();
    const imageUrl = imgEl.attr("src") || imgEl.attr("data-src") || null;

    items.push({
      url: fullUrl,
      price: parseInt((priceMatch?.[1] ?? "").replace(/,/g, ""), 10) || 0,
      mileage: parseInt((mileageMatch?.[1] ?? "").replace(/,/g, ""), 10) || 0,
      year: parseInt(yearMatch?.[1] ?? "0", 10) || 0,
      trim: trimMatch?.[1]?.trim() ?? "",
      dealer: "",
      location: "",
      imageUrl,
    });
  });

  // Deduplicate by URL
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function parseDetailPage(html: string): {
  vin: string; exteriorColor: string; interiorColor: string;
  price: number; mileage: number; dealer: string; location: string;
} {
  const $ = cheerio.load(html);
  const text = $.text();

  const vinMatch = text.match(/VIN[:\s]*([A-HJ-NPR-Z0-9]{17})/i);
  const extMatch = text.match(/Exterior\s*[Cc]olor[:\s]*([^\n]+)/);
  const intMatch = text.match(/Interior\s*[Cc]olor[:\s]*([^\n]+)/);
  const priceMatch = text.match(/\$([\d,]+)/);
  const mileageMatch = text.match(/([\d,]+)\s*mi/);
  // Extract dealer from structured elements, not raw text (avoids CSS garbage)
  const dealerEl = $('[class*="dealer-name"], [data-qa="dealer-name"], .seller-name').first();
  const dealer = dealerEl.length ? dealerEl.text().trim() : "";
  const locationMatch = text.match(/([A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5})/);

  return {
    vin: vinMatch?.[1]?.toUpperCase() ?? "",
    exteriorColor: extMatch?.[1]?.trim() ?? "",
    interiorColor: intMatch?.[1]?.trim() ?? "",
    price: parseInt((priceMatch?.[1] ?? "").replace(/,/g, ""), 10) || 0,
    mileage: parseInt((mileageMatch?.[1] ?? "").replace(/,/g, ""), 10) || 0,
    dealer,
    location: locationMatch?.[1]?.trim() ?? "",
  };
}

export async function scrapeCarsCom(): Promise<RawListing[]> {
  // Bun's TLS fingerprint gets blocked — delegate to Node.js
  if (typeof globalThis.Bun !== "undefined") {
    return runScraperInNode("cars.com");
  }

  const results: RawListing[] = [];
  const maxPages = 10;

  console.log("[Cars.com] Starting fetch-based scrape...");

  // Phase 1: Fetch search result pages
  for (let pg = 1; pg <= maxPages; pg++) {
    const url =
      pg === 1
        ? "https://www.cars.com/shopping/results/?stock_type=used&makes[]=tesla&models[]=tesla-model_x&maximum_distance=all&page_size=100&year_min=2023&year_max=2026&mileage_max=50000"
        : `https://www.cars.com/shopping/results/?stock_type=used&makes[]=tesla&models[]=tesla-model_x&maximum_distance=all&page_size=100&year_min=2023&year_max=2026&mileage_max=50000&page=${pg}`;

    let pageItems: ReturnType<typeof parseSearchPage> = [];
    let pageOk = false;

    // Retry search page up to 2 times (critical for page 1)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { headers: FETCH_HEADERS });
        if (!res.ok) {
          if (attempt === 0 && pg === 1) {
            console.log(`[Cars.com] Page 1 returned ${res.status}, retrying in 10s...`);
            await delay(10000 + Math.random() * 5000);
            continue;
          }
          console.log(`[Cars.com] Page ${pg} returned ${res.status}, stopping`);
          break;
        }

        const html = await res.text();
        pageItems = parseSearchPage(html);
        pageOk = true;
        break;
      } catch (err) {
        if (attempt === 0) {
          console.log(`[Cars.com] Page ${pg} fetch error, retrying in 10s... (${String(err).slice(0, 60)})`);
          await delay(10000 + Math.random() * 5000);
        } else {
          console.error(`[Cars.com] Page ${pg} failed after retry:`, String(err).slice(0, 100));
        }
      }
    }

    if (!pageOk) break;

    if (pageItems.length === 0) {
      console.log(`[Cars.com] No listings on page ${pg}, stopping`);
      break;
    }

    for (const item of pageItems) {
      results.push({
        vin: "",
        source: "cars.com",
        url: item.url,
        price: item.price,
        mileage: item.mileage,
        year: item.year,
        trim: item.trim,
        exteriorColor: "",
        interiorColor: "",
        seatCount: null,
        dealerName: item.dealer,
        dealerLocation: item.location,
        imageUrl: item.imageUrl,
        listedDate: null,
      });
    }

    console.log(`[Cars.com] Page ${pg}: ${pageItems.length} listings (total: ${results.length})`);

    if (pg < maxPages) {
      await delay(3000 + Math.random() * 2000);
    }
  }

  // Phase 2: Fetch detail pages for VINs and colors
  const detailLimit = Math.min(results.length, 80);
  let detailOk = 0;
  let detailFail = 0;
  let consecutive403 = 0;
  if (detailLimit > 0) {
    console.log(`[Cars.com] Fetching ${detailLimit} detail pages for VINs...`);
    for (let i = 0; i < detailLimit; i++) {
      const listing = results[i]!;

      // Try up to 2 attempts per detail page
      let got403 = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(listing.url, { headers: FETCH_HEADERS });
          if (res.ok) {
            const html = await res.text();
            const details = parseDetailPage(html);
            if (details.vin && details.vin.length === 17) {
              listing.vin = details.vin;
            }
            if (details.exteriorColor) listing.exteriorColor = details.exteriorColor;
            if (details.interiorColor) listing.interiorColor = details.interiorColor;
            if (details.price && !listing.price) listing.price = details.price;
            if (details.mileage && !listing.mileage) listing.mileage = details.mileage;
            if (details.dealer && !listing.dealerName) listing.dealerName = details.dealer;
            if (details.location && !listing.dealerLocation) listing.dealerLocation = details.location;
            detailOk++;
            consecutive403 = 0;
            break;
          } else if (res.status === 403) {
            got403 = true;
            if (attempt === 0) {
              await delay(5000 + Math.random() * 3000);
            } else {
              detailFail++;
            }
          } else if (attempt === 0) {
            console.log(`[Cars.com] Detail ${i + 1}/${detailLimit} returned ${res.status}, retrying...`);
            await delay(5000 + Math.random() * 3000);
          } else {
            console.log(`[Cars.com] Detail ${i + 1}/${detailLimit} returned ${res.status} on retry, skipping`);
            detailFail++;
          }
        } catch (err) {
          if (attempt === 0) {
            await delay(5000 + Math.random() * 3000);
          } else {
            console.log(`[Cars.com] Detail ${i + 1}/${detailLimit} error: ${String(err).slice(0, 80)}`);
            detailFail++;
          }
        }
      }

      if (got403) {
        consecutive403++;
        if (consecutive403 >= 3) {
          console.log(`[Cars.com] 3 consecutive 403s on detail pages — rate limited, bailing`);
          break;
        }
      }

      if (i < detailLimit - 1) await delay(1500 + Math.random() * 1500);
      if (i > 0 && i % 20 === 0) {
        console.log(`[Cars.com] Detail progress: ${i}/${detailLimit} (ok=${detailOk}, fail=${detailFail})`);
      }
    }
    console.log(`[Cars.com] Detail pages: ${detailOk} ok, ${detailFail} failed out of ${detailLimit}`);
  }

  const valid = results.filter((r) => r.vin && r.vin.length === 17);

  if (valid.length === 0) {
    console.log(`[Cars.com] 0 listings with valid VINs (${results.length} total scraped)`);
  } else {
    console.log(`[Cars.com] Done — ${valid.length} listings with VINs (${results.length} total scraped)`);
  }
  return valid;
}
