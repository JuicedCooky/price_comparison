// background.js — PriceBot Firefox Extension
// Ports all main.py logic to JS; state lives in browser.storage.local.

// ── Constants ────────────────────────────────────────────────────────────────

const PRICE_RE = /[\$£€¥]\s*[\d,]+\.?\d*|[\d,]+\.?\d*\s*[\$£€¥]/;

const STORE_REGISTRY_KEY  = 'storeRegistry';
const PAGE_CACHE_KEY      = 'pageCache';
const SEARCH_HISTORY_KEY  = 'searchHistory';

// ── Store registry (replaces STORE_REGISTRY dict + stores.json) ──────────────

async function getStoreRegistry() {
    const data = await browser.storage.local.get(STORE_REGISTRY_KEY);
    return data[STORE_REGISTRY_KEY] || {};
}

async function saveStoreRegistry(registry) {
    await browser.storage.local.set({ [STORE_REGISTRY_KEY]: registry });
}

// ── Page cache (replaces SQLite page_cache table) ────────────────────────────

async function cacheGet(key) {
    const data  = await browser.storage.local.get(PAGE_CACHE_KEY);
    const cache = data[PAGE_CACHE_KEY] || {};
    const entry = cache[key];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        delete cache[key];
        await browser.storage.local.set({ [PAGE_CACHE_KEY]: cache });
        return null;
    }
    return entry.content; // string
}

async function cacheSet(key, content, ttl = 3600) {
    const data  = await browser.storage.local.get(PAGE_CACHE_KEY);
    const cache = data[PAGE_CACHE_KEY] || {};
    cache[key] = {
        content,
        cachedAt:  Date.now(),
        expiresAt: Date.now() + ttl * 1000,
    };
    await browser.storage.local.set({ [PAGE_CACHE_KEY]: cache });
}

async function clearPageCache() {
    await browser.storage.local.set({ [PAGE_CACHE_KEY]: {} });
}

// ── Search history (replaces SQLite searches + search_results tables) ─────────

async function _getHistoryStore() {
    const data = await browser.storage.local.get(SEARCH_HISTORY_KEY);
    return data[SEARCH_HISTORY_KEY] || { searches: [], nextId: 1 };
}

async function saveSearchToDB(query, results) {
    const store = await _getHistoryStore();
    store.searches.unshift({
        id:           store.nextId,
        query,
        timestamp:    new Date().toISOString().replace('T', ' ').substring(0, 19),
        result_count: results.length,
        results,
    });
    store.nextId += 1;
    if (store.searches.length > 100) store.searches = store.searches.slice(0, 100);
    await browser.storage.local.set({ [SEARCH_HISTORY_KEY]: store });
}

async function getHistory(limit = 30) {
    const store = await _getHistoryStore();
    return store.searches.slice(0, limit).map(({ id, query, timestamp, result_count }) =>
        ({ id, query, timestamp, result_count })
    );
}

async function getHistoryResults(searchId) {
    const store  = await _getHistoryStore();
    const search = store.searches.find(s => s.id === searchId);
    if (!search) return null;
    return {
        search:  { id: search.id, query: search.query, timestamp: search.timestamp, result_count: search.result_count },
        results: search.results,
    };
}

async function clearHistory() {
    await browser.storage.local.set({ [SEARCH_HISTORY_KEY]: { searches: [], nextId: 1 } });
}

// ── Saved searches ─────────────────────────────────────────────────────────────

const SAVED_KEY = 'savedSearches';

async function getSaved() {
    const data  = await browser.storage.local.get(SAVED_KEY);
    const saved = data[SAVED_KEY] || [];
    return saved.map(({ id, query, timestamp, results }) =>
        ({ id, query, timestamp, result_count: (results || []).length })
    );
}

async function getSavedResults(id) {
    const data  = await browser.storage.local.get(SAVED_KEY);
    const saved = data[SAVED_KEY] || [];
    const entry = saved.find(s => s.id === id);
    return entry ? entry.results : null;
}

