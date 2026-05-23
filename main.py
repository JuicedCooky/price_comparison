# main.py
import json
import os
import re
import sys
from collections import defaultdict
import requests
from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse, parse_qs
import cloudscraper
from contextlib import asynccontextmanager
import sqlite3

# Matches price-like text: $12.99  /  12,99 €  /  ¥1000  etc.
_PRICE_RE = re.compile(r'[\$£€¥]\s*[\d,]+\.?\d*|[\d,]+\.?\d*\s*[\$£€¥]')

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Replaces the deprecated @app.on_event('startup') pattern."""
    init_db()
    saved_urls = load_stores_from_file()
    print(f"\n📂 Loading {len(saved_urls)} saved stores from disk...")
    for url in saved_urls:
        config = discover_store_search_config(url)
        STORE_REGISTRY[config["store_url"]] = config
    print("🏁 Server preparation complete.\n")
    yield  # server runs here

app = FastAPI(lifespan=lifespan)

# --- FIX: Dynamic path resolution for PyInstaller ---
if hasattr(sys, '_MEIPASS'):
    # Running as a PyInstaller executable
    base_dir = sys._MEIPASS
else:
    # Running as a normal Python script
    base_dir = os.path.dirname(os.path.abspath(__file__))

template_path = os.path.join(base_dir, "templates")
templates = Jinja2Templates(directory=template_path)
# ----------------------------------------------------

STORAGE_FILE = "stores.json"
DB_FILE       = "price_tracker.db"
STORE_REGISTRY = {}

scraper = cloudscraper.create_scraper(browser={
    'browser': 'chrome',
    'platform': 'windows',
    'desktop': True
})

def load_stores_from_file():
    """Reads saved store URLs from disk or initializes an empty list."""
    if os.path.exists(STORAGE_FILE):
        try:
            with open(STORAGE_FILE, "r") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠️ Error reading storage file, resetting: {e}")
            return []
    return []

def save_stores_to_file(urls):
    """Saves the current array of URLs permanently to disk."""
    try:
        with open(STORAGE_FILE, "w") as f:
            json.dump(urls, f, indent=4)
    except Exception as e:
        print(f"❌ Failed to save stores to disk: {e}")

# ── SQLite: setup ──────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Creates all tables on first run; safe to call on every startup."""
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS searches (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                query        TEXT    NOT NULL,
                timestamp    TEXT    NOT NULL DEFAULT (datetime('now')),
                result_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS search_results (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
                store     TEXT NOT NULL,
                product   TEXT NOT NULL,
                price     TEXT,
                url       TEXT
            );

            CREATE TABLE IF NOT EXISTS page_cache (
                url        TEXT PRIMARY KEY,
                content    BLOB NOT NULL,
                cached_at  TEXT NOT NULL DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL
            );

            PRAGMA journal_mode=WAL;
        """)
    print("🗄️  Database ready.")

# ── SQLite: page cache ─────────────────────────────────────────────────────

def cache_get(cache_key: str) -> bytes | None:
    """Returns cached page bytes if the entry exists and hasn't expired."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT content FROM page_cache WHERE url = ? AND expires_at > datetime('now')",
            (cache_key,)
        ).fetchone()
        return bytes(row["content"]) if row else None

def cache_set(cache_key: str, content: bytes, ttl: int = 3600):
    """Stores raw page bytes; ttl is seconds until the entry expires."""
    with get_db() as conn:
        conn.execute(
            f"""INSERT OR REPLACE INTO page_cache (url, content, cached_at, expires_at)
                VALUES (?, ?, datetime('now'), datetime('now', '+{ttl} seconds'))""",
            (cache_key, content)
        )

# ── SQLite: search history ─────────────────────────────────────────────────

def save_search_to_db(query: str, results: list):
    """Saves a completed search and every result row to the database."""
    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO searches (query, result_count) VALUES (?, ?)",
            (query, len(results))
        )
        if results:
            conn.executemany(
                """INSERT INTO search_results (search_id, store, product, price, url)
                   VALUES (?, ?, ?, ?, ?)""",
                [(cur.lastrowid, r["store"], r["product"], r["price"], r["url"])
                 for r in results]
            )

