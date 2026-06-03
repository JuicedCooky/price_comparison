// popup.js — PriceBot UI logic
// All API calls route through browser.runtime.sendMessage() to background.js.
// NO inline event handlers — Firefox extension CSP blocks onclick="..." attributes.

// ── Filter state ─────────────────────────────────────────────────────────────

const filterState = {
    search:  { include: [], exclude: [] },
    history: { include: [], exclude: [] },
    saved:   { include: [], exclude: [] },
};

let lastSearchData      = null;  // { results, store_statuses, query }
let lastHistoryExpanded = null;  // { id, results, query }
let lastSavedExpanded   = null;  // { id, results, query }
let currentPageProduct  = null;  // { name, price, url } detected from active tab
let currentTabUrl       = null;  // raw URL of the active tab



// ── Initialise all event listeners on DOM ready ───────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

    // Sidebar tab buttons
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab, btn));
    });

    // Add store button + Enter key on input
    document.getElementById('addStoreBtn').addEventListener('click', addStore);
    document.getElementById('storeUrl').addEventListener('keydown', e => {
        if (e.key === 'Enter') addStore();
    });

    // Search button + Enter key on input
    document.getElementById('searchBtn').addEventListener('click', () => searchPrices());
    document.getElementById('searchQuery').addEventListener('keydown', e => {
        if (e.key === 'Enter') searchPrices();
    });

    // Clear history / clear cache / clear saved buttons
    document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);
    document.getElementById('clearCacheBtn').addEventListener('click', clearCache);
    document.getElementById('clearSavedBtn').addEventListener('click', clearSaved);

    // Tag-box click → focus the hidden input inside it
    document.querySelectorAll('.tag-box').forEach(box => {
        box.addEventListener('click', () => {
            const input = box.querySelector('.tag-input');
            if (input) input.focus();
        });
    });

    // Tag inputs — Enter/comma adds a tag, Backspace removes last tag
    [
        ['taginput-search-include',  'search',  'include'],
        ['taginput-search-exclude',  'search',  'exclude'],
        ['taginput-history-include', 'history', 'include'],
        ['taginput-history-exclude', 'history', 'exclude'],
        ['taginput-saved-include',   'saved',   'include'],
        ['taginput-saved-exclude',   'saved',   'exclude'],
    ].forEach(([id, panel, type]) => {
        document.getElementById(id).addEventListener('keydown', e => handleTagInput(e, panel, type));
    });

    // Event delegation: delete and re-parse buttons inside #storeList
    document.getElementById('storeList').addEventListener('click', e => {
        const del = e.target.closest('.delete-btn[data-url]');
        if (del) { removeStore(del.dataset.url); return; }
        const re = e.target.closest('.reparse-btn[data-url]');
        if (re) reparseStore(re.dataset.url, re);
    });

    // Current page buttons
    document.getElementById('cpSearchBtn').addEventListener('click', () => {
        if (!currentPageProduct) {
            setCpError('No product detected on this page.');
            return;
        }
        document.getElementById('searchQuery').value = currentPageProduct.name;
        document.getElementById('searchQuery').focus();
    });
    document.getElementById('cpAddStoreBtn').addEventListener('click', () => addCurrentPageStore());

    fetchTrackedStores();
    detectCurrentPage();
});

// ── Tag / filter helpers ──────────────────────────────────────────────────────

function handleTagInput(event, panel, type) {
    const input = event.target;
    const raw   = input.value.trim().replace(/,+$/, '');

    if ((event.key === 'Enter' || event.key === ',') && raw) {
        event.preventDefault();
        addTag(panel, type, raw);
        input.value = '';
    } else if (event.key === 'Backspace' && input.value === '') {
        const arr = filterState[panel][type];
        if (arr.length) { arr.pop(); renderTags(panel, type); }
    }
}

function addTag(panel, type, word) {
    const w = word.trim().toLowerCase();
    if (!w || filterState[panel][type].includes(w)) return;
    filterState[panel][type].push(w);
    renderTags(panel, type);
    updateFilterCardStyle(panel);
    reRenderPanel(panel);
}

function removeTag(panel, type, word) {
    filterState[panel][type] = filterState[panel][type].filter(w => w !== word);
    renderTags(panel, type);
    updateFilterCardStyle(panel);
    reRenderPanel(panel);
}