async function saveSearch(searchId) {
    const histStore = await _getHistoryStore();
    const entry     = histStore.searches.find(s => s.id === searchId);
    if (!entry) return { success: false, message: 'Search not found.' };

    const data  = await browser.storage.local.get(SAVED_KEY);
    const saved = data[SAVED_KEY] || [];
    if (saved.some(s => s.id === searchId)) return { success: false, message: 'Already saved.' };

    saved.unshift({ id: entry.id, query: entry.query, timestamp: entry.timestamp, results: entry.results || [] });
    await browser.storage.local.set({ [SAVED_KEY]: saved });
    return { success: true, message: 'Search saved!' };
}

async function removeSaved(id) {
    const data  = await browser.storage.local.get(SAVED_KEY);
    const saved = (data[SAVED_KEY] || []).filter(s => s.id !== id);
    await browser.storage.local.set({ [SAVED_KEY]: saved });
    return { success: true, message: 'Removed from saved.' };
}

async function clearSaved() {
    await browser.storage.local.set({ [SAVED_KEY]: [] });
}

// ── Cached HTTP fetch (replaces cached_scrape + cloudscraper) ─────────────────

async function cachedFetch(url, params = null, ttl = 3600) {
    // Build cache key (sorted params for stability)
    const queryStr = params
        ? '?' + new URLSearchParams(Object.entries(params).sort((a, b) => a[0] < b[0] ? -1 : 1))
        : '';
    const cacheKey = url + queryStr;

    const cached = await cacheGet(cacheKey);
    if (cached !== null) {
        console.log(`💾 Cache hit: ${cacheKey.substring(0, 100)}`);
        return { content: cached, status: 200, ok: true };
    }

    try {
        const fetchUrl = params ? url + '?' + new URLSearchParams(params) : url;
        const response = await fetch(fetchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
        });
        const text = await response.text();
        if (response.ok) {
            await cacheSet(cacheKey, text, ttl);
        }
        return { content: text, status: response.status, ok: response.ok };
    } catch (e) {
        console.error(`Fetch error for ${url}:`, e);
        return { content: '', status: 0, ok: false, error: e.message };
    }
}

// ── Structural selector heuristic (ports _structural_selector) ───────────────

function structuralSelector(doc) {
    const counts = {};

    for (const tag of doc.querySelectorAll('li, div, article, section')) {
        const classes = Array.from(tag.classList);
        if (!classes.length) continue;

        const classStr = classes.join(' ').toLowerCase();
        if (/cart|nav|menu|header|suggest|dropdown|popup/.test(classStr)) continue;

        const key = `${tag.tagName.toLowerCase()}.${classes[0]}`;
        if (!counts[key]) counts[key] = [];
        counts[key].push(tag);
    }

    let bestSel = null, bestScore = 0;

    for (const [sel, elements] of Object.entries(counts)) {
        if (elements.length < 3) continue;

        const sample   = elements.slice(0, 6);
        const hasLink  = sample.filter(el => el.querySelector('a[href]')).length;
        const hasPrice = sample.filter(el => PRICE_RE.test(el.textContent)).length;
        const hasImg   = sample.filter(el => el.querySelector('img')).length;

        if (hasLink < sample.length * 0.6 || hasPrice === 0) continue;

        const score = elements.length + hasPrice * 4 + hasImg * 2;
        if (score > bestScore) { bestScore = score; bestSel = sel; }
    }

    return bestSel;
}

// ── Selector lists (mirrors Python constants) ─────────────────────────────────

const CANDIDATE_CONTAINERS = [
    '[data-product-id]', '[data-product]', '[data-item-id]',
    '.product-item', '.product-card', '.product-tile', '.product-grid-item',
    '.grid__item', '.card--product', '.product-loop__item',
    'li.product', 'li.type-product', '.type-product', '.products .product',
    '.woocommerce-loop-product__link',
    '.product', '.product-block', '.productitem', '.product_item',
    '.product-wrapper', '.product-container',
    '.collection-item', '.item--product',
    '.search-result__item', '.search__result-item', '.search-result',
    'article.product', '.products-list__item',
];

const CANDIDATE_TITLES = [
    '[data-product-title]',
    '.product-item__title', '.product-card__title', '.product-card__name',
    '.product__title', '.product-title', '.product-name',
    '.card__title', '.card__heading',
    '.woocommerce-loop-product__title',
    'h2 a', 'h3 a', 'h4 a', 'h2', 'h3',
];

