import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse

def discover_store_search_config(base_url: str) -> dict:
    """
    Dynamically inspects a store's root URL to figure out its search mechanism.
    Returns a dictionary with the configuration needed to run searches.
    """
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    parsed_base = urlparse(base_url)
    clean_base_url = f"{parsed_base.scheme}://{parsed_base.netloc}"

    print(f"🕵️ Analyzing {clean_base_url}...")

    # --- TEST 1: Check if it's a Shopify Store ---
    try:
        shopify_test_url = f"{clean_base_url}/search/suggest.json?q=test&resources[type]=product"
        res = requests.get(shopify_test_url, headers=headers, timeout=4)
        if res.status_code == 200 and "resources" in res.json():
            print(f"✨ Success: Detected Shopify API for {clean_base_url}")
            return {
                "store_url": clean_base_url,
                "type": "shopify",
                "search_endpoint": f"{clean_base_url}/search/suggest.json",
                "query_param": "q"
            }
    except Exception:
        pass

    # --- TEST 2: Parse HTML to find the Search Form ---
    try:
        res = requests.get(clean_base_url, headers=headers, timeout=5)
        soup = BeautifulSoup(res.content, "html.parser")
        
        # Look at every <form> on the homepage
        forms = soup.find_all("form")
        for form in forms:
            action = form.get("action", "")
            
            # Find all input fields inside this form
            inputs = form.find_all("input")
            for inp in inputs:
                name = inp.get("name")
                input_type = inp.get("type", "").lower()
                
                # If the input name or form action looks like a search utility...
                if name in ["q", "s", "search", "query", "keyword", "search_query"] or input_type == "search" or "search" in action.lower():
                    search_endpoint = urljoin(clean_base_url, action)
                    print(f"🎯 Success: Dynamically discovered HTML search form at {search_endpoint} using parameter '{name}'")
                    return {
                        "store_url": clean_base_url,
                        "type": "html",
                        "search_endpoint": search_endpoint,
                        "query_param": name
                    }
    except Exception as e:
        print(f"❌ Error during dynamic discovery for {clean_base_url}: {e}")

    # Fallback default guess if everything else completely fails
    return {
        "store_url": clean_base_url,
        "type": "html",
        "search_endpoint": f"{clean_base_url}/search",
        "query_param": "q"
    }