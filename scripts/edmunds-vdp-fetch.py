"""
Fetches individual Edmunds listings by VIN using nodriver.
Takes VIN:YEAR pairs as arguments, visits the SRP filtered by each VIN,
and extracts listing data from __PRELOADED_STATE__.

Uses SRP (search results page) rather than VDP (detail page) because
Edmunds VDP pages load vehicle data via client-side API calls, while
SRP embeds everything in __PRELOADED_STATE__ — same format the full
scraper (edmunds-fetch.py) uses.

Output: per-VIN JSON results between markers on stdout.
Progress/errors on stderr.
"""

import nodriver as uc
import asyncio
import json
import sys
import random

# JS to extract vehicle data from __PRELOADED_STATE__ on SRP page.
# Primary path is SRP results; VDP paths kept as fallback.
EXTRACT_VDP_JS = """
(() => {
    const state = window.__PRELOADED_STATE__;
    if (!state) return JSON.stringify({found: false, reason: 'no __PRELOADED_STATE__'});

    // VDP paths (fallback if page structure changes)
    const candidates = [
        state.inventoryDetail?.inventory,
        state.vehicleDetail?.inventory,
        state.inventory?.detail,
        state.inventory?.vehicle,
    ].filter(Boolean);

    // SRP results — primary extraction path when using ?vin= filter
    const srpResults = state.inventory?.searchResults?.inventories?.results;
    if (Array.isArray(srpResults)) {
        for (const r of srpResults) candidates.push(r);
    }

    for (const r of candidates) {
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

        // Photos
        const photos = r.photoUrls || r.photos || vi.photoUrls || [];
        let imageUrl = '';
        if (Array.isArray(photos) && photos.length > 0) {
            const first = photos[0];
            imageUrl = typeof first === 'string' ? first : (first?.url || first?.src || first?.href || '');
        }
        if (!imageUrl) {
            const media = r.mediaData || vi.mediaData || {};
            const thumbs = media.thumbnails || media.photos || [];
            if (Array.isArray(thumbs) && thumbs.length > 0) {
                const t = thumbs[0];
                imageUrl = typeof t === 'string' ? t : (t?.url || t?.src || '');
            }
        }

        return JSON.stringify({
            found: true,
            item: {
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
            }
        });
    }

    return JSON.stringify({found: false, reason: 'no vehicle data in known paths'});
})()
"""


async def is_blocked(page):
    """Check if Akamai blocked the page."""
    title = await page.evaluate("document.title")
    if not title:
        return True
    return "Access Denied" in title or "Pardon" in title


async def fetch_vdp(browser, vin, year, attempt=1):
    """Fetch a single listing via SRP filtered by VIN.
    VDP pages load data via API calls, but SRP embeds it in __PRELOADED_STATE__."""
    url = (
        f"https://www.edmunds.com/inventory/srp.html"
        f"?inventorytype=used&make=tesla&model=tesla|model-x&vin={vin}"
    )
    print(f"[Edmunds VDP] Fetching {vin} via SRP filter", file=sys.stderr)

    page = await browser.get(url)
    await asyncio.sleep(random.uniform(5, 8))

    if await is_blocked(page):
        if attempt <= 1:
            backoff = random.uniform(20, 35)
            print(f"[Edmunds VDP] Blocked for {vin}, backing off {backoff:.0f}s...", file=sys.stderr)
            await asyncio.sleep(backoff)
            # Visit homepage to reset session
            await browser.get("https://www.edmunds.com/")
            await asyncio.sleep(random.uniform(3, 5))
            return await fetch_vdp(browser, vin, year, attempt + 1)
        print(f"[Edmunds VDP] Still blocked for {vin} after retry", file=sys.stderr)
        return None

    # Simulate reading the page
    for _ in range(random.randint(1, 3)):
        scroll_amount = random.randint(200, 500)
        await page.evaluate(f"window.scrollBy(0, {scroll_amount})")
        await asyncio.sleep(random.uniform(0.3, 0.8))

    result = await page.evaluate(EXTRACT_VDP_JS)
    if not result:
        print(f"[Edmunds VDP] No state for {vin}", file=sys.stderr)
        return None

    data = json.loads(result)
    if not data.get("found"):
        reason = data.get("reason", "unknown")
        print(f"[Edmunds VDP] No data for {vin}: {reason}", file=sys.stderr)
        return None

    return data["item"]


async def main():
    if len(sys.argv) < 2:
        print("Usage: edmunds-vdp-fetch.py VIN1:YEAR1 VIN2:YEAR2 ...", file=sys.stderr)
        sys.exit(1)

    # Parse VIN:YEAR pairs
    pairs = []
    for arg in sys.argv[1:]:
        parts = arg.split(":")
        if len(parts) != 2:
            print(f"[Edmunds VDP] Invalid arg: {arg} (expected VIN:YEAR)", file=sys.stderr)
            continue
        pairs.append((parts[0].upper(), int(parts[1])))

    if not pairs:
        print("[Edmunds VDP] No valid VIN:YEAR pairs", file=sys.stderr)
        sys.exit(1)

    print(f"[Edmunds VDP] Launching browser for {len(pairs)} VIN(s)...", file=sys.stderr)
    browser = await uc.start(headless=False)
    try:
        results = []
        for i, (vin, year) in enumerate(pairs):
            if i > 0:
                # Human-like delay between pages
                await asyncio.sleep(random.uniform(3, 6))

            item = await fetch_vdp(browser, vin, year)
            if item:
                results.append(item)
                print(f"[Edmunds VDP] Got data for {vin}: ${item['price']:,} {item['mileage']:,}mi", file=sys.stderr)
                # Emit per-VIN result immediately
                print("__VDP_RESULT__" + json.dumps(item) + "__END_VDP__")
                sys.stdout.flush()
            else:
                print(f"[Edmunds VDP] No data for {vin}", file=sys.stderr)
                # Emit a miss marker so the caller knows this VIN was attempted
                print("__VDP_MISS__" + vin + "__END_VDP__")
                sys.stdout.flush()

        print(f"[Edmunds VDP] Done — {len(results)}/{len(pairs)} VINs fetched", file=sys.stderr)
    finally:
        try:
            browser.stop()
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