# ── Cached HTTP fetch ──────────────────────────────────────────────────────

class _CachedResponse:
    """Minimal requests.Response stand-in for serving cached content."""
    def __init__(self, content: bytes, status_code: int = 200):
        self.content    = content
        self.status_code = status_code

    def json(self):
        return json.loads(self.content)

def cached_scrape(url: str, params: dict = None, ttl: int = 3600):
    """
    Fetches url (with params) via cloudscraper, caching raw bytes in SQLite.
    ttl — seconds the cached response stays valid (default 1 h).
    Returns an object with .content, .status_code, and .json().
    """
    from urllib.parse import urlencode
    cache_key = url + ("?" + urlencode(sorted(params.items())) if params else "")

    hit = cache_get(cache_key)
    if hit is not None:
        print(f"  💾 Cache hit: {cache_key[:100]}")
        return _CachedResponse(hit)

    res = scraper.get(url, params=params, timeout=5)
    if res.status_code == 200:
        cache_set(cache_key, res.content, ttl)
    return res

def _structural_selector(soup) -> str | None:
    """
    Fallback: scan the page for repeated li/div/article elements whose
    class signature appears 3+ times AND most instances contain a link
    and price-like text — a strong signal for product cards.
    """
    counts: dict[str, list] = defaultdict(list)

    for tag in soup.find_all(["li", "div", "article", "section"]):
        classes = tag.get("class", [])
        if not classes:
            continue
            
        # --- NEW: Anti-Junk Filter ---
        class_str = " ".join(classes).lower()
        if any(bad in class_str for bad in ["cart", "nav", "menu", "header", "suggest", "dropdown", "popup"]):
            continue
        # -----------------------------

        # Key on tag + first class only to avoid over-specificity
        key = f"{tag.name}.{classes[0]}"
        counts[key].append(tag)

    best_sel, best_score = None, 0

    for sel, elements in counts.items():
        if len(elements) < 3:
            continue

        sample = elements[:6]
        has_link  = sum(1 for el in sample if el.find("a", href=True))
        has_price = sum(1 for el in sample if _PRICE_RE.search(el.get_text()))
        has_img   = sum(1 for el in sample if el.find("img"))

        # Must have links in the majority of sampled elements
        if has_link < len(sample) * 0.6 or has_price == 0:
            continue

        score = len(elements) + has_price * 4 + has_img * 2
        if score > best_score:
            best_score = score
            best_sel = sel

    return best_sel


