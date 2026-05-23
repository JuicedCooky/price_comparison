# price_comparison

A FastAPI web app that searches multiple online stores simultaneously and aggregates product results by price.

## Requirements

Install dependencies before running:

```bash
pip install fastapi uvicorn requests beautifulsoup4 cloudscraper
```

## Running the App

Start the server with `uvicorn`:

```bash
uvicorn main:app --reload
```

Then open your browser at [http://localhost:8000](http://localhost:8000).

> The `--reload` flag auto-restarts the server on code changes. Drop it in production.

## Adding Stores

There are two ways to add a store. You do **not** need to type `https://` — it is assumed automatically.

### Option 1 — Base domain (auto-detection)

Paste just the domain and the app will probe the site to figure out its search endpoint, query parameter, and product card selectors automatically.

```
pandahobby.com
gundamextra.com
www.notahobby.shop
```

Detection priority:
1. **Shopify API** — checks `/search/suggest.json`; uses the JSON API if found (fastest, most accurate)
2. **HTML form scan** — parses the homepage for a search `<form>` and reads its `action` + input `name`
3. **Default fallback** — assumes `/search?q=`

### Option 2 — Direct search URL (exact override)

If auto-detection fails or picks the wrong endpoint, do a real search on the store yourself, then copy the full URL from your browser and paste it in. The app reads the query string to extract the endpoint and parameter directly — no guessing needed.

```
https://www.notahobby.shop/?s=gundam
https://pandahobby.com/search?q=zaku
```

The part after `?` tells the app which parameter the store uses (`s=`, `q=`, etc.) and locks it in for all future searches.

## How It Works

- Stores are saved to `stores.json` as base URLs and re-probed on every server restart.
- Product card selectors (container, title, price) are detected at add-time using a two-pass heuristic:
  - **Pass 1** — tries a list of known Shopify / WooCommerce / common class names
  - **Pass 2** — structural scan: finds repeated page elements that contain both a link and price-like text
- All searches run across every tracked store in parallel and results are aggregated into one list.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Main UI |
| `GET` | `/stores/` | List tracked stores |
| `POST` | `/add-store/?store_url=<url>` | Add a store (domain or full search URL) |
| `DELETE` | `/remove-store/?store_url=<url>` | Remove a store |
| `GET` | `/search/?query=<term>` | Search all stores for a product |
