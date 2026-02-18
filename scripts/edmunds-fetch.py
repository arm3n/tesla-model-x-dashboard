"""
Fetches Edmunds used Model X inventory using nodriver (undetected Chrome).
Extracts rich listing data from __PRELOADED_STATE__ across multiple pages.
Edmunds embeds a Redux store with inventory data, vehicle history, battery
health scores, and dealer info — significantly richer than DOM scraping.

Pagination uses click-based "Next" navigation (not direct URL) to mimic
human browsing and avoid Akamai rate-limiting.

Outputs JSON array of inventory items to stdout between markers.
"""

import nodriver as uc
import asyncio
import json
import sys
import random

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

        // Photos: try multiple known paths in Edmunds' Redux store
        const photos = r.photoUrls || r.photos || vi.photoUrls || [];
        let imageUrl = '';
        if (Array.isArray(photos) && photos.length > 0) {
            const first = photos[0];
            imageUrl = typeof first === 'string' ? first : (first?.url || first?.src || first?.href || '');
        }
        // Fallback: thumbnail from media
        if (!imageUrl) {
            const media = r.mediaData || vi.mediaData || {};
            const thumbs = media.thumbnails || media.photos || [];
            if (Array.isArray(thumbs) && thumbs.length > 0) {
                const t = thumbs[0];
                imageUrl = typeof t === 'string' ? t : (t?.url || t?.src || '');
            }
        }

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
            imageUrl: imageUrl || null,
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

    // Debug: dump keys from the first result to find photo field paths
    let debugKeys = null;
    if (results.length > 0) {
        const r = results[0];
        const vi = r.vehicleInfo || {};
        debugKeys = {
            resultKeys: Object.keys(r).sort(),
            vehicleInfoKeys: Object.keys(vi).sort(),
            hasPhotoUrls: !!r.photoUrls,
            hasPhotos: !!r.photos,
            hasMedia: !!r.mediaData,
            viHasPhotos: !!vi.photoUrls || !!vi.photos || !!vi.mediaData,
            samplePhotoUrl: r.photoUrls?.[0] || r.photos?.[0] || null,
        };
    }

    return JSON.stringify({
        items: items,
        total: invs.totalNumber || 0,
        pages: invs.totalPages || 0,
        debugKeys: debugKeys,
    });
})()
"""

# JS to find the "Next" pagination link href
CLICK_NEXT_JS = """
(() => {
    // Edmunds pagination: "Next" link has aria-label="Go to the next page"
    // and class "arrow-link" inside a .common-pagination container
    const nextLink = document.querySelector('a[aria-label="Go to the next page"]')
        || document.querySelector('a.arrow-link:not(.disabled)')
        || Array.from(document.querySelectorAll('.common-pagination a, .pagination-component a'))
            .find(a => a.textContent.trim() === 'Next' && !a.classList.contains('disabled'));
    if (!nextLink) return 'none';
    nextLink.scrollIntoView({behavior: 'smooth', block: 'center'});
    return nextLink.href || 'found-no-href';
})()
"""


async def is_blocked(page):
    """Check if Akamai blocked the page."""
    title = await page.evaluate("document.title")
    if not title:
        return True
    return "Access Denied" in title or "Pardon" in title


async def human_scroll(page):
    """Simulate human scrolling behavior."""
    try:
        # Scroll down in stages like a human reading
        for _ in range(random.randint(2, 4)):
            scroll_amount = random.randint(300, 800)
            await page.evaluate(f"window.scrollBy(0, {scroll_amount})")
            await asyncio.sleep(random.uniform(0.5, 1.5))
    except Exception:
        pass


async def extract_page_data(page, page_num, all_items, seen_vins):
    """Extract listing data from __PRELOADED_STATE__ on current page."""
    result = await page.evaluate(EXTRACT_STATE_JS)
    if not result:
        print(f"[Edmunds] No state on page {page_num}", file=sys.stderr)
        return None

    data = json.loads(result)
    items = data.get("items", [])
    total_pages = data.get("pages", 1)
    total_count = data.get("total", 0)

    # Debug: log available keys from first result to identify photo fields
    debug_keys = data.get("debugKeys")
    if debug_keys and page_num == 1:
        print(f"[Edmunds] DEBUG result keys: {debug_keys.get('resultKeys', [])}", file=sys.stderr)
        print(f"[Edmunds] DEBUG vehicleInfo keys: {debug_keys.get('vehicleInfoKeys', [])}", file=sys.stderr)
        print(f"[Edmunds] DEBUG photo flags: photoUrls={debug_keys.get('hasPhotoUrls')}, photos={debug_keys.get('hasPhotos')}, media={debug_keys.get('hasMedia')}, viPhotos={debug_keys.get('viHasPhotos')}", file=sys.stderr)
        sample = debug_keys.get("samplePhotoUrl")
        if sample:
            print(f"[Edmunds] DEBUG sample photo: {sample}", file=sys.stderr)
        else:
            print(f"[Edmunds] DEBUG no photos found in tried paths", file=sys.stderr)

    new_count = 0
    for item in items:
        if item["vin"] not in seen_vins:
            seen_vins.add(item["vin"])
            all_items.append(item)
            new_count += 1

    return {"total_pages": total_pages, "total_count": total_count, "new": new_count}


async def main():
    print("[Edmunds] Launching undetected Chrome...", file=sys.stderr)
    browser = await uc.start(headless=False)

    # Filter year=2023-2026: HW4 started late 2023, everything older is filtered
    # out by the HW4 check anyway. Reduces pages from ~64 to ~11.
    base_url = (
        "https://www.edmunds.com/inventory/srp.html"
        "?inventorytype=used&make=tesla&model=tesla|model-x"
        "&radius=6000&sort=price%3Aasc&year=2023-2026&maxMileage=50000"
    )

    all_items = []
    seen_vins = set()
    total_pages = 1
    consecutive_empty = 0

    # --- Page 1: direct URL navigation ---
    print("[Edmunds] Loading page 1...", file=sys.stderr)
    page = await browser.get(base_url)
    await asyncio.sleep(random.uniform(8, 12))

    if await is_blocked(page):
        print("[Edmunds] Blocked on page 1, waiting 45s...", file=sys.stderr)
        await asyncio.sleep(45)
        page = await browser.get(base_url)
        await asyncio.sleep(random.uniform(8, 12))
        if await is_blocked(page):
            print("[Edmunds] Still blocked on page 1, aborting", file=sys.stderr)
            browser.stop()
            print("__EDMUNDS_RESULTS_START__")
            print("[]")
            print("__EDMUNDS_RESULTS_END__")
            return

    await human_scroll(page)
    result = await extract_page_data(page, 1, all_items, seen_vins)
    if result:
        total_pages = result["total_pages"]
        total_count = result["total_count"]
        print(
            f"[Edmunds] Total: {total_count} listings across {total_pages} pages",
            file=sys.stderr,
        )

    # --- Pages 2+: click-based "Next" navigation ---
    retries_left = 2

    for page_num in range(2, total_pages + 1):
        # Human-like delay before clicking Next
        await asyncio.sleep(random.uniform(4, 9))

        # Scroll to bottom where pagination is
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await asyncio.sleep(random.uniform(1.0, 2.0))

        # Find and note the Next link
        next_href = await page.evaluate(CLICK_NEXT_JS)
        if next_href == "none":
            print(f"[Edmunds] No Next link on page {page_num - 1}, stopping", file=sys.stderr)
            break

        print(
            f"[Edmunds] Loading page {page_num}/{total_pages} "
            f"({len(all_items)} collected)...",
            file=sys.stderr,
        )

        # Click the Next link by navigating to its href (more reliable than click())
        if next_href.startswith("http"):
            page = await browser.get(next_href)
        else:
            # Fallback: construct URL
            url = f"{base_url}&pagenumber={page_num}"
            page = await browser.get(url)

        await asyncio.sleep(random.uniform(4, 8))

        if await is_blocked(page):
            if retries_left > 0:
                retries_left -= 1
                backoff = random.uniform(35, 55)
                print(
                    f"[Edmunds] Blocked on page {page_num}, "
                    f"backing off {backoff:.0f}s ({retries_left} retries left)...",
                    file=sys.stderr,
                )
                await asyncio.sleep(backoff)
                # Navigate to homepage first to appear like normal browsing
                await browser.get("https://www.edmunds.com/")
                await asyncio.sleep(random.uniform(4, 7))
                # Re-navigate to the target page
                url = f"{base_url}&pagenumber={page_num}"
                page = await browser.get(url)
                await asyncio.sleep(random.uniform(6, 10))
                if await is_blocked(page):
                    print(f"[Edmunds] Still blocked after retry, stopping", file=sys.stderr)
                    break
            else:
                print(f"[Edmunds] Blocked on page {page_num}, no retries left", file=sys.stderr)
                break

        await human_scroll(page)

        result = await extract_page_data(page, page_num, all_items, seen_vins)
        if not result:
            consecutive_empty += 1
            if consecutive_empty >= 2:
                break
            continue

        if result["new"] == 0:
            consecutive_empty += 1
            if consecutive_empty >= 2:
                print("[Edmunds] No new items for 2 pages, stopping", file=sys.stderr)
                break
        else:
            consecutive_empty = 0

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
