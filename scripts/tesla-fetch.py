"""
Fetches Tesla used Model X inventory using nodriver (undetected Chrome).
Loads the inventory page and extracts listing data from the rendered DOM.
Tesla's page loads all results at once (no pagination needed).

Outputs JSON array of inventory items to stdout between markers.
"""

import nodriver as uc
import asyncio
import json
import sys


EXTRACT_LISTINGS_JS = """
(() => {
    const articles = document.querySelectorAll('article.result.card');
    const listings = [];
    const seen = new Set();

    for (const article of articles) {
        const dataId = article.getAttribute('data-id') || '';
        // VIN is the first part of data-id: "7SAXCBE69PF389476-search-result-container"
        const vinMatch = dataId.match(/^([A-HJ-NPR-Z0-9]{17})/);
        if (!vinMatch) continue;
        const vin = vinMatch[1];
        if (seen.has(vin)) continue;
        seen.add(vin);

        const text = article.innerText || '';

        // Price: Tesla shows "Est $578/mo financing · $36,600"
        // The actual price is the largest dollar amount in the card
        const allPrices = [];
        const priceRegex = /\\$(\\d{1,3}(?:,\\d{3})*)/g;
        let m;
        while ((m = priceRegex.exec(text)) !== null) {
            allPrices.push(parseInt(m[1].replace(/,/g, '')));
        }
        // Filter out small amounts (monthly payments, discounts)
        // The listing price is typically > $10,000 for a used Model X
        const bigPrices = allPrices.filter(p => p >= 10000);
        const price = bigPrices.length > 0 ? Math.min(...bigPrices) : (allPrices.length > 0 ? Math.max(...allPrices) : 0);

        // Year and mileage: "2020 Pre-Owned Vehicle with 93,083 mi"
        const yearMileMatch = text.match(/(\\d{4})\\s+Pre-Owned\\s+Vehicle\\s+with\\s+([\\d,]+)\\s*mi/);
        const year = yearMileMatch ? parseInt(yearMileMatch[1]) : 0;
        const mileage = yearMileMatch ? parseInt(yearMileMatch[2].replace(/,/g, '')) : 0;

        // Location: "Located in Mount Kisco"
        const locMatch = text.match(/Located in\\s+(.+?)(?:\\n|$)/);
        const location = locMatch ? locMatch[1].trim() : '';

        // Trim: Plaid, Performance, Long Range Plus, Long Range
        let trim = '';
        // Match the first trim word that appears in the text (appears as a heading)
        const trimMatch = text.match(/(?:^|\\n)\\s*(Plaid|Performance|Long Range Plus|Long Range)\\s*(?:\\n|$)/m);
        if (trimMatch) {
            trim = trimMatch[1];
        } else {
            if (text.includes('Plaid')) trim = 'Plaid';
            else if (text.includes('Performance')) trim = 'Performance';
            else if (text.includes('Long Range Plus')) trim = 'Long Range Plus';
            else if (text.includes('Long Range')) trim = 'Long Range';
        }

        // Seats: "5 Seats" or "6 Seats" or "7 Seats"
        const seatMatch = text.match(/(\\d+)\\s*Seats?/);
        const seatCount = seatMatch ? parseInt(seatMatch[1]) : null;

        // Image URL — prefer compositor URL (has option codes embedded)
        let imageUrl = null;
        const allImgs = article.querySelectorAll('img');
        for (const img of allImgs) {
            const src = img.src || img.getAttribute('data-src') || '';
            if (src.includes('compositor') || src.includes('static-assets.tesla')) {
                imageUrl = src;
                break;
            }
        }
        // Skip base64 data URIs
        if (imageUrl && imageUrl.startsWith('data:')) imageUrl = null;

        // Extract option codes from compositor URL
        // Format: options=$MDLX,$MTX06,$PPSW,$WTUT,$INBC3P,...
        let optionCodes = [];
        if (imageUrl) {
            const optMatch = imageUrl.match(/options=([^&]+)/);
            if (optMatch) {
                optionCodes = optMatch[1].split(',').map(c => c.trim());
            }
        }

        // URL: Tesla order page
        const url = 'https://www.tesla.com/mx/order/' + vin;

        listings.push({
            VIN: vin,
            Price: price,
            Odometer: mileage,
            Year: year,
            TRIM: trim,
            City: location,
            seatCount: seatCount,
            imageUrl: imageUrl,
            TitleStatus: 'CLEAN',
            OptionCodeList: optionCodes
        });
    }
    return JSON.stringify(listings);
})()
"""


async def main():
    print("[Tesla] Launching undetected Chrome...", file=sys.stderr)
    browser = await uc.start(headless=False)

    print("[Tesla] Navigating to inventory page...", file=sys.stderr)
    page = await browser.get("https://www.tesla.com/inventory/used/mx")

    print("[Tesla] Waiting for page to load...", file=sys.stderr)
    await asyncio.sleep(12)

    title = await page.evaluate("document.title")
    print(f"[Tesla] Page title: {title}", file=sys.stderr)

    if not title or "Access Denied" in title or "Pardon" in title:
        print("[Tesla] Blocked by Akamai", file=sys.stderr)
        browser.stop()
        print("__TESLA_RESULTS_START__\n[]\n__TESLA_RESULTS_END__")
        return

    # Count articles to confirm data loaded
    article_count = await page.evaluate("document.querySelectorAll('article.result.card').length")
    print(f"[Tesla] Article elements: {article_count}", file=sys.stderr)

    if not article_count or article_count == 0:
        # Page loaded but no results — might need more wait time
        print("[Tesla] No articles found, waiting longer...", file=sys.stderr)
        await asyncio.sleep(10)
        article_count = await page.evaluate("document.querySelectorAll('article.result.card').length")
        print(f"[Tesla] After extra wait: {article_count} articles", file=sys.stderr)

    # Extract listings from DOM
    listings_json = await page.evaluate(EXTRACT_LISTINGS_JS)

    browser.stop()

    if not listings_json:
        print("[Tesla] Failed to extract listings from DOM", file=sys.stderr)
        print("__TESLA_RESULTS_START__\n[]\n__TESLA_RESULTS_END__")
        return

    listings = json.loads(listings_json)
    print(f"[Tesla] Extracted {len(listings)} listings", file=sys.stderr)

    # Log a few samples
    for l in listings[:3]:
        print(
            f"  VIN={l['VIN']} Price=${l['Price']:,} Year={l['Year']} "
            f"Miles={l['Odometer']:,} Trim={l['TRIM']} Seats={l.get('seatCount')} "
            f"City={l['City']}",
            file=sys.stderr,
        )

    print(f"[Tesla] Done — {len(listings)} listings", file=sys.stderr)
    print("__TESLA_RESULTS_START__")
    print(json.dumps(listings))
    print("__TESLA_RESULTS_END__")


if __name__ == "__main__":
    asyncio.run(main())
