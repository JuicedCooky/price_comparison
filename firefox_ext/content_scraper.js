// content_scraper.js — injected into the active tab via browser.tabs.executeScript.
// Must be a plain script file for MV2. The final expression value is the return value.

(function () {
    let name = null;
    let price = null;
    let isProduct = false;

    // 1. JSON-LD schema.org/Product
    const schemas = document.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < schemas.length; i++) {
        try {
            const d = JSON.parse(schemas[i].textContent);
            const items = Array.isArray(d) ? d : (d['@graph'] ? d['@graph'] : [d]);
            for (let j = 0; j < items.length; j++) {
                const it = items[j];
                if (it['@type'] === 'Product' || (Array.isArray(it['@type']) && it['@type'].includes('Product'))) {
                    isProduct = true;
                    if (it.name) name = it.name;
                    const off = it.offers;
                    if (off) {
                        const o = Array.isArray(off) ? off[0] : off;
                        if (o.price != null) price = (o.priceCurrency || '') + String(o.price);
                    }
                    break;
                }
            }
        } catch (e) {}
        if (isProduct) break;
    }

    // 2. OG type=product
    const ogType = document.querySelector('meta[property="og:type"]');
    if (ogType && /^product/i.test(ogType.getAttribute('content') || '')) isProduct = true;

    // 3. itemprop
    const ipName  = document.querySelector('[itemprop="name"]');
    const ipPrice = document.querySelector('[itemprop="price"]');
    if (ipName || ipPrice) isProduct = true;
    if (!name  && ipName)  name  = (ipName.getAttribute('content')  || ipName.textContent).trim();
    if (!price && ipPrice) price = (ipPrice.getAttribute('content') || ipPrice.textContent).trim();

    // 4. OG title / price fallback
    if (!name) {
        const ogT = document.querySelector('meta[property="og:title"]');
        if (ogT) name = (ogT.getAttribute('content') || '').trim();
    }
    if (!price) {
        const ogP = document.querySelector('meta[property="og:price:amount"],meta[property="product:price:amount"]');
        if (ogP) {
            const amt = (ogP.getAttribute('content') || '').trim();
            const cur = document.querySelector('meta[property="og:price:currency"],meta[property="product:price:currency"]');
            price = cur ? (cur.getAttribute('content') || '') + ' ' + amt : amt;
        }
    }

    // 5. URL heuristic fallback
    if (!isProduct && /\/(product|products|item|items|p|pd|detail|shop)[\/-]/i.test(location.pathname)) isProduct = true;

    // 6. H1 name fallback
    if (!name) {
        const h1 = document.querySelector('h1');
        if (h1) name = h1.textContent.trim();
    }

    // 7. Price regex fallback
    if (!price) {
        const re = /[\$£€¥]\s*[\d,]+\.?\d*|[\d,]+\.?\d*\s*[\$£€¥]/;
        const els = document.querySelectorAll('[class*="price"],[id*="price"],[itemprop="price"],.price,.sale-price');
        for (let k = 0; k < els.length; k++) {
            const m = re.exec(els[k].textContent);
            if (m) { price = m[0].trim(); break; }
        }
    }

    return { isProduct: isProduct, name: name || document.title, price: price, url: location.href };
})();