const CANDIDATE_PRICES = [
    '[data-product-price]',
    '.price__current', '.price-item--regular', '.price-item--sale',
    '.product-item__price', '.product-card__price',
    '.woocommerce-Price-amount', 'ins .amount', '.amount',
    '.price .money', '.price', '.money',
    '.product-price', '.sale-price', '.regular-price',
];

// ── HTML selector discovery (ports discover_html_selectors) ───────────────────

function _safeQS(root, sel) {
    try { return root.querySelector(sel); } catch { return null; }
}
function _safeQSA(root, sel) {
    try { return root.querySelectorAll(sel); } catch { return []; }
}

async function discoverHtmlSelectors(searchEndpoint, queryParam, ttl = 86400) {
    try {
        const res = await cachedFetch(searchEndpoint, { [queryParam]: 'mouse' }, ttl);
        if (!res.ok) return {};

        const parser = new DOMParser();
        const doc    = parser.parseFromString(res.content, 'text/html');

        // Nuke junk (mirrors Python's soup.decompose() calls)
        for (const el of doc.querySelectorAll('header, nav, footer')) el.remove();
        const JUNK_RE = /cart|nav|menu|header|suggest|dropdown|popup|sidebar|footer/i;
        for (const el of doc.querySelectorAll('[class]')) {
            if (JUNK_RE.test(el.getAttribute('class') || '')) el.remove();
        }
        for (const el of doc.querySelectorAll('[id]')) {
            if (JUNK_RE.test(el.getAttribute('id') || '')) el.remove();
        }

        // ── Pass 1: known selector list ───────────────────────────────────────
        let best = { score: 0, container: null, title: null, price: null };

        for (const cSel of CANDIDATE_CONTAINERS) {
            const items = _safeQSA(doc, cSel);
            if (items.length < 2) continue;

            const sample   = items[0];
            const titleSel = CANDIDATE_TITLES.find(s => _safeQS(sample, s)) || null;
            const priceSel = CANDIDATE_PRICES.find(s => _safeQS(sample, s)) || null;
            const score    = items.length + (titleSel ? 10 : 0) + (priceSel ? 10 : 0);

            if (score > best.score) {
                best = { score, container: cSel, title: titleSel, price: priceSel };
            }
        }

        if (best.container) {
            console.log(`✅ [pass-1] container=${best.container} | title=${best.title} | price=${best.price}`);
            return { container: best.container, title: best.title, price: best.price };
        }

        // ── Pass 2: structural heuristic ──────────────────────────────────────
        console.log('🔍 Known selectors failed — trying structural heuristic...');
        const cSel = structuralSelector(doc);

        if (!cSel) {
            console.warn(`⚠️ Selector auto-detection found no container at ${searchEndpoint}`);
            return {};
        }

        const items    = _safeQSA(doc, cSel);
        const sample   = items[0] || null;
        let titleSel = null, priceSel = null;

        if (sample) {
            titleSel = CANDIDATE_TITLES.find(s => _safeQS(sample, s)) || null;
            priceSel = CANDIDATE_PRICES.find(s => _safeQS(sample, s)) || null;

            // Sub-fallbacks
            if (!titleSel && _safeQS(sample, 'a[href]')) titleSel = 'a';
            if (!priceSel) {
                for (const el of sample.querySelectorAll('*')) {
                    if (PRICE_RE.test(el.textContent.trim())) {
                        const cls = Array.from(el.classList);
                        priceSel = cls.length
                            ? `${el.tagName.toLowerCase()}.${CSS.escape(cls[0])}`
                            : el.tagName.toLowerCase();
                        break;
                    }
                }
            }
        }

        console.log(`✅ [pass-2] container=${cSel} | title=${titleSel} | price=${priceSel}`);
        return { container: cSel, title: titleSel, price: priceSel };

    } catch (e) {
        console.error('Error fetching selectors:', e);
        return {};
    }
}

// ── Store discovery (ports discover_store_search_config) ─────────────────────

