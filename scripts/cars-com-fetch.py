"""
Fetches Cars.com used Tesla Model X Plaid inventory using nodriver (undetected Chrome).
Extracts listing data from search result pages and VINs from detail pages.
nodriver bypasses Cars.com's bot detection that blocks plain fetch/curl.

Outputs JSON array of listings to stdout between markers.
"""

import nodriver as uc
import asyncio
import json
import sys
import random
import re

SEARCH_URL = (
    "https://www.cars.com/shopping/results/"
    "?stock_type=used&makes[]=tesla&models[]=tesla-model_x"
    "&trims[]=tesla-model_x-plaid"
    "&list_price_max=85000&mileage_max=50000"
    "&maximum_distance=all&page_size=100"
    "&year_min=2023&year_max=2026"
)

# JS to extract listing data from search result cards
EXTRACT_SEARCH_JS = r"""
(() => {
    const listings = [];
    // Cars.com uses vehicle-card custom elements or div.vehicle-card
    const cards = document.querySelectorAll(
        'div.vehicle-card, vehicle-card, [class*="vehicle-card"], a[href*="vehicledetail"]'
    );

    // Track seen URLs to dedup
    const seen = new Set();

    // Also try getting links directly
    const links = document.querySelectorAll('a[href*="vehicledetail"]');
    for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (!href.includes('vehicledetail')) continue;
        const fullUrl = href.startsWith('http') ? href : 'https://www.cars.com' + href;
        if (seen.has(fullUrl)) continue;
        seen.add(fullUrl);

        // Walk up to find the card container
        let card = link.closest('[class*="vehicle-card"], .shop-srp-listings__listing, div.vehicle-card');
        if (!card) card = link.parentElement?.parentElement || link;
        const text = card.innerText || card.textContent || '';

        const priceMatch = text.match(/\$([0-9,]+)/);
        const mileageMatch = text.match(/([\d,]+)\s*mi/);
        const yearMatch = text.match(/(202[3-6])\s+Tesla\s+Model\s+X/i);
        const trimMatch = text.match(/Model\s+X\s+(.*?)(?:\n|$)/i);

        // Image
        const img = card.querySelector('img');
        const imageUrl = img ? (img.src || img.getAttribute('data-src') || '') : '';

        // Dealer and location
        const dealerEl = card.querySelector('[class*="dealer-name"], .dealer-name');
        const dealer = dealerEl ? dealerEl.textContent.trim() : '';
        const locMatch = text.match(/([A-Za-z\s]+,\s*[A-Z]{2})/);

        listings.push({
            url: fullUrl,
            price: priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : 0,
            mileage: mileageMatch ? parseInt(mileageMatch[1].replace(/,/g, ''), 10) : 0,
            year: yearMatch ? parseInt(yearMatch[1], 10) : 0,
            trim: trimMatch ? trimMatch[1].trim() : '',
            dealer: dealer,
            location: locMatch ? locMatch[1].trim() : '',
            imageUrl: imageUrl || null,
        });
    }
    return JSON.stringify(listings);
})()
"""

# JS to extract VIN and details from a detail page
EXTRACT_DETAIL_JS = r"""
(() => {
    const text = document.body.innerText || document.body.textContent || '';

    // VIN: check JSON-LD first (most reliable), then page text
    let ldVin = '';
    let ldMileage = 0;
    let ldPrice = 0;
    let ldDealer = '';
    let ldExtColor = '';
    let ldIntColor = '';
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
        try {
            const data = JSON.parse(s.textContent);
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
                if (item.vehicleIdentificationNumber) {
                    ldVin = item.vehicleIdentificationNumber;
                }
                if (item.mileageFromOdometer) {
                    const v = item.mileageFromOdometer.value || item.mileageFromOdometer;
                    ldMileage = parseInt(String(v).replace(/,/g, ''), 10) || 0;
                }
                if (item.offers && item.offers.price) {
                    ldPrice = parseInt(String(item.offers.price).replace(/,/g, ''), 10) || 0;
                }
                if (item.offers && item.offers.seller && item.offers.seller.name) {
                    ldDealer = item.offers.seller.name;
                }
                if (item.color) ldExtColor = item.color;
                if (item.vehicleInteriorColor) ldIntColor = item.vehicleInteriorColor;
            }
        } catch {}
    }

    const vinMatch = text.match(/VIN[:\s]*([A-HJ-NPR-Z0-9]{17})/i);
    const vin = ldVin || (vinMatch ? vinMatch[1] : '');

    // Colors from page text (fallback)
    const extMatch = text.match(/Exterior\s*[Cc]olor[:\s]*([^\n]+)/);
    const intMatch = text.match(/Interior\s*[Cc]olor[:\s]*([^\n]+)/);

    // Mileage: try multiple patterns
    let mileage = ldMileage;
    if (!mileage) {
        // Try "XX,XXX mi" or "XX,XXX miles" patterns
        const miMatch = text.match(/([\d,]+)\s*mi(?:les?)?(?:\s|$|\.)/i);
        if (miMatch) mileage = parseInt(miMatch[1].replace(/,/g, ''), 10) || 0;
    }
    if (!mileage) {
        // Try "Mileage XX,XXX" pattern
        const mlMatch = text.match(/[Mm]ileage[:\s]*([\d,]+)/);
        if (mlMatch) mileage = parseInt(mlMatch[1].replace(/,/g, ''), 10) || 0;
    }

    // Price from page (fallback)
    let price = ldPrice;
    if (!price) {
        const priceMatch = text.match(/\$([0-9,]+)/);
        if (priceMatch) price = parseInt(priceMatch[1].replace(/,/g, ''), 10) || 0;
    }

    // Dealer
    let dealer = ldDealer;
    if (!dealer) {
        const dealerEl = document.querySelector('[class*="dealer-name"], .dealer-name, [data-qa="dealer-name"]');
        if (dealerEl) dealer = dealerEl.textContent.trim();
    }

    // Location
    const locMatch = text.match(/([A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5})/);
    const location = locMatch ? locMatch[1].trim() : '';

    return JSON.stringify({
        vin: vin.toUpperCase(),
        exteriorColor: ldExtColor || (extMatch ? extMatch[1].trim() : ''),
        interiorColor: ldIntColor || (intMatch ? intMatch[1].trim() : ''),
        price: price,
        mileage: mileage,
        dealer: dealer,
        location: location,
    });
})()
"""