function renderTags(panel, type) {
    const container = document.getElementById(`tags-${panel}-${type}`);
    container.innerHTML = '';
    filterState[panel][type].forEach(word => {
        const tag = document.createElement('span');
        tag.className = `tag tag-${type}`;

        const label = document.createTextNode(word);
        tag.appendChild(label);

        const x = document.createElement('span');
        x.className   = 'tag-x';
        x.textContent = ' ×';
        x.addEventListener('click', e => {
            e.stopPropagation();
            removeTag(panel, type, word);
        });
        tag.appendChild(x);
        container.appendChild(tag);
    });
}

function updateFilterCardStyle(panel) {
    const card   = document.getElementById(`filter-card-${panel}`);
    const hasAny = filterState[panel].include.length || filterState[panel].exclude.length;
    card.classList.toggle('has-filters', !!hasAny);
}

function applyFilters(results, panel) {
    const inc = filterState[panel].include;
    const exc = filterState[panel].exclude;
    if (!inc.length && !exc.length) return results;
    return results.filter(item => {
        const name = (item.product || '').toLowerCase();
        if (inc.length && !inc.every(w => name.includes(w))) return false;
        if (exc.some(w => name.includes(w))) return false;
        return true;
    });
}

function reRenderPanel(panel) {
    if (panel === 'search' && lastSearchData) {
        renderResultColumns(
            document.getElementById('resultsBox'),
            lastSearchData.results,
            lastSearchData.store_statuses,
            'search',
            lastSearchData.query
        );
    } else if (panel === 'history' && lastHistoryExpanded) {
        const { id, query, results } = lastHistoryExpanded;
        const resultsDiv = document.getElementById(`hist-results-${id}`);
        if (!resultsDiv) return;
        const filtered = applyFilters(results, 'history');
        resultsDiv.innerHTML = '';
        if (!filtered.length) {
            resultsDiv.innerHTML = "<p style='color:gray;font-size:12px;'>No results match the current filters.</p>";
            return;
        }
        const byStore = groupByStore(filtered);
        Object.entries(byStore).forEach(([store, items]) => {
            resultsDiv.appendChild(buildStoreColumn(store, items, null, query, 'newsearch'));
        });
    } else if (panel === 'saved' && lastSavedExpanded) {
        const { id, query, results } = lastSavedExpanded;
        const resultsDiv = document.getElementById(`saved-results-${id}`);
        if (!resultsDiv) return;
        const filtered = applyFilters(results, 'saved');
        resultsDiv.innerHTML = '';
        if (!filtered.length) {
            resultsDiv.innerHTML = "<p style='color:gray;font-size:12px;'>No results match the current filters.</p>";
            return;
        }
        const byStore = groupByStore(filtered);
        Object.entries(byStore).forEach(([store, items]) => {
            resultsDiv.appendChild(buildStoreColumn(store, items, null, query, 'newsearch'));
        });
    }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(name, btn) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('panel-' + name).classList.add('active');
    btn.classList.add('active');
    if (name === 'history') fetchHistory();
    if (name === 'saved') fetchSaved();
}

// ── Status helper ─────────────────────────────────────────────────────────────

function setStatus(msg, color = '#0057b8') {
    const bar       = document.getElementById('statusBar');
    bar.style.color = color;
    bar.textContent = msg;
}

// ── Store management ──────────────────────────────────────────────────────────

async function fetchTrackedStores() {
    const data = await browser.runtime.sendMessage({ action: 'listStores' });
    const list = document.getElementById('storeList');

    if (!data.stores.length) {
        list.innerHTML = "<p style='color:gray;font-size:13px;'>No stores tracked yet. Add one above!</p>";
        return;
    }

    list.innerHTML = '';
    data.stores.forEach(url => {
        const row = document.createElement('div');
        row.className = 'store-item';

        const label = document.createElement('span');
        label.style.fontSize = '13px';
        label.textContent = '🌐 ' + url;

        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display:flex;gap:5px;flex-shrink:0;';

        const reBtn = document.createElement('button');
        reBtn.className       = 'action-btn reparse-btn';
        reBtn.dataset.url     = url;
        reBtn.textContent     = '🔄 Re-parse';
        reBtn.title           = 'Re-run search endpoint detection for this store';
        reBtn.style.cssText   = 'font-size:12px;padding:4px 9px;background:#555;';

        const delBtn = document.createElement('button');
        delBtn.className   = 'delete-btn';
        delBtn.dataset.url = url;
        delBtn.textContent = 'Remove';

        btnGroup.appendChild(reBtn);
        btnGroup.appendChild(delBtn);
        row.appendChild(label);
        row.appendChild(btnGroup);
        list.appendChild(row);
    });
}