async function discoverStoreSearchConfig(baseUrl) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch { return null; }

    const cleanBase = `${parsed.protocol}//${parsed.hostname}`;

    // Exact search URL supplied (has query params)
    if (parsed.search) {
        const detectedParam = parsed.searchParams.keys().next().value || 'q';
        const endpoint      = `${cleanBase}${parsed.pathname}`;
        console.log(`🎯 Exact URL provided! Endpoint: ${endpoint} | Param: ${detectedParam}`);
        const selectors = await discoverHtmlSelectors(endpoint, detectedParam);
        return { store_url: cleanBase, type: 'html', search_endpoint: endpoint, query_param: detectedParam, selectors };
    }

    // ── Shopify: try suggest.json API ────────────────────────────────────────────
    try {
        const res = await cachedFetch(`${cleanBase}/search/suggest.json`, { q: 'test', 'resources[type]': 'product' }, 86400);
        if (res.ok) {
            const data = JSON.parse(res.content);
            if (data && data.resources) {
                console.log(`🛍️ Shopify (suggest.json) confirmed: ${cleanBase}`);
                return { store_url: cleanBase, type: 'shopify', search_endpoint: `${cleanBase}/search/suggest.json`, query_param: 'q' };
            }
        }
    } catch (_) {}

    // ── Homepage fetch (shared by Shopify HTML check + form scan) ─────────────
    let homepageDoc = null;
    try {
        const res = await cachedFetch(cleanBase, null, 86400);
        if (res.ok) {
            // Shopify marker check — catches stores that block suggest.json
            const isShopify = res.content.includes('cdn.shopify.com')
                           || res.content.includes('Shopify.theme')
                           || res.content.includes('/cdn/shop/')
                           || res.content.includes('shopify-section');
            if (isShopify) {
                console.log(`🛍️ Shopify (HTML marker) confirmed: ${cleanBase}`);
                return { store_url: cleanBase, type: 'shopify', search_endpoint: `${cleanBase}/search/suggest.json`, query_param: 'q' };
            }

            // Wix marker check — products live in wix-warmup-data JSON, not DOM
            const isWix = res.content.includes('wix-warmup-data')
                       || res.content.includes('wix-thunderbolt')
                       || res.content.includes('parastorage.com');
            if (isWix) {
                console.log(`🏗️ Wix site detected: ${cleanBase}`);
                return { store_url: cleanBase, type: 'wix', search_endpoint: `${cleanBase}/search`, query_param: 'q' };
            }

            homepageDoc = new DOMParser().parseFromString(res.content, 'text/html');
        }
    } catch (_) {}

    // ── HTML form detection ───────────────────────────────────────────────────
    if (homepageDoc) {
        for (const form of homepageDoc.querySelectorAll('form')) {
            const action = form.getAttribute('action') || '';
            for (const inp of form.querySelectorAll('input')) {
                const name      = inp.getAttribute('name') || '';
                const inputType = (inp.getAttribute('type') || '').toLowerCase();
                const isSearch  = ['q', 's', 'search', 'query', 'keyword', 'keywords'].includes(name)
                    || inputType === 'search'
                    || action.toLowerCase().includes('search');
                if (isSearch && name) {
                    let endpoint;
                    try { endpoint = new URL(action, cleanBase).href; } catch { endpoint = `${cleanBase}${action}`; }
                    const selectors = await discoverHtmlSelectors(endpoint, name);
                    return { store_url: cleanBase, type: 'html', search_endpoint: endpoint, query_param: name, selectors };
                }
            }
        }
    }

    // Default /search fallback
    const endpoint  = `${cleanBase}/search`;
    const selectors = await discoverHtmlSelectors(endpoint, 'q');
    return { store_url: cleanBase, type: 'html', search_endpoint: endpoint, query_param: 'q', selectors };
}

// ── Single-store fetch (shared by searchPrices and searchStore) ───────────────

