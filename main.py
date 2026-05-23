# main.py
import json
import os
import re
from collections import defaultdict
import requests
from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse, parse_qs
import cloudscraper

# Matches price-like text: $12.99  /  12,99 €  /  ¥1000  etc.
_PRICE_RE = re.compile(r'[\$£€¥]\s*[\d,]+\.?\d*|[\d,]+\.?\d*\s*[\$£€¥]')

app = FastAPI()
templates = Jinja2Templates(directory="templates")

STORAGE_FILE = "stores.json"
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
        # 1. Use "mouse" instead of "a", and REMOVE headers=headers
        res = scraper.get(search_endpoint, params={query_param: "mouse"}, timeout=5)
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
        res = scraper.get(shopify_test_url, timeout=3)
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
        res = scraper.get(clean_base_url, timeout=4)
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

@app.on_event("startup")
def initialize_store_configs():
    """Runs automatically on startup to map saved targets."""
    saved_urls = load_stores_from_file()
    print(f"\n📂 Loading {len(saved_urls)} saved stores from disk...")
    for url in saved_urls:
        config = discover_store_search_config(url)
        STORE_REGISTRY[config["store_url"]] = config
    print("🏁 Server preparation complete.\n")

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

    for base_url, config in STORE_REGISTRY.items():
        payload = {config["query_param"]: query}
        
        if config["type"] == "shopify":
            payload["resources[type]"] = "product"
            try:
                res = scraper.get(config["search_endpoint"], params=payload, timeout=4)
                if res.status_code == 200:
                    products = res.json().get("resources", {}).get("results", {}).get("products", [])
                    for prod in products:
                        raw_price = prod.get("price", 0)
                        # Format Shopify's raw number into a nice string so HTML/Shopify match
                        formatted_price = f"${float(raw_price):.2f}" if raw_price else "N/A"
                        
                        aggregated_results.append({
                            "store": base_url,
                            "product": prod.get("title"),
                            "price": formatted_price,
                            "url": f"{base_url}{prod.get('url')}"
                        })
            except Exception as e:
                print(f"Shopify exception at {base_url}: {e}")

        elif config["type"] == "html":
            selectors  = config.get("selectors", {})
            c_sel      = selectors.get("container")
            title_sel  = selectors.get("title")
            price_sel  = selectors.get("price")

            if not c_sel:
                print(f"⚠️  No selectors for {base_url} — skipping.")
                continue

            try:
                res = scraper.get(config["search_endpoint"],
                                   params=payload, timeout=5)
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

    return {"results": aggregated_results}