async function addStore() {
    const url = document.getElementById('storeUrl').value.trim();
    if (!url) return;
    setStatus('🔍 Analyzing domain structure and saving...');
    const data = await browser.runtime.sendMessage({ action: 'addStore', url });
    setStatus(data.message, data.success ? '#1a7a1a' : '#a00');
    document.getElementById('storeUrl').value = '';
    fetchTrackedStores();
}

async function removeStore(url) {
    if (!confirm(`Stop tracking and delete ${url}?`)) return;
    const data = await browser.runtime.sendMessage({ action: 'removeStore', url });
    alert(data.message);
    fetchTrackedStores();
}

async function reparseStore(url, btn) {
    const orig     = btn.textContent;
    btn.textContent = '⏳';
    btn.disabled    = true;
    const data = await browser.runtime.sendMessage({ action: 'reparseStore', url });
    setStatus(data.message, data.success ? '#1a7a1a' : '#a00');
    btn.textContent = data.success ? '✓ Done' : '✗ Failed';
    setTimeout(() => {
        btn.textContent = orig;
        btn.disabled    = false;
    }, 2500);
}

// ── Search ────────────────────────────────────────────────────────────────────

async function searchPrices(overrideQuery) {
    const query = overrideQuery || document.getElementById('searchQuery').value.trim();
    if (!query) return;
    const box = document.getElementById('resultsBox');
    box.innerHTML = '<i style="font-size:13px;">Aggregating responses across live targets...</i>';
    const data = await browser.runtime.sendMessage({ action: 'search', query });
    lastSearchData = { ...data, query };
    renderResultColumns(box, data.results, data.store_statuses, 'search', query);
}

function groupByStore(results) {
    const byStore = {};
    results.forEach(item => {
        if (!byStore[item.store]) byStore[item.store] = [];
        byStore[item.store].push(item);
    });
    return byStore;
}

function buildProductEntry(item) {
    const entry = document.createElement('div');
    entry.className = 'product-entry';
    const title = document.createElement('div');
    title.textContent = item.product;
    const price = document.createElement('div');
    price.className = 'price';
    price.textContent = item.price;
    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.textContent = 'View Product →';
    entry.appendChild(title);
    entry.appendChild(price);
    entry.appendChild(link);
    return entry;
}