async function _fetchStoreResults(baseUrl, config, query) {
    const payload = { [config.query_param]: query };
    const results = [];
    let error = null;

    if (config.type === 'shopify') {
        payload['resources[type]'] = 'product';
        try {
            const res = await cachedFetch(config.search_endpoint, payload, 900);
            if (res.ok) {
                const data     = JSON.parse(res.content);
                const products = data?.resources?.results?.products || [];
                for (const prod of products) {
                    const raw   = prod.price || 0;
                    const price = raw ? `$${parseFloat(raw).toFixed(2)}` : 'N/A';
                    results.push({ store: baseUrl, product: prod.title, price, url: `${baseUrl}${prod.url}` });
                }
            } else {
                error = `Request failed (HTTP ${res.status})`;
            }
        } catch (e) {
            error = `Request error: ${e.message}`;
        }

    } else if (config.type === 'wix') {
        // Wix sites inject all search results into a <script id="wix-warmup-data"> JSON blob.
        // The rendered DOM cards are JS-only — fetch() sees them as empty, so we read the JSON instead.
        try {
            const res = await cachedFetch(config.search_endpoint, { [config.query_param]: query }, 900);
            if (!res.ok) {
                error = `Request failed (HTTP ${res.status})`;
            } else {
                const match = res.content.match(/<script[^>]+id="wix-warmup-data"[^>]*>([\s\S]*?)<\/script>/);
                if (!match) {
                    error = 'Wix warmup data not found — page may require JS rendering';
                } else {
                    const warmup    = JSON.parse(match[1]);
                    const appsData  = warmup.appsWarmupData || {};
                    let found = false;

                    for (const appData of Object.values(appsData)) {
                        // Full search results (preferred)
                        const searchResp = appData['search:SearchResponse'];
                        if (searchResp && Array.isArray(searchResp.documents)) {
                            found = true;
                            for (const doc of searchResp.documents) {
                                if (!doc.documentType || !doc.documentType.includes('stores/products')) continue;
                                results.push({
                                    store:   baseUrl,
                                    product: doc.title,
                                    price:   doc.price || 'N/A',
                                    url:     doc.url || (baseUrl + (doc.relativeUrl || '')),
                                });
                            }
                            break;
                        }

                        // Fallback: sample/autocomplete response
                        const samplesResp = appData['search:SamplesResponse'];
                        if (samplesResp && Array.isArray(samplesResp.results)) {
                            found = true;
                            for (const bucket of samplesResp.results) {
                                if (!bucket.documentType || !bucket.documentType.includes('stores/products')) continue;
                                for (const doc of bucket.documents || []) {
                                    results.push({
                                        store:   baseUrl,
                                        product: doc.title,
                                        price:   doc.price || 'N/A',
                                        url:     doc.url || (baseUrl + (doc.relativeUrl || '')),
                                    });
                                }
                            }
                            break;
                        }
                    }

                    if (!found) error = 'No product data found in Wix warmup JSON';
                }
            }
        } catch (e) {
            error = `Wix scrape error: ${e.message}`;
        }

    } else if (config.type === 'html') {
        const { container: cSel, title: titleSel, price: priceSel } = config.selectors || {};
        if (!cSel) {
            error = 'No product selectors found — try re-adding with a direct search URL';
        } else {
            try {
                const res = await cachedFetch(config.search_endpoint, payload, 900);
                if (!res.ok) {
                    error = `Request failed (HTTP ${res.status})`;
                } else {
                    const doc   = new DOMParser().parseFromString(res.content, 'text/html');
                    const items = _safeQSA(doc, cSel);
                    for (const item of items) {
                        const titleEl = titleSel ? _safeQS(item, titleSel) : null;
                        const priceEl = priceSel ? _safeQS(item, priceSel) : null;
                        const linkEl  = _safeQS(item, 'a[href]');
                        const title   = titleEl
                            ? titleEl.textContent.trim()
                            : item.textContent.replace(/\s+/g, ' ').trim().substring(0, 80);
                        const price = priceEl ? priceEl.textContent.trim() : 'N/A';
                        const href  = linkEl ? linkEl.getAttribute('href') : null;
                        let url = baseUrl;
                        if (href) { try { url = new URL(href, baseUrl).href; } catch { url = href; } }
                        if (title) results.push({ store: baseUrl, product: title, price, url });
                    }
                }
            } catch (e) {
                error = `Scrape error: ${e.message}`;
            }
        }
    }

    return { results, error };
}

// ── Search all stores ─────────────────────────────────────────────────────────