def discover_html_selectors(search_endpoint: str, query_param: str, headers: dict) -> dict:
    """
    Two-pass selector detection for an HTML store's search results page.
    Pass 1 — tries a broad list of known framework/theme class names.
    Pass 2 — structural heuristic: finds repeated elements with links + prices.
    Returns a dict with keys: container, title, price  (any may be None).
    """
    CANDIDATE_CONTAINERS = [
        # Data-attribute patterns (framework-agnostic)
        "[data-product-id]", "[data-product]", "[data-item-id]",
        # Shopify themes
        ".product-item", ".product-card", ".product-tile", ".product-grid-item",
        ".grid__item", ".card--product", ".product-loop__item",
        # WooCommerce
        "li.product", "li.type-product", ".type-product", ".products .product",
        ".woocommerce-loop-product__link",
        # Generic / common patterns
        ".product", ".product-block", ".productitem", ".product_item",
        ".product-wrapper", ".product-container",
        ".collection-item", ".item--product",
        ".search-result__item", ".search__result-item", ".search-result",
        "article.product", ".products-list__item",
    ]
    CANDIDATE_TITLES = [
        "[data-product-title]",
        ".product-item__title", ".product-card__title", ".product-card__name",
        ".product__title", ".product-title", ".product-name",
        ".card__title", ".card__heading",
        ".woocommerce-loop-product__title",
        "h2 a", "h3 a", "h4 a", "h2", "h3",
    ]
    CANDIDATE_PRICES = [
        "[data-product-price]",
        ".price__current", ".price-item--regular", ".price-item--sale",
        ".product-item__price", ".product-card__price",
        ".woocommerce-Price-amount", "ins .amount", ".amount",
        ".price .money", ".price", ".money",
        ".product-price", ".sale-price", ".regular-price",
    ]

    try:
        # Long TTL: site structure changes rarely, no need to re-probe each startup
        res = cached_scrape(search_endpoint, params={query_param: "mouse"}, ttl=86400)
        soup = BeautifulSoup(res.content, "html.parser")

        # 2. THE NUKE: Destroy headers, footers, and carts from memory before scanning
        for junk in soup.find_all(['header', 'nav', 'footer']):
            junk.decompose()
            
        for junk in soup.find_all(True, {'class': re.compile(r'cart|nav|menu|header|suggest|dropdown|popup|sidebar|footer', re.I)}):
            junk.decompose()
            
        for junk in soup.find_all(True, {'id': re.compile(r'cart|nav|menu|header|suggest|dropdown|popup|sidebar|footer', re.I)}):
            junk.decompose()

    except Exception as e:
        print(f"Error fetching selectors: {e}")
        return {}

    # ── Pass 1: known selector list ────────────────────────────────────────
    best = {"score": 0, "container": None, "title": None, "price": None}

    for c_sel in CANDIDATE_CONTAINERS:
        items = soup.select(c_sel)
        if len(items) < 2:
            continue
        sample = items[0]
        title_sel = next((s for s in CANDIDATE_TITLES if sample.select_one(s)), None)
        price_sel = next((s for s in CANDIDATE_PRICES if sample.select_one(s)), None)
        score = len(items) + (10 if title_sel else 0) + (10 if price_sel else 0)
        if score > best["score"]:
            best = {"score": score, "container": c_sel,
                    "title": title_sel, "price": price_sel}

    if best["container"]:
        print(f"  ✅ [pass-1] container={best['container']} | "
              f"title={best['title']} | price={best['price']}")
        return {"container": best["container"], "title": best["title"], "price": best["price"]}

    # ── Pass 2: structural heuristic ───────────────────────────────────────
    print(f"  🔍 Known selectors failed — trying structural heuristic...")
    c_sel = _structural_selector(soup)

    if not c_sel:
        print(f"  ⚠️  Selector auto-detection found no container at {search_endpoint}")
        return {}

    items  = soup.select(c_sel)
    sample = items[0] if items else None
    title_sel = price_sel = None

    if sample:
        title_sel = next((s for s in CANDIDATE_TITLES if sample.select_one(s)), None)
        price_sel = next((s for s in CANDIDATE_PRICES if sample.select_one(s)), None)

        # Sub-fallbacks: first meaningful anchor / first element with price text
        if not title_sel and sample.find("a", href=True):
            title_sel = "a"
        if not price_sel:
            for el in sample.find_all(True):
                if _PRICE_RE.search(el.get_text(strip=True)):
                    cls = el.get("class", [])
                    price_sel = f"{el.name}.{cls[0]}" if cls else el.name
                    break

    print(f"  ✅ [pass-2] container={c_sel} | title={title_sel} | price={price_sel}")
    return {"container": c_sel, "title": title_sel, "price": price_sel}


