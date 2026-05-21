# main.py
import json
import os
import requests
from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse

app = FastAPI()
templates = Jinja2Templates(directory="templates")

STORAGE_FILE = "stores.json"
STORE_REGISTRY = {}

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

def discover_store_search_config(base_url: str) -> dict:
    """Dynamically analyzes a URL to find its search configuration."""
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    parsed_base = urlparse(base_url)
    clean_base_url = f"{parsed_base.scheme}://{parsed_base.netloc}"

    # --- Shopify Test ---
    try:
        shopify_test_url = f"{clean_base_url}/search/suggest.json?q=test&resources[type]=product"
        res = requests.get(shopify_test_url, headers=headers, timeout=3)
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
        res = requests.get(clean_base_url, headers=headers, timeout=4)
        soup = BeautifulSoup(res.content, "html.parser")
        forms = soup.find_all("form")
        for form in forms:
            action = form.get("action", "")
            inputs = form.find_all("input")
            for inp in inputs:
                name = inp.get("name")
                input_type = inp.get("type", "").lower()
                if name in ["q", "s", "search", "query", "keyword"] or input_type == "search" or "search" in action.lower():
                    return {
                        "store_url": clean_base_url,
                        "type": "html",
                        "search_endpoint": urljoin(clean_base_url, action),
                        "query_param": name
                    }
    except Exception:
        pass

    return {
        "store_url": clean_base_url,
        "type": "html",
        "search_endpoint": f"{clean_base_url}/search",
        "query_param": "q"
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
    parsed = urlparse(store_url)
    clean_url = f"{parsed.scheme}://{parsed.netloc}"
    
    if not clean_url or "http" not in clean_url:
        return {"success": False, "message": "Invalid URL string formatted."}

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
                res = requests.get(config["search_endpoint"], headers=headers, params=payload, timeout=4)
                if res.status_code == 200:
                    products = res.json().get("resources", {}).get("results", {}).get("products", [])
                    for prod in products:
                        aggregated_results.append({
                            "store": base_url,
                            "product": prod.get("title"),
                            "price": prod.get("price"),
                            "url": f"{base_url}{prod.get('url')}"
                        })
            except Exception as e:
                print(f"Shopify exception at {base_url}: {e}")

        elif config["type"] == "html":
            # (Your custom HTML parsing block stays here)
            pass

    return {"results": aggregated_results}