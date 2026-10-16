# NelsonNet Scraper

A small Node.js service that logs into a [NelsonNet](https://nelsondigital.cengage.com.au) account with Puppeteer and exposes your bookshelf — the list of books and their ebook access links — over a tiny HTTP API.

## How it works

- The HTTP server starts **immediately** (ready in ~0.5s).
- Logging in with a headless browser is **lazy** — it only happens the first time data is actually needed, or as a non-blocking background warm-up on boot.
- The scraped bookshelf (books + ebook links) is cached to `cache.json` for 6 hours, so warm restarts answer in a few milliseconds **without launching the browser at all**.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the project root:
   ```
   NELSON_EMAIL=your@email.com
   NELSON_PASSWORD=your-password
   API_KEY=some-secret-key
   ```
   Optional:
   ```
   PORT=3001            # HTTP port (default 3001)
   CACHE_TTL_MS=21600000 # cache lifetime in ms (default 6 hours)
   ```
3. Start it:
   ```bash
   npm start
   ```

## API

All requests require your `API_KEY` in the `x-api-key` header.

```bash
# List all books
curl -H "x-api-key: YOUR_API_KEY" http://localhost:3001/getbooks

# Get the access link for a book by index
curl -H "x-api-key: YOUR_API_KEY" "http://localhost:3001/getlink?index=0"
```

Add `?refresh=1` to either endpoint to force a fresh scrape instead of using the cache:

```bash
curl -H "x-api-key: YOUR_API_KEY" "http://localhost:3001/getbooks?refresh=1"
```

| Endpoint | Description |
|---|---|
| `GET /getbooks` | Returns `{ books: [{ index, title }] }` |
| `GET /getlink?index=N` | Returns `{ link }` for the ebook at index `N` |

> **Note:** `index` in `/getbooks` is a book's position in the bookshelf; the `index` passed to `/getlink` selects from the list of ebook links. They are not always the same number.