def discover_store_search_config(base_url: str) -> dict:
    """Dynamically analyzes a URL to find its search configuration."""
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    parsed_base = urlparse(base_url)
    clean_base_url = f"{parsed_base.scheme}://{parsed_base.netloc}"

    if parsed_base.query:
        query_params = parse_qs(parsed_base.query)
        # Find whichever parameter holds our test search word (e.g., 's' or 'q')
        detected_param = next(iter(query_params.keys()), "q")
        endpoint = f"{clean_base_url}{parsed_base.path}"
        
        print(f"🎯 Exact URL provided! Endpoint: {endpoint} | Param: {detected_param}")
        
        # Test it right away
        selectors = discover_html_selectors(endpoint, detected_param, {})
        return {
            "store_url": clean_base_url,
            "type": "html",
            "search_endpoint": endpoint,
            "query_param": detected_param,
            "selectors": selectors,
        }

    # --- Shopify Test ---
    try:
        shopify_test_url = f"{clean_base_url}/search/suggest.json?q=test&resources[type]=product"
        res = cached_scrape(shopify_test_url, ttl=86400)
        if res.status_code == 200 and "resources" in res.json():
            return {
                "store_url": clean_base_url,
                "type": "shopify",
                "search_endpoint": f"{clean_base_url}/search/suggest.json",
                "query_param": "q"
            }
    except Exception:
        pass

    # --- HTML Form Fallback Test ---
    try:
        res = cached_scrape(clean_base_url, ttl=86400)
        soup = BeautifulSoup(res.content, "html.parser")
        forms = soup.find_all("form")
        for form in forms:
            action = form.get("action", "")
            inputs = form.find_all("input")
            for inp in inputs:
                name = inp.get("name")
                input_type = inp.get("type", "").lower()
                if name in ["q", "s", "search", "query", "keyword", "keywords"] or input_type == "search" or "search" in action.lower():
                    endpoint = urljoin(clean_base_url, action)
                    query_param = name or "q"
                    selectors = discover_html_selectors(endpoint, query_param, headers)
                    return {
                        "store_url": clean_base_url,
                        "type": "html",
                        "search_endpoint": endpoint,
                        "query_param": query_param,
                        "selectors": selectors,
                    }
    except Exception:
        pass

    endpoint = f"{clean_base_url}/search"
    selectors = discover_html_selectors(endpoint, "q", headers)
    return {
        "store_url": clean_base_url,
        "type": "html",
        "search_endpoint": endpoint,
        "query_param": "q",
        "selectors": selectors,
    }

# @app.on_event("startup")
# def initialize_store_configs():
#     """Runs automatically on startup to map saved targets."""
#     saved_urls = load_stores_from_file()
#     print(f"\n📂 Loading {len(saved_urls)} saved stores from disk...")
#     for url in saved_urls:
#         config = discover_store_search_config(url)
#         STORE_REGISTRY[config["store_url"]] = config
#     print("🏁 Server preparation complete.\n")