async function searchPrices(query) {
    const registry          = await getStoreRegistry();
    const aggregatedResults = [];
    const storeStatuses     = {};

    for (const [baseUrl, config] of Object.entries(registry)) {
        const { results, error } = await _fetchStoreResults(baseUrl, config, query);
        storeStatuses[baseUrl] = { error };
        aggregatedResults.push(...results);
    }

    await saveSearchToDB(query, aggregatedResults);
    return { results: aggregatedResults, store_statuses: storeStatuses };
}

// ── Message router ────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg) => {
    // Must return a Promise for async responses
    switch (msg.action) {

        case 'listStores':
            return getStoreRegistry().then(reg => ({ stores: Object.keys(reg) }));

        case 'addStore': {
            return (async () => {
                let storeUrl = (msg.url || '').trim();
                if (!storeUrl.startsWith('http://') && !storeUrl.startsWith('https://')) {
                    storeUrl = 'https://' + storeUrl;
                }
                let parsed;
                try { parsed = new URL(storeUrl); } catch {
                    return { success: false, message: 'Invalid URL — could not parse a domain.' };
                }
                const cleanUrl = `${parsed.protocol}//${parsed.hostname}`;
                const registry = await getStoreRegistry();

                if (registry[cleanUrl]) {
                    return { success: false, message: 'Store is already tracked!' };
                }

                const config = await discoverStoreSearchConfig(storeUrl);
                if (!config) return { success: false, message: 'Could not analyze this URL.' };

                registry[config.store_url] = config;
                await saveStoreRegistry(registry);
                return { success: true, message: `Successfully mapped and saved: ${config.store_url}` };
            })();
        }

        case 'removeStore': {
            return (async () => {
                const registry = await getStoreRegistry();
                if (!registry[msg.url]) return { success: false, message: 'Store target not found.' };
                delete registry[msg.url];
                await saveStoreRegistry(registry);
                return { success: true, message: 'Store successfully deleted.' };
            })();
        }

        case 'reparseStore': {
            return (async () => {
                const registry = await getStoreRegistry();
                if (!registry[msg.url]) return { success: false, message: 'Store not found in registry.' };
                const config = await discoverStoreSearchConfig(msg.url);
                if (!config) return { success: false, message: 'Could not analyze this URL.' };
                registry[config.store_url] = config;
                await saveStoreRegistry(registry);
                return { success: true, message: `Re-parsed: ${config.type} · param: ${config.query_param}` };
            })();
        }

        case 'search':
            return searchPrices(msg.query);

        case 'searchStore': {
            return (async () => {
                const registry = await getStoreRegistry();
                const config   = registry[msg.storeUrl];
                if (!config) return { results: [], error: 'Store not found in registry.' };
                return await _fetchStoreResults(msg.storeUrl, config, msg.query);
            })();
        }

        case 'getHistory':
            return getHistory(msg.limit || 30).then(history => ({ history }));

        case 'getHistoryResults':
            return (async () => {
                const data = await getHistoryResults(msg.searchId);
                if (!data) return { success: false, message: 'Search ID not found.' };
                return { success: true, ...data };
            })();

        case 'clearHistory':
            return clearHistory().then(() => ({ success: true, message: 'Search history cleared.' }));

        case 'clearCache':
            return clearPageCache().then(() => ({ success: true, message: 'Page cache cleared.' }));

        case 'getSaved':
            return getSaved().then(saved => ({ saved }));

        case 'saveSearch':
            return saveSearch(msg.searchId);

        case 'removeSaved':
            return removeSaved(msg.id);

        case 'getSavedResults':
            return (async () => {
                const results = await getSavedResults(msg.id);
                if (results === null) return { success: false, message: 'Saved entry not found.' };
                return { success: true, results };
            })();

        case 'clearSaved':
            return clearSaved().then(() => ({ success: true, message: 'Saved searches cleared.' }));

        case 'saveProduct': {
            const { name, price, url } = msg.product || {};
            if (!name) return Promise.resolve({ success: false, message: 'No product name.' });
            let store;
            try { store = new URL(url).hostname; } catch { store = url || 'unknown'; }
            return saveSearchToDB(name, [{ store, product: name, price: price || 'N/A', url: url || '' }])
                .then(() => ({ success: true }));
        }

        default:
            return Promise.resolve({ success: false, message: `Unknown action: ${msg.action}` });
    }
});