function buildStoreColumn(store, items, error, query, refineMode = 'store') {
    const col = document.createElement('div');
    col.className = 'store-column';

    // Header row
    const hdr = document.createElement('div');
    hdr.className = error ? 'store-column-header has-error' : 'store-column-header';
    hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

    const hdrText = document.createElement('span');
    const count = error ? 'error' : `${items.length} result${items.length !== 1 ? 's' : ''}`;
    hdrText.textContent = `${error ? '⚠️' : '🏪'} ${store} (${count})`;
    hdr.appendChild(hdrText);
    col.appendChild(hdr);

    // Per-store refine (only when a query exists and no error)
    if (query && !error) {
        const refineBtn = document.createElement('button');
        refineBtn.textContent = '✏️';
        refineBtn.title = 'Refine search for this store';
        refineBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:13px;padding:0 2px;opacity:0.55;flex-shrink:0;line-height:1;';
        hdr.appendChild(refineBtn);

        const refineRow = document.createElement('div');
        refineRow.style.cssText = 'display:none;padding:5px 8px;background:#222;gap:5px;align-items:center;border-bottom:1px solid #3a3a3a;';

        const refineInput = document.createElement('input');
        refineInput.type = 'text';
        refineInput.value = query;
        refineInput.style.cssText = 'flex:1;font-size:12px;padding:3px 7px;border:1px solid #555;background:#1a1a1a;color:#fff;border-radius:3px;min-width:0;outline:none;';

        const goBtn = document.createElement('button');
        goBtn.textContent = 'Search';
        goBtn.className = 'action-btn';
        goBtn.style.cssText = 'font-size:11px;padding:3px 9px;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = '✕';
        cancelBtn.className = 'action-btn';
        cancelBtn.style.cssText = 'font-size:11px;padding:3px 8px;background:#555;';

        refineRow.appendChild(refineInput);
        refineRow.appendChild(goBtn);
        refineRow.appendChild(cancelBtn);
        col.appendChild(refineRow);

        const showRefine = () => {
            refineRow.style.display = 'flex';
            refineBtn.style.opacity = '1';
            refineInput.focus();
            refineInput.select();
        };
        const hideRefine = () => {
            refineRow.style.display = 'none';
            refineBtn.style.opacity = '0.55';
        };
        const doRefine = async () => {
            const q = refineInput.value.trim();
            if (!q) return;
            hideRefine();

            if (refineMode === 'newsearch') {
                const searchTabBtn = document.getElementById('tab-search');
                switchTab('search', searchTabBtn);
                document.getElementById('searchQuery').value = q;
                searchPrices(q);
                return;
            }

            // 'store' mode: refine this store in-place
            while (col.lastChild !== refineRow) col.removeChild(col.lastChild);
            const loading = document.createElement('div');
            loading.style.cssText = 'padding:10px 12px;font-size:12px;color:#888;font-style:italic;';
            loading.textContent = 'Searching…';
            col.appendChild(loading);

            const result = await browser.runtime.sendMessage({ action: 'searchStore', storeUrl: store, query: q });

            while (col.lastChild !== refineRow) col.removeChild(col.lastChild);

            const newItems = result.results || [];
            const newError = result.error  || null;
            hdr.className = newError ? 'store-column-header has-error' : 'store-column-header';
            hdrText.textContent = `${newError ? '⚠️' : '🏪'} ${store} (${newError ? 'error' : `${newItems.length} result${newItems.length !== 1 ? 's' : ''}`})`;

            if (newError) {
                const d = document.createElement('div');
                d.className = 'store-error'; d.textContent = newError;
                col.appendChild(d);
            } else if (!newItems.length) {
                const d = document.createElement('div');
                d.className = 'store-empty'; d.textContent = 'No results found.';
                col.appendChild(d);
            } else {
                newItems.forEach(item => col.appendChild(buildProductEntry(item)));
            }
        };

        refineBtn.addEventListener('click', showRefine);
        cancelBtn.addEventListener('click', hideRefine);
        goBtn.addEventListener('click', doRefine);
        refineInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') doRefine();
            if (e.key === 'Escape') hideRefine();
        });
    }

    // Content
    if (error) {
        const d = document.createElement('div');
        d.className = 'store-error'; d.textContent = error;
        col.appendChild(d);
    } else if (!items.length) {
        const d = document.createElement('div');
        d.className = 'store-empty'; d.textContent = 'No results match the current filters.';
        col.appendChild(d);
    } else {
        items.forEach(item => col.appendChild(buildProductEntry(item)));
    }
    return col;
}

function renderResultColumns(container, results, statuses, panel, query) {
    container.innerHTML = '';
    const allStores = Object.keys(statuses || {});
    if (!allStores.length) {
        container.innerHTML = "<p style='color:#888;font-size:13px;'>No stores are currently tracked.</p>";
        return;
    }
    const filtered = applyFilters(results || [], panel);
    const byStore  = groupByStore(filtered);
    allStores.forEach(store => {
        const error = (statuses[store] || {}).error;
        container.appendChild(buildStoreColumn(store, byStore[store] || [], error, query));
    });
}

// ── History ───────────────────────────────────────────────────────────────────

async function fetchHistory() {
    const data = await browser.runtime.sendMessage({ action: 'getHistory', limit: 50 });
    const list = document.getElementById('historyList');

    if (!data.history.length) {
        list.innerHTML = "<p style='color:gray;font-size:13px;'>No searches recorded yet.</p>";
        return;
    }

    list.innerHTML = '';
    data.history.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.id        = `hist-${entry.id}`;

        // Left: all text content
        const contentDiv = document.createElement('div');
        contentDiv.className = 'history-item-content';

        const top = document.createElement('div');
        top.className = 'history-item-top';

        const q = document.createElement('span');
        q.className   = 'history-query';
        q.textContent = `🔍 ${entry.query}`;

        const badge = document.createElement('span');
        badge.className   = 'history-badge';
        badge.textContent = `${entry.result_count} result${entry.result_count !== 1 ? 's' : ''}`;

        top.appendChild(q);
        top.appendChild(badge);

        const time = document.createElement('div');
        time.className   = 'history-time';
        time.textContent = entry.timestamp;

        const resultsDiv = document.createElement('div');
        resultsDiv.className = 'history-results';
        resultsDiv.id        = `hist-results-${entry.id}`;

        contentDiv.appendChild(top);
        contentDiv.appendChild(time);
        contentDiv.appendChild(resultsDiv);

        // Right: full-height save button
        const saveBtn = document.createElement('button');
        saveBtn.className   = 'history-save-btn';
        saveBtn.textContent = '⭐ Save';
        saveBtn.title       = 'Save to Saved Searches';
        saveBtn.addEventListener('click', e => {
            e.stopPropagation();
            saveHistoryEntry(entry.id, saveBtn);
        });

        item.appendChild(contentDiv);
        item.appendChild(saveBtn);
        item.addEventListener('click', () => toggleHistoryItem(entry.id));
        list.appendChild(item);
    });
}

