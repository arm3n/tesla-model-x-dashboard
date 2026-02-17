import * as cheerio from "cheerio";
import type { RawListing } from "./types.ts";
import { runScraperInNode } from "./run-in-node.ts";

const BASE_URL = "https://www.truecar.com/used-cars-for-sale/listings/tesla/model-x/year-2023-max-year-2026/";

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

function extractFromHtml(html: string): RawListing[] {
  const $ = cheerio.load(html);
  const listings: RawListing[] = [];

  // Try JSON-LD structured data first
  // TrueCar nests listings under a parent Vehicle with a `vehicles` array
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const json = JSON.parse($(el).text());
      // Collect all Vehicle objects, including nested vehicles[]
      const candidates: any[] = [];
      const roots = Array.isArray(json) ? json : json["@graph"] ?? [json];
      for (const item of roots) {
        if (item["@type"] === "Vehicle" || item["@type"] === "Car") {
          if (Array.isArray(item.vehicles)) {
            candidates.push(...item.vehicles);
          } else {
            candidates.push(item);
          }
        }
      }

      for (const item of candidates) {
        // TrueCar uses lowercase "vehicleidentificationnumber"
        const vin = (
          item.vehicleIdentificationNumber ??
          item.vehicleidentificationnumber ??
          item.offers?.sku ??
          ""
        ).toUpperCase();
        if (!vin || vin.length !== 17) continue;

        const offerUrl = item.offers?.url ?? "";
        const url = offerUrl.startsWith("http")
          ? offerUrl
          : offerUrl
            ? `https://www.truecar.com${offerUrl}`
            : `https://www.truecar.com/used-cars-for-sale/listing/${vin}/`;

        // Address may be a string ("1717 Auto Park Way, City, ST 12345") or object
        let dealerLocation = "";
        const addr = item.offers?.seller?.address;
        if (typeof addr === "string") {
          const locMatch = addr.match(/,\s*([A-Za-z\s]+),\s*([A-Z]{2})\b/);
          dealerLocation = locMatch ? `${locMatch[1].trim()}, ${locMatch[2]}` : "";
        } else if (addr?.addressLocality) {
          dealerLocation = `${addr.addressLocality}, ${addr.addressRegion ?? ""}`;
        }

        listings.push({
          vin,
          source: "truecar",
          url,
          price: parseFloat(item.offers?.price ?? "0") || 0,
          mileage: parseInt(item.mileageFromOdometer?.value ?? "0", 10) || 0,
          year: parseInt(item.releaseDate ?? item.vehicleModelDate ?? "0", 10) || 0,
          trim: item.trim ?? item.vehicleConfiguration ?? "",
          exteriorColor: item.color ?? "",
          interiorColor: item.vehicleInteriorColor ?? "",
          seatCount: null,
          dealerName: item.offers?.seller?.name ?? "",
          dealerLocation,
          imageUrl: item.image ?? null,
          listedDate: null,
        });
      }
    } catch { /* not valid JSON-LD */ }
  });

  // Fallback: parse listing cards from DOM
  if (listings.length === 0) {
    $('[data-test="usedListing"], [data-test="vehicleCard"], .listing-card, [data-qa="used-listing"]').each((_i, el) => {
      const card = $(el);

      // Extract VIN from listing URL (TrueCar embeds VIN in /listing/{VIN}/ path)
      let vin = (card.attr("data-vin") ?? "").toUpperCase();
      if (!vin || vin.length !== 17) {
        vin = card.find('[data-test="vin"], [data-qa="vin"]').text().trim().toUpperCase();
      }
      const listingLink = card.find('a[href*="/listing/"]').first();
      const href = listingLink.attr("href") ?? card.find("a").first().attr("href") ?? "";
      if ((!vin || vin.length !== 17) && href) {
        const vinMatch = href.match(/\/listing\/([A-HJ-NPR-Z0-9]{17})\//i);
        if (vinMatch) vin = vinMatch[1]!.toUpperCase();
      }
      if (!vin || vin.length !== 17) return;

      const cardUrl = href.startsWith("http") ? href : `https://www.truecar.com${href}`;

      const priceText = card.find('[data-test="vehicleCardPricingPrice"], [data-test="vehicleCardPricingBlockPrice"], [data-qa="price"]').text();
      const price = parseInt(priceText.replace(/[^0-9]/g, ""), 10) || 0;

      const cardText = card.text();
      const mileageMatch = cardText.match(/([\d,]+)\s*mi(?:\s|·)/);
      const mileage = parseInt((mileageMatch?.[1] ?? "").replace(/,/g, ""), 10) || 0;

      const title = card.find('[data-test="vehicleCardInfo"], [data-test="vehicleCardTrim"], h2, h3').text().trim();
      const yearMatch = title.match(/(\d{4})/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : 0;
      // Trim is between the title and mileage info (e.g. "75D", "Long Range Plus")
      const trimMatch = cardText.match(/Model\s*X\s*\n?\s*([^\n·]+?)(?:Used|New|\d[\d,]*\s*mi)/i);
      const trim = trimMatch?.[1]?.trim() ?? "";

      const extColor = card.find('[data-test="vehicleCardColor"], [data-qa="exteriorColor"]').text().trim();
      // Dealer and location are in format "DealerName - City, ST"
      const dealerMatch = cardText.match(/([A-Z][A-Za-z\s&'.]+(?:Motors|Auto|Cars|Group|Inc|LLC|Dealership|Motorsport|Gallery)[A-Za-z\s&'.]*)\s*[-–]\s*([A-Za-z\s]+,\s*[A-Z]{2})/i)
        ?? cardText.match(/([A-Z][^\n]{3,40})\s*[-–]\s*([A-Za-z\s]+,\s*[A-Z]{2})/i);
      const dealer = dealerMatch?.[1]?.trim() ?? "";
      const location = dealerMatch?.[2]?.trim() ?? "";

      const imgEl = card.find("img").first();
      const imageUrl = imgEl.attr("src") || imgEl.attr("data-src") || null;

      listings.push({
        vin,
        source: "truecar",
        url: cardUrl,
        price,
        mileage,
        year,
        trim,
        exteriorColor: extColor,
        interiorColor: "",
        seatCount: null,
        dealerName: dealer,
        dealerLocation: location,
        imageUrl,
        listedDate: null,
      });
    });
  }

  return listings;
}

export async function scrapeTrueCar(): Promise<RawListing[]> {
  // Bun's TLS fingerprint gets blocked by TrueCar — delegate to Node.js
  if (typeof globalThis.Bun !== "undefined") {
    return runScraperInNode("truecar");
  }

  const results: RawListing[] = [];
  const seenVins = new Set<string>();
  const maxPages = 20;

  for (let pg = 1; pg <= maxPages; pg++) {
    const url = pg === 1 ? BASE_URL : `${BASE_URL}?page=${pg}`;

    try {
      const res = await fetch(url, { headers: FETCH_HEADERS });
      if (!res.ok) {
        console.log(`[TrueCar] Page ${pg} returned ${res.status}, stopping`);
        break;
      }

      const html = await res.text();
      const pageListings = extractFromHtml(html);

      if (pageListings.length === 0) {
        console.log(`[TrueCar] No listings on page ${pg}, stopping`);
        break;
      }

      // Deduplicate: stop if page returns only already-seen VINs
      let newCount = 0;
      for (const listing of pageListings) {
        if (!seenVins.has(listing.vin)) {
          seenVins.add(listing.vin);
          results.push(listing);
          newCount++;
        }
      }

      console.log(`[TrueCar] Page ${pg}: ${newCount} new / ${pageListings.length} total (${results.length} collected)`);

      if (newCount === 0) {
        console.log(`[TrueCar] No new listings on page ${pg}, stopping`);
        break;
      }
    } catch (err) {
      console.error(`[TrueCar] Error on page ${pg}:`, err);
      break;
    }

    if (pg < maxPages) {
      await delay(2000 + Math.random() * 1500);
    }
  }

  if (results.length === 0) {
    console.log("[TrueCar] 0 listings found");
  } else {
    console.log(`[TrueCar] Done — ${results.length} listings`);
  }
  return results;
}
