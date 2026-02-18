"""
Fetches Tesla used Model X inventory using nodriver (undetected Chrome).
Uses the inventory API v4 endpoint instead of DOM scraping for reliability.
nodriver handles Akamai Bot Manager; the browser's fetch calls the API.

Outputs JSON array of inventory items to stdout between markers.
"""

import nodriver as uc
import asyncio
import json
import sys


API_PATH = "/inventory/api/v4/inventory-results"

QUERY_TEMPLATE = {
    "query": {
        "model": "mx",
        "condition": "used",
        "options": {
            "Year": [2023, 2024, 2025, 2026]
        },
        "arrangeby": "Price",
        "order": "asc",
        "market": "US",
        "language": "en",
        "super_region": "north america",
        "lng": -87.6298,
        "lat": 41.8781,
        "zip": "60601",
        "range": 0,
    },
    "offset": 0,
    "count": 50,
    "outsideOffset": 0,
    "outsideSearch": False,
}


async def fetch_api_page(page, offset, count=50):
    """Fetch one page of inventory results via the browser's fetch."""
    query = json.loads(json.dumps(QUERY_TEMPLATE))
    query["offset"] = offset
    query["count"] = count
    query_json = json.dumps(query).replace("\\", "\\\\").replace("'", "\\'")

    js = f"""
    (async () => {{
        const url = '{API_PATH}?query=' + encodeURIComponent('{query_json}');
        const res = await fetch(url);
        if (!res.ok) return JSON.stringify({{error: res.status}});
        return await res.text();
    }})()
    """

    result = await page.send(
        uc.cdp.runtime.evaluate(
            expression=js,
            await_promise=True,
            return_by_value=True,
        )
    )

    if not result or not result[0] or not result[0].value:
        return None

    try:
        return json.loads(result[0].value)
    except (json.JSONDecodeError, TypeError):
        return None


async def main():
    print("[Tesla] Launching undetected Chrome...", file=sys.stderr)
    browser = await uc.start(headless=False)

    print("[Tesla] Navigating to tesla.com...", file=sys.stderr)
    page = await browser.get("https://www.tesla.com/inventory/used/mx")

    print("[Tesla] Waiting for Akamai challenge...", file=sys.stderr)
    await asyncio.sleep(8)

    title = await page.evaluate("document.title")
    print(f"[Tesla] Page title: {title}", file=sys.stderr)

    if not title:
        print("[Tesla] Empty title, waiting 15s more...", file=sys.stderr)
        await asyncio.sleep(15)
        title = await page.evaluate("document.title")
        print(f"[Tesla] Page title after retry: {title}", file=sys.stderr)

    if not title or "Access Denied" in title or "Pardon" in title:
        print("[Tesla] Blocked by Akamai", file=sys.stderr)
        browser.stop()
        print("__TESLA_RESULTS_START__\n[]\n__TESLA_RESULTS_END__")
        return

    # Fetch inventory via API with pagination
    all_listings = []
    offset = 0
    total = None
    batch_size = 50

    print("[Tesla] Fetching inventory via API (2023-2026 only)...", file=sys.stderr)

    while True:
        data = await fetch_api_page(page, offset, batch_size)

        if not data or "error" in data:
            err = data.get("error", "unknown") if data else "no response"
            print(f"[Tesla] API error at offset {offset}: {err}", file=sys.stderr)
            break

        if total is None:
            total_str = data.get("total_matches_found", "0")
            total = int(total_str) if total_str else 0
            print(f"[Tesla] Total matches: {total}", file=sys.stderr)

        results = data.get("results", [])
        if not results:
            break

        all_listings.extend(results)

        # Emit per-page results immediately for partial streaming
        print("__TESLA_PAGE_RESULTS__" + json.dumps(results) + "__END_PAGE__")
        sys.stdout.flush()

        print(
            f"[Tesla] Fetched offset {offset}: {len(results)} items "
            f"(total collected: {len(all_listings)}/{total})",
            file=sys.stderr,
        )

        offset += len(results)
        if offset >= total:
            break

        await asyncio.sleep(2)

    browser.stop()

    if not all_listings:
        print("[Tesla] 0 listings from API", file=sys.stderr)
        print("__TESLA_RESULTS_START__\n[]\n__TESLA_RESULTS_END__")
        return

    # Log samples
    for item in all_listings[:3]:
        vin = item.get("VIN", "?")
        price = item.get("Price", 0)
        year = item.get("Year", 0)
        miles = item.get("Odometer", 0)
        trim = item.get("TrimName", item.get("TRIM", ""))
        cabin = item.get("CABIN_CONFIG", [])
        history = item.get("VehicleHistory", "")
        print(
            f"  VIN={vin} ${price:,} {year} {trim} {miles:,}mi "
            f"Cabin={cabin} History={history}",
            file=sys.stderr,
        )

    print(f"[Tesla] Done — {len(all_listings)} listings", file=sys.stderr)
    print("__TESLA_RESULTS_START__")
    print(json.dumps(all_listings))
    print("__TESLA_RESULTS_END__")


if __name__ == "__main__":
    asyncio.run(main())