async function toggleHistoryItem(id) {
    const item       = document.getElementById(`hist-${id}`);
    const resultsDiv = document.getElementById(`hist-results-${id}`);
    const wasOpen    = resultsDiv.classList.contains('open');

    document.querySelectorAll('.history-results.open').forEach(el => {
        el.classList.remove('open');
        el.closest('.history-item').classList.remove('open');
    });
    if (wasOpen) return;

    item.classList.add('open');
    resultsDiv.textContent = '';
    const loading = document.createElement('i');
    loading.style.fontSize = '12px';
    loading.style.color    = '#888';
    loading.textContent    = 'Loading saved results...';
    resultsDiv.appendChild(loading);
    resultsDiv.classList.add('open');

    const data = await browser.runtime.sendMessage({ action: 'getHistoryResults', searchId: id });
    resultsDiv.innerHTML = '';

    if (!data.results || !data.results.length) {
        resultsDiv.innerHTML = "<p style='color:gray;font-size:12px;'>No results saved for this search.</p>";
        return;
    }

    const histQuery = data.search?.query || '';
    lastHistoryExpanded = { id, query: histQuery, results: data.results };

    const filtered = applyFilters(data.results, 'history');
    if (!filtered.length) {
        resultsDiv.innerHTML = "<p style='color:gray;font-size:12px;'>No results match the current filters.</p>";
        return;
    }
    const byStore = groupByStore(filtered);
    Object.entries(byStore).forEach(([store, items]) => {
        resultsDiv.appendChild(buildStoreColumn(store, items, null, histQuery, 'newsearch'));
    });
}

async function clearHistory() {
    if (!confirm('Clear all search history? This cannot be undone.')) return;
    await browser.runtime.sendMessage({ action: 'clearHistory' });
    fetchHistory();
}

async function detectCurrentPage() {
    try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) return;
        currentTabUrl = tabs[0].url;

        // ✅ MANIFEST V3 UPDATE: Use browser.scripting.executeScript
        // We pass an absolute JavaScript function reference instead of a text string block.
        const results = await browser.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: scrapeProductData 
        });

        // ✅ MANIFEST V3 UPDATE: Scripting API nests results under the .result property
        const info = results && results[0]?.result;
        if (!info || !info.isProduct) return;

        currentPageProduct = info;

        document.getElementById('cp-name').textContent  = info.name  || '';
        document.getElementById('cp-price').textContent = info.price ? '💰 ' + info.price : '';
        document.getElementById('cp-url').textContent   = info.url   || '';
        document.getElementById('cp-url').title         = info.url   || '';
        document.getElementById('current-page-card').style.display = '';

    } catch (e) {
        // Page may be a privileged URL (about:, browser:) — silently ignore
        console.log('detectCurrentPage skipped:', e.message);
    }
}

// Separate function holding your scraping logic. 
// Modernized to use clean let/const variables instead of 'var'.
function scrapeProductData() {
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
        } catch(e) {}
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
}

async function addCurrentPageStore() {
    const url = currentTabUrl;
    if (!url || url.startsWith('about:') || url.startsWith('moz-extension:') || url.startsWith('chrome:')) {
        setCpError('No trackable page URL detected.');
        return;
    }
    const btn = document.getElementById('cpAddStoreBtn');
    const orig = btn.textContent;
    btn.textContent = 'Adding...';
    btn.disabled    = true;
    const data = await browser.runtime.sendMessage({ action: 'addStore', url });
    setStatus(data.message, data.success ? '#1a7a1a' : '#a00');
    btn.textContent = data.success ? '✓ Tracked' : (data.message.toLowerCase().includes('already') ? '✓ Already tracked' : '✗ Failed');
    if (data.success) fetchTrackedStores();
    setTimeout(() => {
        btn.textContent = orig;
        btn.disabled    = false;
    }, 2500);
}

function setCpError(msg) {
    const el = document.getElementById('cp-error');
    el.textContent = msg;
    setTimeout(() => { el.textContent = ''; }, 3000);
}

// ── Saved searches ────────────────────────────────────────────────────────────

