import * as cheerio from "cheerio";
import type { RawListing } from "./types.ts";
import { runScraperInNode } from "./run-in-node.ts";

const BASE_URL = "https://www.truecar.com/used-cars-for-sale/listings/tesla/model-x/";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFromHtml(html: string): RawListing[] {
  const $ = cheerio.load(html);
  const listings: RawListing[] = [];

  // Try JSON-LD structured data first
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const json = JSON.parse($(el).text());
      const items = Array.isArray(json) ? json : json["@graph"] ?? [json];
      for (const item of items) {
        if (item["@type"] !== "Car" && item["@type"] !== "Vehicle") continue;
        const vin = (item.vehicleIdentificationNumber ?? "").toUpperCase();
        if (!vin || vin.length !== 17) continue;

        listings.push({
          vin,
          source: "truecar",
          url: item.url
            ? (item.url.startsWith("http") ? item.url : `https://www.truecar.com${item.url}`)
            : `https://www.truecar.com/used-cars-for-sale/listing/${vin}/`,
          price: parseFloat(item.offers?.price ?? "0") || 0,
          mileage: parseInt(item.mileageFromOdometer?.value ?? "0", 10) || 0,
          year: parseInt(item.vehicleModelDate ?? "0", 10) || 0,
          trim: item.vehicleConfiguration ?? item.model ?? "",
          exteriorColor: item.color ?? "",
          interiorColor: item.vehicleInteriorColor ?? "",
          seatCount: null,
          dealerName: item.offers?.seller?.name ?? "",
          dealerLocation: item.offers?.seller?.address?.addressLocality
            ? `${item.offers.seller.address.addressLocality}, ${item.offers.seller.address.addressRegion ?? ""}`
            : "",
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
      const vin = (
        card.attr("data-vin") ??
        card.find('[data-test="vin"], [data-qa="vin"]').text().trim()
      ).toUpperCase();
      if (!vin || vin.length !== 17) return;

      const linkEl = card.find("a").first();
      const href = linkEl.attr("href") ?? "";
      const cardUrl = href.startsWith("http") ? href : `https://www.truecar.com${href}`;

      const priceText = card.find('[data-test="vehicleCardPricingBlockPrice"], .vehicle-card-price, [data-qa="price"]').text();
      const price = parseInt(priceText.replace(/[^0-9]/g, ""), 10) || 0;

      const mileageText = card.find('[data-test="vehicleCardMileage"], .mileage, [data-qa="mileage"]').text();
      const mileage = parseInt(mileageText.replace(/[^0-9]/g, ""), 10) || 0;

      const title = card.find('[data-test="vehicleCardTrim"], .vehicle-title, h2, h3').text().trim();
      const yearMatch = title.match(/^(\d{4})/);
      const year = yearMatch ? parseInt(yearMatch[1], 10) : 0;
      const trimMatch = title.match(/Model X\s+(.+)/i);
      const trim = trimMatch?.[1]?.trim() ?? "";

      const extColor = card.find('[data-test="vehicleCardColor"], [data-qa="exteriorColor"]').text().trim();
      const dealer = card.find('[data-test="vehicleCardDealerName"], .dealer-name').text().trim();
      const location = card.find('[data-test="vehicleCardDealerLocation"], .dealer-location').text().trim();

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
  if (typeof globalThis.Bun !== "undefined") {
    return runScraperInNode("truecar");
  }

  const results: RawListing[] = [];

  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, timeout: 30_000 });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });

    const maxPages = 20;

    for (let pg = 1; pg <= maxPages; pg++) {
      const url = pg === 1 ? BASE_URL : `${BASE_URL}?page=${pg}`;
      const tab = await context.newPage();

      try {
        await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await delay(3000);

        // Scroll to load lazy content
        for (let i = 0; i < 5; i++) {
          await tab.evaluate(() => window.scrollBy(0, 800));
          await delay(800);
        }

        const html = await tab.content();
        const pageListings = extractFromHtml(html);

        if (pageListings.length === 0) {
          console.log(`[TrueCar] No listings on page ${pg}, stopping`);
          await tab.close();
          break;
        }

        results.push(...pageListings);
        console.log(`[TrueCar] Page ${pg}: ${pageListings.length} listings (total: ${results.length})`);
      } catch (err) {
        console.error(`[TrueCar] Error on page ${pg}:`, err);
        await tab.close();
        break;
      }

      await tab.close();

      if (pg < maxPages) {
        await delay(3000 + Math.random() * 2000);
      }
    }

    await browser.close();
  } catch (err) {
    console.error("[TrueCar] Playwright error:", err);
    if (browser) await browser.close();
  }

  if (results.length === 0) {
    console.log("[TrueCar] 0 listings — likely blocked by CAPTCHA (Press & Hold)");
  } else {
    console.log(`[TrueCar] Done — ${results.length} listings`);
  }
  return results;
}
