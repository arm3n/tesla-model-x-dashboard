import type { RawListing } from "./types.ts";
import { runScraperInNode } from "./run-in-node.ts";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeCarsCom(): Promise<RawListing[]> {
  if (typeof globalThis.Bun !== "undefined") {
    return runScraperInNode("cars.com");
  }

  const results: RawListing[] = [];
  let browser;

  console.log("[Cars.com] Starting Playwright scrape...");

  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      headless: true,
      timeout: 30_000,
      args: ["--disable-http2"],
    });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });

    const maxPages = 10;

    for (let pg = 1; pg <= maxPages; pg++) {
      const url =
        pg === 1
          ? "https://www.cars.com/shopping/results/?stock_type=used&makes[]=tesla&models[]=tesla-model_x&maximum_distance=all&page_size=100"
          : `https://www.cars.com/shopping/results/?stock_type=used&makes[]=tesla&models[]=tesla-model_x&maximum_distance=all&page_size=100&page=${pg}`;
      const tab = await context.newPage();

      try {
        await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await delay(3000);

        // Accept cookies if present
        try {
          await tab.click('button:has-text("Accept all cookies")', {
            timeout: 2000,
          });
          await delay(500);
        } catch {
          /* no cookie banner */
        }

        // Scroll to load lazy content
        for (let i = 0; i < 8; i++) {
          await tab.evaluate(() => window.scrollBy(0, 800));
          await delay(600);
        }

        // Cars.com 2025 uses <spark-card> web components
        const pageItems = await tab.evaluate(() => {
          const sparkCards = document.querySelectorAll("spark-card");
          const items: any[] = [];

          for (const card of sparkCards) {
            const text = card.innerText ?? "";
            // Skip non-listing cards (e.g. ads without vehicle info)
            if (!text.includes("mi.") && !text.includes("miles")) continue;

            const linkEl = card.querySelector(
              'a[href*="vehicledetail"]'
            ) as HTMLAnchorElement;
            const href = linkEl?.href ?? "";
            if (!href) continue;

            // Parse text content for listing data
            const priceMatch = text.match(/\$([\d,]+)/);
            const mileageMatch = text.match(/([\d,]+)\s*mi/);
            const titleMatch = text.match(
              /Used\s+(\d{4})\s+Tesla\s+Model\s+X\s*(.*?)(?:\n|$)/i
            );

            // Dealer info
            const dealerMatch = text.match(
              /(?:Check Availability|View Details)\n(.+?)(?:\n|$)/
            );
            const locationMatch = text.match(
              /([A-Za-z\s]+,\s*[A-Z]{2})\s*\(/
            );

            const imgEl = card.querySelector("img") as HTMLImageElement;
            const imageUrl =
              imgEl?.src || imgEl?.getAttribute("data-src") || null;

            items.push({
              href,
              price: priceMatch?.[1] ?? "",
              mileage: mileageMatch?.[1] ?? "",
              year: titleMatch?.[1] ?? "",
              trim: titleMatch?.[2]?.trim() ?? "",
              dealer: dealerMatch?.[1]?.trim() ?? "",
              location: locationMatch?.[1]?.trim() ?? "",
              imageUrl,
              fullText: text.substring(0, 400),
            });
          }
          return items;
        });

        if (pageItems.length === 0) {
          console.log(`[Cars.com] No listings on page ${pg}, stopping`);
          await tab.close();
          break;
        }

        for (const item of pageItems) {
          const year = parseInt(item.year, 10) || 0;
          const price =
            parseInt((item.price ?? "").replace(/[^0-9]/g, ""), 10) || 0;
          const mileage =
            parseInt((item.mileage ?? "").replace(/[^0-9]/g, ""), 10) || 0;

          results.push({
            vin: "", // VINs not on search results, need detail page
            source: "cars.com",
            url: item.href,
            price,
            mileage,
            year,
            trim: item.trim ?? "",
            exteriorColor: "",
            interiorColor: "",
            seatCount: null,
            dealerName: item.dealer ?? "",
            dealerLocation: item.location ?? "",
            imageUrl: item.imageUrl,
            listedDate: null,
          });
        }

        console.log(
          `[Cars.com] Page ${pg}: ${pageItems.length} listings (total: ${results.length})`
        );
      } catch (err) {
        console.error(`[Cars.com] Error on page ${pg}:`, err);
        await tab.close();
        break;
      }

      await tab.close();

      if (pg < maxPages) {
        await delay(2500 + Math.random() * 1500);
      }
    }

    // Fetch detail pages to get VINs and colors (most critical step)
    const detailLimit = Math.min(results.length, 80);
    if (detailLimit > 0) {
      console.log(
        `[Cars.com] Fetching ${detailLimit} detail pages for VINs...`
      );
      for (let i = 0; i < detailLimit; i++) {
        const listing = results[i];
        const detailPage = await context.newPage();
        try {
          await detailPage.goto(listing.url, {
            waitUntil: "domcontentloaded",
            timeout: 20_000,
          });
          await delay(1500);

          const details = await detailPage.evaluate(() => {
            const text = document.body.innerText;

            // VIN is usually in the page text
            const vinMatch = text.match(
              /VIN[:\s]*([A-HJ-NPR-Z0-9]{17})/i
            );

            // Look for specs in details section
            const extMatch = text.match(
              /Exterior [Cc]olor[:\s]*([^\n]+)/
            );
            const intMatch = text.match(
              /Interior [Cc]olor[:\s]*([^\n]+)/
            );

            return {
              vin: vinMatch?.[1] ?? "",
              exteriorColor: extMatch?.[1]?.trim() ?? "",
              interiorColor: intMatch?.[1]?.trim() ?? "",
            };
          });

          if (details.vin && details.vin.length === 17) {
            listing.vin = details.vin.toUpperCase();
          }
          if (details.exteriorColor)
            listing.exteriorColor = details.exteriorColor;
          if (details.interiorColor)
            listing.interiorColor = details.interiorColor;
        } catch {
          // detail page failed
        }
        await detailPage.close();
        if (i < detailLimit - 1) await delay(800);
        if (i > 0 && i % 20 === 0) {
          console.log(
            `[Cars.com] Detail progress: ${i}/${detailLimit}`
          );
        }
      }
    }

    // Only keep listings with valid VINs
    const valid = results.filter((r) => r.vin && r.vin.length === 17);

    await browser.close();

    console.log(
      `[Cars.com] Done — ${valid.length} listings with VINs (${results.length} total scraped)`
    );
    return valid;
  } catch (err) {
    console.error("[Cars.com] Playwright error:", err);
    if (browser) await browser.close();
  }

  return results.filter((r) => r.vin && r.vin.length === 17);
}
