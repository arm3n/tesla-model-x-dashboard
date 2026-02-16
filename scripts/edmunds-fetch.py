"""
Fetches Edmunds used Model X inventory using nodriver (undetected Chrome).
Extracts rich listing data from __PRELOADED_STATE__ across multiple pages.
Edmunds embeds a Redux store with inventory data, vehicle history, battery
health scores, and dealer info — significantly richer than DOM scraping.

Outputs JSON array of inventory items to stdout between markers.
"""

import nodriver as uc
import asyncio
import json
import sys

# JS to extract inventory data from Edmunds' Redux store
EXTRACT_STATE_JS = """
(() => {
    const state = window.__PRELOADED_STATE__;
    if (!state || !state.inventory) return JSON.stringify({items: [], total: 0, pages: 0});

    const sr = state.inventory.searchResults;
    const invs = sr?.inventories;
    if (!invs) return JSON.stringify({items: [], total: 0, pages: 0});

    const results = invs.results || [];
    const items = [];

    for (const r of results) {
        const vin = (r.vin || '').toUpperCase();
        if (!vin || vin.length !== 17) continue;

        const vi = r.vehicleInfo || {};
        const si = vi.styleInfo || {};
        const colors = vi.vehicleColors || {};
        const dealer = r.dealerInfo || {};
        const addr = dealer.address || {};
        const prices = r.prices || {};
        const history = r.historyInfo || {};
        const recurrent = r.thirdPartyInfo?.recurrentInsights || {};

        items.push({
            vin: vin,
            price: prices.displayPrice || prices.advertisedPrice || 0,
            mileage: vi.mileage || 0,
            year: si.year || 0,
            trim: si.trim || '',
            style: si.style || '',
            numberOfSeats: si.numberOfSeats || null,
            exteriorColor: colors.exterior?.name || '',
            exteriorGenericColor: colors.exterior?.genericName || '',
            interiorColor: colors.interior?.name || '',
            interiorGenericColor: colors.interior?.genericName || '',
            dealerName: dealer.name || '',
            dealerCity: addr.city || '',
            dealerState: addr.stateCode || '',
            listingUrl: r.listingUrl || '',
            firstPublishedDate: r.firstPublishedDate || null,
            listedSince: r.listedSince || null,
            cleanTitle: history.cleanTitle ?? null,
            salvageHistory: history.salvageHistory ?? null,
            lemonHistory: history.lemonHistory ?? null,
            frameDamage: history.frameDamage ?? null,
            noAccidents: history.noAccidents ?? null,
            accidentText: history.accidentText || null,
            ownerText: history.ownerText || null,
            rangeScore: recurrent.rangeScore || null,
            expectedRangeMin: recurrent.expectedRange?.min || null,
            expectedRangeMax: recurrent.expectedRange?.max || null,
            dealType: r.thirdPartyInfo?.priceValidation?.dealType || null,
        });
    }

    return JSON.stringify({
        items: items,
        total: invs.totalNumber || 0,
        pages: invs.totalPages || 0,
    });
})()
"""


async def main():
    print("[Edmunds] Launching undetected Chrome...", file=sys.stderr)
    browser = await uc.start(headless=False)

    base_url = (
        "https://www.edmunds.com/inventory/srp.html"
        "?inventorytype=used&make=tesla&model=tesla|model-x"
        "&radius=6000&sort=price%3Aasc"
    )

    all_items = []
    seen_vins = set()
    total_pages = 1
    consecutive_empty = 0

    for page_num in range(1, 100):
        url = base_url if page_num == 1 else f"{base_url}&pagenumber={page_num}"

        if page_num == 1:
            print(f"[Edmunds] Loading page {page_num}...", file=sys.stderr)
        else:
            print(
                f"[Edmunds] Loading page {page_num}/{total_pages} "
                f"({len(all_items)} collected)...",
                file=sys.stderr,
            )

        page = await browser.get(url)

        # First page needs more time; subsequent pages faster
        wait_time = 10 if page_num == 1 else 3
        await asyncio.sleep(wait_time)

        title = await page.evaluate("document.title")
        if not title or "Access Denied" in title or "Pardon" in title:
            print(f"[Edmunds] Blocked on page {page_num}: {title}", file=sys.stderr)
            break

        result = await page.evaluate(EXTRACT_STATE_JS)
        if not result:
            print(f"[Edmunds] No state on page {page_num}", file=sys.stderr)
            consecutive_empty += 1
            if consecutive_empty >= 2:
                break
            continue

        data = json.loads(result)
        items = data.get("items", [])

        if page_num == 1:
            total_pages = data.get("pages", 1)
            total_count = data.get("total", 0)
            print(
                f"[Edmunds] Total: {total_count} listings across {total_pages} pages",
                file=sys.stderr,
            )

        new_count = 0
        for item in items:
            if item["vin"] not in seen_vins:
                seen_vins.add(item["vin"])
                all_items.append(item)
                new_count += 1

        if new_count == 0:
            consecutive_empty += 1
            if consecutive_empty >= 2:
                print("[Edmunds] No new items for 2 pages, stopping", file=sys.stderr)
                break
        else:
            consecutive_empty = 0

        if page_num >= total_pages:
            break

    browser.stop()

    # Log samples
    for item in all_items[:3]:
        print(
            f"  VIN={item['vin']} ${item['price']:,} {item['year']} "
            f"{item['trim']} {item['mileage']:,}mi "
            f"Ext={item['exteriorColor'][:20]} "
            f"Seats={item['numberOfSeats']} "
            f"Title={'clean' if item.get('cleanTitle') else 'other'} "
            f"Accidents={item.get('accidentText', '?')}",
            file=sys.stderr,
        )

    print(f"[Edmunds] Done — {len(all_items)} unique listings", file=sys.stderr)
    print("__EDMUNDS_RESULTS_START__")
    print(json.dumps(all_items))
    print("__EDMUNDS_RESULTS_END__")


if __name__ == "__main__":
    asyncio.run(main())
