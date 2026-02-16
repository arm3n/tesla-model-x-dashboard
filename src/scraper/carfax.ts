import type { RawListing } from "./types.ts";
import { runScraperInNode } from "./run-in-node.ts";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeCarfax(): Promise<RawListing[]> {
  if (typeof globalThis.Bun !== "undefined") {
    return runScraperInNode("carfax");
  }

  const results: RawListing[] = [];

  let browser;
  try {
    const { launchStealthBrowser } = await import("./stealth-browser.ts");
    const launched = await launchStealthBrowser();
    browser = launched.browser;
    const context = launched.context;

    const page = await context.newPage();

    // Intercept API responses
    const intercepted: any[] = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (
        url.includes("/api/vehicles") ||
        url.includes("/api/listings") ||
        url.includes("/search-results") ||
        url.includes("/sfx/search")
      ) {
        try {
          const json = await response.json();
          const items =
            json.vehicles ?? json.listings ?? json.results ?? json.searchResults ?? [];
          if (items.length) intercepted.push(...items);
        } catch {
          /* not JSON */
        }
      }
    });

    await page.goto("https://www.carfax.com/Used-2023-2026-Tesla-Model-X_w514", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await delay(5000);

    // Scroll to trigger lazy loading and additional API calls
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await delay(1500);
    }

    // Try clicking "Show More" / "Load More" buttons to get all listings
    for (let clicks = 0; clicks < 15; clicks++) {
      try {
        const loadMore = await page.$(
          'button:has-text("Show More"), button:has-text("Load More"), button:has-text("See More"), a:has-text("Next")'
        );
        if (!loadMore) break;
        await loadMore.click();
        await delay(3000);
        // Scroll after loading more
        await page.evaluate(() => window.scrollBy(0, 2000));
        await delay(1500);
      } catch {
        break;
      }
    }

    // If no intercepted API data, try extracting from page DOM
    if (intercepted.length === 0) {
      console.log("[CarFax] No intercepted API data, trying DOM extraction...");
      const domItems = await page.evaluate(() => {
        const cards = document.querySelectorAll(
          '.srp-list-item, [data-testid="listing-card"], .listing-card, article'
        );
        const items: any[] = [];
        for (const card of cards) {
          const linkEl = card.querySelector("a[href*='/vehicle/']") as HTMLAnchorElement;
          const href = linkEl?.href ?? "";
          // Extract VIN from URL if available (carfax URLs often contain VIN)
          const vinMatch = href.match(/\/vehicle\/([A-HJ-NPR-Z0-9]{17})/i);
          const vin = vinMatch?.[1] ?? card.getAttribute("data-vin") ?? "";

          const priceEl = card.querySelector(
            '.srp-list-item-price, [data-testid="price"], .price, .listing-price'
          );
          const mileEl = card.querySelector(
            '.srp-list-item-mileage, [data-testid="mileage"], .mileage'
          );
          const titleEl = card.querySelector(
            '.srp-list-item-basic-info-model, h2, h3, .listing-title'
          );

          const accidentEl = card.querySelector(
            '.srp-list-item-history-icon--accident, [data-testid="accident-badge"]'
          );
          const ownerEl = card.querySelector(
            '.srp-list-item-history-icon--owner, [data-testid="owner-badge"]'
          );
          const imageEl = card.querySelector("img") as HTMLImageElement;

          items.push({
            vin,
            price: priceEl?.textContent ?? "",
            mileage: mileEl?.textContent ?? "",
            title: titleEl?.textContent ?? "",
            href,
            hasAccidentBadge: !!accidentEl,
            ownerText: ownerEl?.textContent ?? "",
            imageUrl: imageEl?.src || imageEl?.getAttribute("data-src") || null,
          });
        }
        return items;
      });

      for (const item of domItems) {
        const vin = (item.vin ?? "").toUpperCase();
        if (!vin || vin.length !== 17) continue;

        const priceNum = parseInt((item.price ?? "").replace(/[^0-9]/g, ""), 10) || 0;
        const mileageNum = parseInt((item.mileage ?? "").replace(/[^0-9]/g, ""), 10) || 0;
        const title = item.title ?? "";
        const yearMatch = title.match(/(\d{4})/);
        const year = yearMatch ? parseInt(yearMatch[1], 10) : 0;
        const trimMatch = title.match(/Model X\s+(.+)/i);
        const trim = trimMatch?.[1]?.trim() ?? "";

        let accidentHistory: "clean" | "accident" | "unknown" = "unknown";
        // CarFax pages often show "No Accidents" badge
        if (item.hasAccidentBadge) accidentHistory = "clean";

        results.push({
          vin,
          source: "carfax",
          url: item.href || `https://www.carfax.com/vehicle/${vin}`,
          price: priceNum,
          mileage: mileageNum,
          year,
          trim,
          exteriorColor: "",
          interiorColor: "",
          seatCount: null,
          dealerName: "",
          dealerLocation: "",
          imageUrl: item.imageUrl,
          listedDate: null,
          accidentHistory,
        });
      }
    }

    // Process intercepted API data
    for (const item of intercepted) {
      const vin = (item.vin ?? "").toUpperCase();
      if (!vin || vin.length !== 17) continue;

      const price = item.price ?? item.currentPrice ?? 0;
      const mileage = item.mileage ?? 0;
      const year = item.year ?? 0;
      const trim = item.trim ?? "";
      const extColor = item.exteriorColor ?? "";
      const intColor = item.interiorColor ?? "";

      const dealer = item.dealer ?? {};
      const dealerName = dealer.name ?? "";
      const dealerCity = dealer.city ?? "";
      const dealerState = dealer.state ?? "";
      const dealerLocation =
        dealerCity && dealerState
          ? `${dealerCity}, ${dealerState}`
          : dealerCity || dealerState;

      const imageUrl = item.imageUrl ?? item.images?.[0]?.url ?? null;

      let titleStatus: string | null = null;
      let accidentHistory: "clean" | "accident" | "unknown" = "unknown";

      if (item.accidentCount !== undefined) {
        accidentHistory = item.accidentCount > 0 ? "accident" : "clean";
      } else if (item.isAccidentFree === true) {
        accidentHistory = "clean";
      } else if (item.isAccidentFree === false) {
        accidentHistory = "accident";
      }

      if (item.titleIssue || item.hasTitleIssue) {
        titleStatus = "branded";
      } else if (item.isCleanTitle === true) {
        titleStatus = "clean";
      }

      const badges: string[] = item.badges ?? [];
      if (badges.includes("NO_ACCIDENT") || badges.includes("no-accident")) {
        accidentHistory = "clean";
      }
      if (badges.includes("CLEAN_TITLE") || badges.includes("clean-title")) {
        titleStatus = "clean";
      }

      results.push({
        vin,
        source: "carfax",
        url: item.url ?? `https://www.carfax.com/vehicle/${vin}`,
        price,
        mileage,
        year,
        trim,
        exteriorColor: extColor,
        interiorColor: intColor,
        seatCount: null,
        dealerName,
        dealerLocation,
        imageUrl,
        listedDate: item.listedDate ?? null,
        titleStatus,
        accidentHistory,
      });
    }

    await browser.close();
  } catch (err) {
    console.error("[CarFax] Playwright error:", err);
    if (browser) await browser.close();
  }

  if (results.length === 0) {
    console.log("[CarFax] 0 listings — likely blocked by CAPTCHA (slide puzzle)");
  } else {
    console.log(`[CarFax] Done — ${results.length} listings`);
  }
  return results;
}