# JS to check if search results are loaded
CHECK_RESULTS_JS = """
(() => {
    const links = document.querySelectorAll('a[href*="vehicledetail"]');
    return links.length;
})()
"""


async def is_blocked(page):
    """Check if the page is blocked/captcha'd."""
    title = await page.evaluate("document.title")
    if not title:
        return True
    blocked_signals = ["Access Denied", "Pardon Our Interruption", "Just a moment", "Checking your browser"]
    return any(s.lower() in title.lower() for s in blocked_signals)


async def human_scroll(page):
    """Aggressively scroll to bottom to trigger all lazy-loaded content."""
    try:
        # Get page height and scroll incrementally to bottom
        height = await page.evaluate("document.body.scrollHeight")
        current = 0
        while current < height:
            scroll_amount = random.randint(500, 1000)
            current += scroll_amount
            await page.evaluate(f"window.scrollTo(0, {current})")
            await asyncio.sleep(random.uniform(0.3, 0.6))
            # Check if height grew (infinite scroll)
            new_height = await page.evaluate("document.body.scrollHeight")
            if new_height > height:
                height = new_height

        # Final scroll to absolute bottom
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await asyncio.sleep(1)

        # Scroll back to top
        await page.evaluate("window.scrollTo(0, 0)")
        await asyncio.sleep(0.5)
    except Exception:
        pass


async def extract_search_listings(page, page_num):
    """Extract listings from the current search results page."""
    result = await page.evaluate(EXTRACT_SEARCH_JS)
    if not result:
        print(f"[Cars.com] No data extracted from page {page_num}", file=sys.stderr)
        return []

    try:
        items = json.loads(result)
        return items
    except (json.JSONDecodeError, TypeError):
        print(f"[Cars.com] Failed to parse search data on page {page_num}", file=sys.stderr)
        return []


async def fetch_detail_vin(browser, url, index, total):
    """Navigate to a detail page and extract VIN + colors."""
    try:
        page = await browser.get(url)
        await asyncio.sleep(random.uniform(3, 5))

        if await is_blocked(page):
            print(f"[Cars.com] Detail {index}/{total} blocked", file=sys.stderr)
            return None

        result = await page.evaluate(EXTRACT_DETAIL_JS)
        if not result:
            return None

        data = json.loads(result)
        if data.get("vin") and len(data["vin"]) == 17:
            return data
        return None
    except Exception as e:
        print(f"[Cars.com] Detail {index}/{total} error: {str(e)[:80]}", file=sys.stderr)
        return None