@app.get("/")
def read_root(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")

@app.get("/stores/")
def list_stores():
    """Returns all currently tracked domains to display on the frontend."""
    return {"stores": list(STORE_REGISTRY.keys())}

@app.post("/add-store/")
def add_store(store_url: str):
    """Saves a new store to memory, updates the file tracker, and configures it."""
    # Normalize: assume https:// if no scheme is provided
    if not store_url.startswith(("http://", "https://")):
        store_url = "https://" + store_url

    parsed = urlparse(store_url)
    clean_url = f"{parsed.scheme}://{parsed.netloc}"

    if not parsed.netloc:
        return {"success": False, "message": "Invalid URL — could not parse a domain."}

    if clean_url in STORE_REGISTRY:
        return {"success": False, "message": "Store is already tracked!"}

    # Analyze and configure live
    config = discover_store_search_config(clean_url)
    STORE_REGISTRY[clean_url] = config
    
    # Persistent Sync
    current_saved = load_stores_from_file()
    if clean_url not in current_saved:
        current_saved.append(clean_url)
        save_stores_to_file(current_saved)

    return {"success": True, "message": f"Successfully mapped and saved: {clean_url}"}

@app.delete("/remove-store/")
def remove_store(store_url: str):
    """Drops the store target from active searches and removes it from disk."""
    if store_url in STORE_REGISTRY:
        del STORE_REGISTRY[store_url]
        
        current_saved = load_stores_from_file()
        if store_url in current_saved:
            current_saved.remove(store_url)
            save_stores_to_file(current_saved)
            
        return {"success": True, "message": "Store successfully deleted."}
    return {"success": False, "message": "Store target not found."}

@app.get("/search/")
def search_prices(query: str):
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    aggregated_results = []
    store_statuses = {url: {"error": None} for url in STORE_REGISTRY}

    for base_url, config in STORE_REGISTRY.items():
        payload = {config["query_param"]: query}

        if config["type"] == "shopify":
            payload["resources[type]"] = "product"
            try:
                res = cached_scrape(config["search_endpoint"], params=payload, ttl=900)
                if res.status_code == 200:
                    products = res.json().get("resources", {}).get("results", {}).get("products", [])
                    for prod in products:
                        raw_price = prod.get("price", 0)
                        formatted_price = f"${float(raw_price):.2f}" if raw_price else "N/A"
                        aggregated_results.append({
                            "store": base_url,
                            "product": prod.get("title"),
                            "price": formatted_price,
                            "url": f"{base_url}{prod.get('url')}"
                        })
                else:
                    store_statuses[base_url]["error"] = f"Request failed (HTTP {res.status_code})"
            except Exception as e:
                print(f"Shopify exception at {base_url}: {e}")
                store_statuses[base_url]["error"] = f"Request error: {e}"

        elif config["type"] == "html":
            selectors  = config.get("selectors", {})
            c_sel      = selectors.get("container")
            title_sel  = selectors.get("title")
            price_sel  = selectors.get("price")

            if not c_sel:
                print(f"⚠️  No selectors for {base_url} — skipping.")
                store_statuses[base_url]["error"] = "No product selectors found — try re-adding with a direct search URL"
                continue

            try:
                res = cached_scrape(config["search_endpoint"], params=payload, ttl=900)
                soup = BeautifulSoup(res.content, "html.parser")

                for item in soup.select(c_sel):
                    title_el = item.select_one(title_sel) if title_sel else None
                    price_el = item.select_one(price_sel) if price_sel else None
                    link_el  = item.select_one("a[href]")

                    title = (title_el.get_text(strip=True) if title_el
                             else item.get_text(separator=" ", strip=True)[:80])
                    price = price_el.get_text(strip=True) if price_el else "N/A"
                    url   = urljoin(base_url, link_el["href"]) if link_el else base_url

                    if title:
                        aggregated_results.append({
                            "store":   base_url,
                            "product": title,
                            "price":   price,
                            "url":     url,
                        })
            except Exception as e:
                print(f"HTML scrape exception at {base_url}: {e}")
                store_statuses[base_url]["error"] = f"Scrape error: {e}"

    save_search_to_db(query, aggregated_results)
    return {"results": aggregated_results, "store_statuses": store_statuses}

@app.get("/history/")
def get_history(limit: int = 30):
    """Returns the most recent searches with their result counts."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, query, timestamp, result_count FROM searches ORDER BY id DESC LIMIT ?",
            (limit,)
        ).fetchall()
    return {"history": [dict(r) for r in rows]}

@app.get("/history/{search_id}/results")
def get_history_results(search_id: int):
    """Returns every saved result row for a specific past search."""
    with get_db() as conn:
        search = conn.execute(
            "SELECT id, query, timestamp, result_count FROM searches WHERE id = ?",
            (search_id,)
        ).fetchone()
        if not search:
            return {"success": False, "message": "Search ID not found."}
        results = conn.execute(
            "SELECT store, product, price, url FROM search_results WHERE search_id = ?",
            (search_id,)
        ).fetchall()
    return {"search": dict(search), "results": [dict(r) for r in results]}

@app.delete("/history/clear")
def clear_history():
    """Wipes all search history and results (page cache is kept)."""
    with get_db() as conn:
        conn.execute("DELETE FROM search_results")
        conn.execute("DELETE FROM searches")
    return {"success": True, "message": "Search history cleared."}

@app.delete("/cache/clear")
def clear_cache():
    """Deletes all cached pages, forcing fresh fetches on the next request."""
    with get_db() as conn:
        conn.execute("DELETE FROM page_cache")
    return {"success": True, "message": "Page cache cleared."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)