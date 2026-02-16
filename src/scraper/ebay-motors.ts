import type { RawListing } from "./types.ts";
import { runScraperInNode } from "./run-in-node.ts";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeEbayMotors(): Promise<RawListing[]> {
  if (typeof globalThis.Bun !== "undefined") {
    return runScraperInNode("ebay");
  }

  const results: RawListing[] = [];

  console.log("[eBay] Starting Playwright scrape...");

  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true, timeout: 30_000 });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });

    const maxPages = 5;

    for (let pg = 1; pg <= maxPages; pg++) {
      const searchUrl =
        pg === 1
          ? "https://www.ebay.com/sch/Cars-Trucks/6001/i.html?_nkw=Tesla+Model+X&LH_ItemCondition=3000&_sop=15&_ipg=120&rt=nc"
          : `https://www.ebay.com/sch/Cars-Trucks/6001/i.html?_nkw=Tesla+Model+X&LH_ItemCondition=3000&_sop=15&_ipg=120&rt=nc&_pgn=${pg}`;

      const tab = await context.newPage();

      try {
        await tab.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await delay(3000);

        // Scroll to load lazy images
        for (let i = 0; i < 8; i++) {
          await tab.evaluate(() => window.scrollBy(0, 800));
          await delay(800);
        }

        // eBay 2025+ uses li.s-card with s-card__title, innerText has structured data
        const pageItems = await tab.evaluate(() => {
          const cards = document.querySelectorAll("li.s-card");
          const items: any[] = [];

          for (const card of cards) {
            const allText = card.innerText ?? "";

            // Skip promoted/ad cards ("Shop on eBay")
            if (allText.includes("Shop on eBay")) continue;
            if (!allText.toLowerCase().includes("model x")) continue;

            const linkEl = card.querySelector(
              "a.s-card__link"
            ) as HTMLAnchorElement;
            const href = linkEl?.href ?? "";
            if (!href || !href.includes("/itm/")) continue;

            const titleEl = card.querySelector(".s-card__title");
            const title = titleEl?.textContent?.trim() ?? "";

            // Extract structured data from card text
            const priceMatch = allText.match(
              /\$([\d,]+(?:\.\d{2})?)/
            );
            const yearMatch = allText.match(/Year:\s*(\d{4})/);
            const milesMatch = allText.match(
              /Miles:\s*([\d,]+)/
            );
            const mileageFromTitle = title.match(
              /([\d,]+)\s*mi/i
            );

            const imgEl = card.querySelector("img") as HTMLImageElement;
            const imageUrl =
              imgEl?.src || imgEl?.getAttribute("data-src") || null;

            // Location from text
            const locationMatch = allText.match(
              /Located in\s+(.+?)(?:\n|$)/
            );

            // Seller info from subtitle
            const subtitleEl = card.querySelector(".s-card__subtitle");
            const subtitle = subtitleEl?.textContent?.trim() ?? "";

            items.push({
              title: title.replace(/Opens in a new window or tab/g, "").replace(/New Listing/gi, "").trim(),
              href,
              price: priceMatch?.[1] ?? "",
              year: yearMatch?.[1] ?? "",
              mileage: milesMatch?.[1] ?? mileageFromTitle?.[1] ?? "",
              subtitle,
              imageUrl,
              location: locationMatch?.[1]?.trim() ?? "",
              allText: allText.substring(0, 500),
            });
          }
          return items;
        });

        if (pageItems.length === 0) {
          console.log(`[eBay] No listings on page ${pg}, stopping`);
          await tab.close();
          break;
        }

        for (const item of pageItems) {
          const title = item.title ?? "";
          const yearFromField = parseInt(item.year, 10) || 0;
          const yearFromTitle = title.match(/\b(20\d{2})\b/);
          const year =
            yearFromField || (yearFromTitle ? parseInt(yearFromTitle[1], 10) : 0);

          const trimMatch = title.match(
            /model x\s+(.+?)(?:\s+\d|$|\s+[-–]|\s+with)/i
          );
          const trim = trimMatch?.[1]?.trim() ?? "";

          const price =
            parseInt((item.price ?? "").replace(/[^0-9]/g, ""), 10) || 0;
          const mileage =
            parseInt((item.mileage ?? "").replace(/[^0-9]/g, ""), 10) || 0;

          // Try to find VIN in the text (17 chars, no I/O/Q)
          const vinMatch = item.allText.match(
            /\b([A-HJ-NPR-Z0-9]{17})\b/
          );

          results.push({
            vin: vinMatch?.[1]?.toUpperCase() ?? "",
            source: "ebay",
            url: item.href,
            price,
            mileage,
            year,
            trim,
            exteriorColor: "",
            interiorColor: "",
            seatCount: null,
            dealerName: item.subtitle ?? "",
            dealerLocation: item.location ?? "",
            imageUrl: item.imageUrl,
            listedDate: null,
          });
        }

        console.log(
          `[eBay] Page ${pg}: ${pageItems.length} items (total collected: ${results.length})`
        );
      } catch (err) {
        console.error(`[eBay] Error on page ${pg}:`, err);
        await tab.close();
        break;
      }

      await tab.close();

      if (pg < maxPages) {
        await delay(2000 + Math.random() * 2000);
      }
    }

    // Fetch detail pages for items to get VIN + colors
    // VINs are rarely in search results so detail pages are essential
    const needVin = results.filter((r) => !r.vin);
    const detailLimit = Math.min(needVin.length, 50);

    if (detailLimit > 0) {
      console.log(`[eBay] Fetching ${detailLimit} detail pages for VINs...`);
      for (let i = 0; i < detailLimit; i++) {
        const listing = needVin[i];
        const detailPage = await context.newPage();
        try {
          await detailPage.goto(listing.url, {
            waitUntil: "domcontentloaded",
            timeout: 20_000,
          });
          await delay(1500);

          const specs = await detailPage.evaluate(() => {
            const result: Record<string, string> = {};

            // New eBay layout: ux-labels-values pairs
            const labels = document.querySelectorAll(
              ".ux-labels-values__labels-content"
            );
            const values = document.querySelectorAll(
              ".ux-labels-values__values-content"
            );
            for (let j = 0; j < labels.length; j++) {
              const label =
                labels[j]?.textContent?.trim().toLowerCase() ?? "";
              const value = values[j]?.textContent?.trim() ?? "";
              if (label && value) result[label] = value;
            }

            // Fallback: older table layout
            if (Object.keys(result).length === 0) {
              const rows = document.querySelectorAll(
                ".ux-layout-section__textual-display--itemId .ux-textspans"
              );
              for (let j = 0; j < rows.length - 1; j += 2) {
                const label =
                  rows[j]?.textContent?.trim().toLowerCase() ?? "";
                const value = rows[j + 1]?.textContent?.trim() ?? "";
                if (label && value) result[label] = value;
              }
            }

            return result;
          });

          // Extract VIN
          const vinKey = Object.keys(specs).find(
            (k) => k.includes("vin")
          );
          if (vinKey && specs[vinKey].length === 17) {
            listing.vin = specs[vinKey].toUpperCase();
          }
          if (specs["exterior color"])
            listing.exteriorColor = specs["exterior color"];
          if (specs["interior color"])
            listing.interiorColor = specs["interior color"];
          if (specs["mileage"]) {
            const m = parseInt(
              specs["mileage"].replace(/[^0-9]/g, ""),
              10
            );
            if (m > 0) listing.mileage = m;
          }
          if (specs["vehicle title"]) {
            listing.titleStatus = specs["vehicle title"]
              .toLowerCase()
              .includes("clean")
              ? "clean"
              : specs["vehicle title"];
          }
        } catch {
          // detail page failed, skip
        }
        await detailPage.close();
        if (i < detailLimit - 1) await delay(800);
      }
    }

    // Only keep listings with valid VINs
    const validResults = results.filter(
      (r) => r.vin && r.vin.length === 17
    );

    await browser.close();

    console.log(
      `[eBay] Done — ${validResults.length} listings with VINs (${results.length} total scraped)`
    );
    return validResults;
  } catch (err) {
    console.error("[eBay] Playwright error:", err);
    if (browser) await browser.close();
  }

  return results.filter((r) => r.vin && r.vin.length === 17);
}
