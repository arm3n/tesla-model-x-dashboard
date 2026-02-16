import type { RawListing } from "./types.ts";
import { runScraperInNode } from "./run-in-node.ts";

interface CarGurusListingData {
  vin?: string;
  price?: number;
  mileage?: number;
  year?: number;
  trimName?: string;
  exteriorColorName?: string;
  interiorColorName?: string;
  mainPictureUrl?: string;
  dealerName?: string;
  dealerCity?: string;
  dealerState?: string;
  listingId?: number;
  listedDate?: string;
  seatCount?: number;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeCarGurus(): Promise<RawListing[]> {
  if (typeof globalThis.Bun !== "undefined") {
    return runScraperInNode("cargurus");
  }

  let browser;
  const results: RawListing[] = [];

  try {
    const { launchStealthBrowser } = await import("./stealth-browser.ts");
    const launched = await launchStealthBrowser();
    browser = launched.browser;
    const context = launched.context;

    const maxPages = 10;
    const seenVins = new Set<string>();

    for (let pg = 1; pg <= maxPages; pg++) {
      const page = await context.newPage();

      // Intercept XHR responses to capture listing data
      const interceptedListings: CarGurusListingData[] = [];
      page.on("response", async (response) => {
        const url = response.url();
        if (
          url.includes("inventorylisting") ||
          url.includes("search/results") ||
          url.includes("/api/") ||
          url.includes("resultsPage")
        ) {
          try {
            const json = await response.json();
            if (json?.listings) {
              interceptedListings.push(...json.listings);
            } else if (json?.searchResults) {
              interceptedListings.push(...json.searchResults);
            } else if (Array.isArray(json)) {
              interceptedListings.push(...json);
            }
          } catch {
            // not JSON, ignore
          }
        }
      });

      const searchUrl =
        pg === 1
          ? "https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?zip=10001&showNegotiable=true&sortDir=ASC&sourceContext=carGurusHomePageModel&distance=50000&entitySelectingHelper.selectedEntity=d2132"
          : `https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?zip=10001&showNegotiable=true&sortDir=ASC&sourceContext=carGurusHomePageModel&distance=50000&entitySelectingHelper.selectedEntity=d2132&page=${pg}`;

      try {
        await page.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await delay(4000);

        // Scroll to load all lazy content first
        for (let i = 0; i < 8; i++) {
          await page.evaluate(() => window.scrollBy(0, window.innerHeight));
          await delay(1500);
        }

        // Try to extract from embedded script data if XHR didn't capture
        if (interceptedListings.length === 0) {
          const scriptData = await page.evaluate(() => {
            const scripts = document.querySelectorAll("script");
            for (const s of scripts) {
              const text = s.textContent ?? "";
              if (text.includes('"listings"') || text.includes('"vin"')) {
                const match = text.match(
                  /"listings"\s*:\s*(\[[\s\S]*?\])\s*[,}]/
                );
                if (match) {
                  try {
                    return JSON.parse(match[1]);
                  } catch {
                    /* continue */
                  }
                }
              }
            }
            return null;
          });

          if (Array.isArray(scriptData)) {
            interceptedListings.push(...scriptData);
          }
        }

        // DOM-based extraction as final fallback
        if (interceptedListings.length === 0) {
          const domListings = await page.evaluate(() => {
            const cards = document.querySelectorAll(
              '[data-testid="srp-listing-card"], .cg-listingCard, .listing-row, [data-cg-ft="car-blade"]'
            );
            const items: any[] = [];
            for (const card of cards) {
              const vin = card.getAttribute("data-vin") ?? "";
              const priceEl = card.querySelector(
                '[data-testid="listing-price"], .price, .cg-price, .price-section'
              );
              const mileEl = card.querySelector(
                ".mileage, .cg-mileage, [data-testid='listing-mileage']"
              );
              const titleEl = card.querySelector(
                "h4, .listing-title, .cg-title, h2"
              );
              const linkEl = card.querySelector("a") as HTMLAnchorElement;
              const dealerEl = card.querySelector(
                ".dealer-name, [data-testid='listing-dealer']"
              );
              const locationEl = card.querySelector(
                ".dealer-location, [data-testid='listing-location']"
              );
              const imageEl = card.querySelector("img") as HTMLImageElement;

              items.push({
                vin,
                price: priceEl?.textContent ?? "",
                mileage: mileEl?.textContent ?? "",
                title: titleEl?.textContent ?? "",
                href: linkEl?.href ?? "",
                dealer: dealerEl?.textContent ?? "",
                location: locationEl?.textContent ?? "",
                imageUrl:
                  imageEl?.src || imageEl?.getAttribute("data-src") || null,
              });
            }
            return items;
          });

          for (const item of domListings) {
            const vin = (item.vin ?? "").toUpperCase();
            if (!vin || vin.length !== 17) continue;
            const yearMatch = item.title?.match(/^(\d{4})/);
            const trimMatch = item.title?.match(/Model X\s+(.+)/i);
            interceptedListings.push({
              vin,
              price:
                parseInt(item.price?.replace(/[^0-9]/g, "") ?? "0", 10) || 0,
              mileage:
                parseInt(item.mileage?.replace(/[^0-9]/g, "") ?? "0", 10) || 0,
              year: yearMatch ? parseInt(yearMatch[1], 10) : 0,
              trimName: trimMatch?.[1]?.trim() ?? "",
              dealerName: item.dealer?.trim() ?? "",
              mainPictureUrl: item.imageUrl,
            });
          }
        }

        // Convert to RawListing
        let pageCount = 0;
        for (const item of interceptedListings) {
          const vin = item.vin?.toUpperCase();
          if (!vin || vin.length !== 17) continue;
          if (seenVins.has(vin)) continue;
          seenVins.add(vin);

          const listingUrl = item.listingId
            ? `https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?listingId=${item.listingId}`
            : `https://www.cargurus.com/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?zip=10001&entitySelectingHelper.selectedEntity=d2132`;

          results.push({
            vin,
            source: "cargurus",
            url: listingUrl,
            price: item.price ?? 0,
            mileage: item.mileage ?? 0,
            year: item.year ?? 0,
            trim: item.trimName ?? "",
            exteriorColor: item.exteriorColorName ?? "",
            interiorColor: item.interiorColorName ?? "",
            seatCount: item.seatCount ?? null,
            dealerName: item.dealerName ?? "",
            dealerLocation:
              item.dealerCity && item.dealerState
                ? `${item.dealerCity}, ${item.dealerState}`
                : "",
            imageUrl: item.mainPictureUrl ?? null,
            listedDate: item.listedDate ?? null,
          });
          pageCount++;
        }

        console.log(
          `[CarGurus] Page ${pg}: ${pageCount} listings (total: ${results.length})`
        );

        if (pageCount === 0) {
          await page.close();
          break;
        }
      } catch (err) {
        console.error(`[CarGurus] Error on page ${pg}:`, err);
        await page.close();
        break;
      }

      await page.close();

      if (pg < maxPages) {
        await delay(4000 + Math.random() * 3000);
      }
    }

    await browser.close();
  } catch (err) {
    console.error("[CarGurus] Error:", err);
    if (browser) await browser.close();
  }

  if (results.length === 0) {
    console.log("[CarGurus] 0 listings — likely blocked by bot detection");
  } else {
    console.log(`[CarGurus] Done — ${results.length} listings`);
  }
  return results;
}