async def main():
    print("[Cars.com] Launching undetected Chrome...", file=sys.stderr)
    browser = await uc.start(headless=False)

    all_items = []
    max_pages = 5

    # --- Page 1 ---
    print(f"[Cars.com] Loading search page 1...", file=sys.stderr)
    page = await browser.get(SEARCH_URL)
    await asyncio.sleep(random.uniform(6, 10))

    if await is_blocked(page):
        print("[Cars.com] Blocked on page 1, waiting 30s...", file=sys.stderr)
        await asyncio.sleep(30)
        page = await browser.get(SEARCH_URL)
        await asyncio.sleep(random.uniform(6, 10))
        if await is_blocked(page):
            print("[Cars.com] Still blocked after retry, aborting", file=sys.stderr)
            browser.stop()
            print("__CARSCOM_RESULTS_START__")
            print("[]")
            print("__CARSCOM_RESULTS_END__")
            return

    # Wait for results to load, then scroll aggressively to trigger lazy loading
    await human_scroll(page)
    await asyncio.sleep(2)

    count = await page.evaluate(CHECK_RESULTS_JS)
    print(f"[Cars.com] Page 1: {count} vehicle links found (first pass)", file=sys.stderr)

    # Second scroll pass — Cars.com often needs multiple scrolls to load all
    if count < 40:
        await human_scroll(page)
        await asyncio.sleep(2)
        count2 = await page.evaluate(CHECK_RESULTS_JS)
        if count2 > count:
            print(f"[Cars.com] Page 1: {count2} links after second scroll", file=sys.stderr)
            count = count2

    if count == 0:
        # Try waiting longer
        await asyncio.sleep(5)
        count = await page.evaluate(CHECK_RESULTS_JS)
        print(f"[Cars.com] Page 1 (retry): {count} vehicle links found", file=sys.stderr)

    items = await extract_search_listings(page, 1)
    all_items.extend(items)
    print(f"[Cars.com] Page 1: {len(items)} listings extracted", file=sys.stderr)

    # Emit page results
    if items:
        print("__CARSCOM_PAGE_RESULTS__" + json.dumps(items) + "__END_PAGE__")
        sys.stdout.flush()

    # --- Pagination ---
    for page_num in range(2, max_pages + 1):
        if len(items) < 20:
            # Less than a full page, likely last page
            break

        await asyncio.sleep(random.uniform(3, 6))

        # Check for "Next" button
        next_js = """
        (() => {
            const next = document.querySelector('a[aria-label="Next"], a.next, [class*="next-page"]');
            if (!next) return 'none';
            next.scrollIntoView({behavior: 'smooth', block: 'center'});
            return next.href || 'found-no-href';
        })()
        """
        next_href = await page.evaluate(next_js)
        if next_href == "none" or next_href == "found-no-href":
            print(f"[Cars.com] No next page link, stopping after page {page_num - 1}", file=sys.stderr)
            break

        print(f"[Cars.com] Loading page {page_num}...", file=sys.stderr)
        page = await browser.get(next_href)
        await asyncio.sleep(random.uniform(4, 7))

        if await is_blocked(page):
            print(f"[Cars.com] Blocked on page {page_num}, stopping", file=sys.stderr)
            break

        await human_scroll(page)
        items = await extract_search_listings(page, page_num)
        all_items.extend(items)
        print(f"[Cars.com] Page {page_num}: {len(items)} listings (total: {len(all_items)})", file=sys.stderr)

        if items:
            print("__CARSCOM_PAGE_RESULTS__" + json.dumps(items) + "__END_PAGE__")
            sys.stdout.flush()

    print(f"[Cars.com] Search phase complete: {len(all_items)} listings", file=sys.stderr)

    if not all_items:
        browser.stop()
        print("__CARSCOM_RESULTS_START__")
        print("[]")
        print("__CARSCOM_RESULTS_END__")
        return

    # --- Detail phase: fetch VINs ---
    # Deduplicate by URL
    seen_urls = set()
    unique_items = []
    for item in all_items:
        if item["url"] not in seen_urls:
            seen_urls.add(item["url"])
            unique_items.append(item)

    detail_limit = min(len(unique_items), 60)
    print(f"[Cars.com] Fetching {detail_limit} detail pages for VINs...", file=sys.stderr)

    ok_count = 0
    fail_count = 0
    consecutive_fail = 0

    for i in range(detail_limit):
        item = unique_items[i]

        detail = await fetch_detail_vin(browser, item["url"], i + 1, detail_limit)
        if detail and detail.get("vin"):
            item["vin"] = detail["vin"]
            if detail.get("exteriorColor"):
                item["exteriorColor"] = detail["exteriorColor"]
            if detail.get("interiorColor"):
                item["interiorColor"] = detail["interiorColor"]
            if detail.get("price") and not item.get("price"):
                item["price"] = detail["price"]
            if detail.get("mileage") and not item.get("mileage"):
                item["mileage"] = detail["mileage"]
            if detail.get("dealer") and not item.get("dealer"):
                item["dealer"] = detail["dealer"]
            if detail.get("location") and not item.get("location"):
                item["location"] = detail["location"]
            ok_count += 1
            consecutive_fail = 0
        else:
            fail_count += 1
            consecutive_fail += 1

        if consecutive_fail >= 5:
            print(f"[Cars.com] 5 consecutive detail failures, stopping", file=sys.stderr)
            break

        if (i + 1) % 10 == 0:
            print(f"[Cars.com] Detail progress: {i + 1}/{detail_limit} (ok={ok_count}, fail={fail_count})", file=sys.stderr)

    print(f"[Cars.com] Detail pages: {ok_count} ok, {fail_count} failed", file=sys.stderr)

    browser.stop()

    # Build final results — only those with VINs
    final = [item for item in unique_items if item.get("vin") and len(item.get("vin", "")) == 17]

    # Log samples
    for item in final[:3]:
        print(
            f"  VIN={item.get('vin', '?')} ${item.get('price', 0):,} "
            f"{item.get('year', 0)} {item.get('trim', '')} "
            f"{item.get('mileage', 0):,}mi",
            file=sys.stderr,
        )

    print(f"[Cars.com] Done — {len(final)} listings with VINs ({len(unique_items)} total)", file=sys.stderr)
    print("__CARSCOM_RESULTS_START__")
    print(json.dumps(final))
    print("__CARSCOM_RESULTS_END__")


if __name__ == "__main__":
    asyncio.run(main())