async function saveHistoryEntry(id, btn) {
    const orig      = btn.textContent;
    btn.textContent = '...';
    btn.disabled    = true;
    const data = await browser.runtime.sendMessage({ action: 'saveSearch', searchId: id });
    if (data.success) {
        btn.textContent = '⭐ Saved';
        btn.classList.add('is-saved');
    } else if (data.message === 'Already saved.') {
        btn.textContent = '✓ Saved';
        btn.classList.add('is-saved');
    } else {
        btn.textContent = '✗ Error';
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
}

async function fetchSaved() {
    const data = await browser.runtime.sendMessage({ action: 'getSaved' });
    const list = document.getElementById('savedList');

    if (!data.saved.length) {
        list.innerHTML = "<p style='color:gray;font-size:13px;'>No saved searches yet — click ⭐ Save on any history entry.</p>";
        return;
    }

    list.innerHTML = '';
    data.saved.forEach(entry => {
        const item   = document.createElement('div');
        item.className = 'history-item';
        item.id        = `saved-${entry.id}`;

        const top = document.createElement('div');
        top.className = 'history-item-top';

        const q = document.createElement('span');
        q.className   = 'history-query';
        q.textContent = `⭐ ${entry.query}`;

        const badge = document.createElement('span');
        badge.className   = 'history-badge';
        badge.textContent = `${entry.result_count} result${entry.result_count !== 1 ? 's' : ''}`;

        const removeBtn = document.createElement('button');
        removeBtn.className   = 'action-btn danger';
        removeBtn.style.cssText = 'font-size:11px;padding:3px 9px;margin-left:8px;flex-shrink:0;';
        removeBtn.textContent = '✕ Remove';
        removeBtn.title       = 'Remove from saved';
        removeBtn.addEventListener('click', e => {
            e.stopPropagation();
            removeSavedEntry(entry.id);
        });

        top.appendChild(q);
        top.appendChild(badge);
        top.appendChild(removeBtn);

        const time = document.createElement('div');
        time.className   = 'history-time';
        time.textContent = entry.timestamp;

        const resultsDiv = document.createElement('div');
        resultsDiv.className = 'history-results';
        resultsDiv.id        = `saved-results-${entry.id}`;

        item.appendChild(top);
        item.appendChild(time);
        item.appendChild(resultsDiv);
        item.addEventListener('click', () => toggleSavedItem(entry.id, entry.query));
        list.appendChild(item);
    });
}

async function toggleSavedItem(id, query) {
    const item       = document.getElementById(`saved-${id}`);
    const resultsDiv = document.getElementById(`saved-results-${id}`);
    const wasOpen    = resultsDiv.classList.contains('open');

    document.querySelectorAll('.history-results.open').forEach(el => {
        el.classList.remove('open');
        el.closest('.history-item').classList.remove('open');
    });
    if (wasOpen) return;

    item.classList.add('open');
    resultsDiv.textContent = '';
    const loading = document.createElement('i');
    loading.style.fontSize = '12px';
    loading.style.color    = '#888';
    loading.textContent    = 'Loading saved results...';
    resultsDiv.appendChild(loading);
    resultsDiv.classList.add('open');

    const data = await browser.runtime.sendMessage({ action: 'getSavedResults', id });
    resultsDiv.innerHTML = '';

    if (!data.results || !data.results.length) {
        resultsDiv.innerHTML = "<p style='color:gray;font-size:12px;'>No results saved for this search.</p>";
        return;
    }

    lastSavedExpanded = { id, query, results: data.results };

    const filtered = applyFilters(data.results, 'saved');
    if (!filtered.length) {
        resultsDiv.innerHTML = "<p style='color:gray;font-size:12px;'>No results match the current filters.</p>";
        return;
    }
    const byStore = groupByStore(filtered);
    Object.entries(byStore).forEach(([store, items]) => {
        resultsDiv.appendChild(buildStoreColumn(store, items, null, query, 'newsearch'));
    });
}

async function removeSavedEntry(id) {
    await browser.runtime.sendMessage({ action: 'removeSaved', id });
    fetchSaved();
}

async function clearSaved() {
    if (!confirm('Clear all saved searches? This cannot be undone.')) return;
    await browser.runtime.sendMessage({ action: 'clearSaved' });
    fetchSaved();
}

// ── Cache ─────────────────────────────────────────────────────────────────────

async function clearCache() {
    const data = await browser.runtime.sendMessage({ action: 'clearCache' });
    setStatus(data.message, '#888');
}
