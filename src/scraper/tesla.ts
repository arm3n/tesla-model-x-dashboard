import type { RawListing } from "./types.ts";
import { runScraperInNode } from "./run-in-node.ts";

const INVENTORY_URL = "https://www.tesla.com/inventory/used/mx";
const API_URL = "https://www.tesla.com/inventory/api/v4/inventory-results";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseItem(item: any): RawListing | null {
  const vin = (item.VIN ?? item.vin ?? "").toUpperCase();
  if (!vin || vin.length !== 17) return null;

  const optionCodes: string[] = item.OptionCodeList ?? item.OPTIONCODELIST ?? [];
  const optionCodesStr: string = typeof optionCodes === "string" ? optionCodes : "";
  const codeList = Array.isArray(optionCodes)
    ? optionCodes
    : optionCodesStr.split(",").filter(Boolean);

  let seatCount: number | null = null;
  const trimStr = (item.TRIM ?? item.TrimName ?? "").toLowerCase();
  for (const code of codeList) {
    if (/6.?seat/i.test(code) || code === "ST02" || code === "MTY06") seatCount = 6;
    else if (/7.?seat/i.test(code) || code === "ST03" || code === "MTY07") seatCount = 7;
    else if (/5.?seat/i.test(code) || code === "ST01" || code === "MTY05") seatCount = 5;
  }
  if (!seatCount && trimStr.includes("6 seat")) seatCount = 6;
  if (!seatCount && trimStr.includes("7 seat")) seatCount = 7;

  const price = item.Price ?? item.PurchasePrice ?? item.price ?? 0;
  const mileage = item.Odometer ?? item.OdometerValue ?? item.odometer ?? 0;
  const year = item.Year ?? item.year ?? 0;
  const trim = item.TRIM ?? item.TrimName ?? item.trim ?? "";
  const extColor = item.PAINT ?? item.ExteriorColor ?? item.exteriorColor ?? "";
  const intColor = item.INTERIOR ?? item.InteriorColor ?? item.interiorColor ?? "";

  const city = item.City ?? item.city ?? "";
  const state = item.StateProvince ?? item.state ?? "";
  const location = city && state ? `${city}, ${state}` : city || state;

  const images = item.CompositorViews?.frontView ?? item.ImageUrl ?? null;
  const titleStatus = item.TitleStatus ?? item.titleStatus ?? null;

  return {
    vin,
    source: "tesla",
    url: `https://www.tesla.com/mx/order/${vin}`,
    price,
    mileage,
    year,
    trim,
    exteriorColor: extColor,
    interiorColor: intColor,
    seatCount,
    dealerName: "Tesla",
    dealerLocation: location,
    imageUrl: images,
    listedDate: item.DisplayDate ?? item.firstSeenDate ?? null,
    optionCodes: codeList,
    titleStatus: titleStatus === "CLEAN" ? "clean" : titleStatus,
  };
}

export async function scrapeTesla(): Promise<RawListing[]> {
  // Bun can't launch Playwright — delegate to Node.js
  if (typeof globalThis.Bun !== "undefined") {
    return runScraperInNode("tesla");
  }

  const results: RawListing[] = [];

  let browser;
  try {
    const { launchStealthBrowser } = await import("./stealth-browser.ts");
    const launched = await launchStealthBrowser();
    browser = launched.browser;
    const context = launched.context;

    const page = await context.newPage();

    // Intercept API responses from the inventory endpoint
    const intercepted: any[] = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("inventory/api") || url.includes("inventory-results")) {
        try {
          const json = await response.json();
          const items = json.results ?? [];
          if (items.length) intercepted.push(...items);
        } catch { /* not JSON */ }
      }
    });

    // Navigate to inventory page — this triggers API calls
    await page.goto(INVENTORY_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await delay(5000);

    // Scroll to trigger lazy loading
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await delay(1500);
    }

    // Also try making direct API calls from the browser context (bypasses Cloudflare)
    if (intercepted.length === 0) {
      console.log("[Tesla] No intercepted data, trying in-page API call...");
      const apiData = await page.evaluate(async () => {
        const allItems: any[] = [];
        for (let offset = 0; offset < 1000; offset += 50) {
          try {
            const res = await fetch("/inventory/api/v4/inventory-results", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                query: {
                  model: "mx", condition: "used", options: {},
                  arrangeby: "Price", order: "asc", market: "US",
                  language: "en", super_region: "north america",
                  lng: -97.7431, lat: 30.2672, zip: "78701", range: 0, region: "US",
                },
                offset, count: 50, outsideOffset: 0, outsideSearch: false,
              }),
            });
            if (!res.ok) break;
            const data = await res.json();
            const items = data.results ?? [];
            if (items.length === 0) break;
            allItems.push(...items);
            if (allItems.length >= (data.total_matches_found ?? 0)) break;
          } catch { break; }
          await new Promise(r => setTimeout(r, 1500));
        }
        return allItems;
      });
      intercepted.push(...apiData);
    }

    for (const item of intercepted) {
      const parsed = parseItem(item);
      if (parsed) results.push(parsed);
    }

    await browser.close();
  } catch (err) {
    console.error("[Tesla] Playwright error:", err);
    if (browser) await browser.close();
  }

  if (results.length === 0) {
    console.log("[Tesla] 0 listings — likely blocked by Cloudflare (403)");
  } else {
    console.log(`[Tesla] Done — ${results.length} listings`);
  }
  return results;
}
