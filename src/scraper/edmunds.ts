import type { RawListing } from "./types.ts";
import { runScraperInNode } from "./run-in-node.ts";

const SEARCH_URL = "https://www.edmunds.com/inventory/srp.html?inventorytype=used&make=tesla&model=tesla|model-x&radius=6000&sort=price%3Aasc";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeEdmunds(): Promise<RawListing[]> {
  if (typeof globalThis.Bun !== "undefined") {
    return runScraperInNode("edmunds");
  }

  const results: RawListing[] = [];

  let browser;
  try {
    const { launchStealthBrowser } = await import("./stealth-browser.ts");
    const launched = await launchStealthBrowser();
    browser = launched.browser;
    const context = launched.context;

    const page = await context.newPage();

    // Intercept inventory API responses
    const intercepted: any[] = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/srp/inventory") || url.includes("/gateway/api") && url.includes("inventory")) {
        try {
          const json = await response.json();
          const items = json.inventories ?? json.results ?? [];
          if (items.length) intercepted.push(...items);
        } catch { /* not JSON */ }
      }
    });

    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await delay(5000);

    // Scroll to trigger lazy loading
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await delay(1500);
    }

    // If no intercepted API data, try calling the API from the browser context
    if (intercepted.length === 0) {
      console.log("[Edmunds] No intercepted data, trying in-page API call...");
      const apiData = await page.evaluate(async () => {
        const allItems: any[] = [];
        for (let pageNum = 1; pageNum <= 20; pageNum++) {
          try {
            const res = await fetch("/gateway/api/purchasefunnel/v1/srp/inventory", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                destination: "search",
                inventoryType: "used",
                make: "tesla",
                model: "tesla-model_x",
                pageNum,
                pageSize: 100,
                radius: 6000,
                sort: { field: "price", order: "ASC" },
                zip: "10001",
              }),
            });
            if (!res.ok) break;
            const data = await res.json();
            const items = data.inventories ?? data.results ?? [];
            if (items.length === 0) break;
            allItems.push(...items);
            const totalPages = data.totalPages ?? 0;
            if (pageNum >= totalPages) break;
          } catch { break; }
          await new Promise(r => setTimeout(r, 1500));
        }
        return allItems;
      });
      intercepted.push(...apiData);
    }

    for (const item of intercepted) {
      const vin = (item.vin ?? "").toUpperCase();
      if (!vin || vin.length !== 17) continue;

      const price = item.prices?.displayPrice ?? item.prices?.tmv ?? item.price ?? 0;
      const mileage = item.mileage ?? 0;
      const year = item.year ?? 0;
      const trim = item.trim ?? item.trimName ?? "";
      const extColor = item.exteriorColor ?? item.exteriorGenericColor ?? "";
      const intColor = item.interiorColor ?? item.interiorGenericColor ?? "";

      const dealer = item.dealer ?? {};
      const dealerName = dealer.name ?? dealer.dealerName ?? "";
      const dealerCity = dealer.city ?? "";
      const dealerState = dealer.state ?? "";
      const dealerLocation = dealerCity && dealerState
        ? `${dealerCity}, ${dealerState}`
        : dealerCity || dealerState;

      const imageUrl = item.mediaPhotos?.[0]?.href
        ?? item.stockPhotos?.[0]?.href
        ?? item.photo?.href
        ?? null;

      const slug = item.styleSlug ?? "";
      const listingUrl = item.inventoryId
        ? `https://www.edmunds.com/tesla/model-x/${year}/${slug}/vin/${vin}/`
        : `https://www.edmunds.com/tesla/model-x/inventory/?vin=${vin}`;

      const history = item.vehicleHistory ?? {};
      let titleStatus: string | null = null;
      let accidentHistory: "clean" | "accident" | "unknown" = "unknown";

      if (history.titleBranded === true) titleStatus = "branded";
      else if (history.titleBranded === false) titleStatus = "clean";

      if (history.hasAccident === true) accidentHistory = "accident";
      else if (history.hasAccident === false) accidentHistory = "clean";

      results.push({
        vin,
        source: "edmunds",
        url: listingUrl,
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
        listedDate: item.firstSeen ?? item.inventoryDate ?? null,
        titleStatus,
        accidentHistory,
      });
    }

    await browser.close();
  } catch (err) {
    console.error("[Edmunds] Playwright error:", err);
    if (browser) await browser.close();
  }

  if (results.length === 0) {
    console.log("[Edmunds] 0 listings — likely blocked by Akamai (403)");
  } else {
    console.log(`[Edmunds] Done — ${results.length} listings`);
  }
  return results;
}
