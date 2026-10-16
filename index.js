require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

const EMAIL = process.env.NELSON_EMAIL;
const PASSWORD = process.env.NELSON_PASSWORD;
const API_KEY = process.env.API_KEY;

// Bookshelf rarely changes, so cache it to disk and only re-scrape when stale.
const CACHE_FILE = path.join(__dirname, 'cache.json');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 1000 * 60 * 60 * 6; // 6 hours

let browser = null;
let page = null;
let isLoggedIn = false;
let loginPromise = null;    // dedupes concurrent logins
let refreshPromise = null;  // dedupes concurrent scrapes
let cache = null;           // { timestamp, books, links }

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------
function loadCache() {
    try {
        cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        const ageSec = ((Date.now() - cache.timestamp) / 1000).toFixed(0);
        console.log(`Loaded cache (${cache.books?.length ?? 0} books, age ${ageSec}s).`);
    } catch {
        cache = null;
    }
}

function saveCache() {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch (e) {
        console.error('Failed to write cache:', e.message);
    }
}

function cacheIsFresh() {
    return cache && (Date.now() - cache.timestamp) < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Login (lazy + deduplicated — only runs when we actually need the browser)
// ---------------------------------------------------------------------------
async function doLogin() {
    console.log('Logging in...');

    if (browser) await browser.close().catch(() => {});

    browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    page = await browser.newPage();

    await page.goto('https://nelsondigital.cengage.com.au/login', {
        waitUntil: 'networkidle2'
    });

    await page.waitForSelector('#defaultControl_ctl00_place34_ctl00_PreLoginUserName');
    await page.type('#defaultControl_ctl00_place34_ctl00_PreLoginUserName', EMAIL);
    await page.keyboard.press('Enter');

    await page.waitForSelector('#defaultControl_ctl00_place34_ctl00_Password', { timeout: 10000 });
    await page.type('#defaultControl_ctl00_place34_ctl00_Password', PASSWORD);
    await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });

    isLoggedIn = true;
    console.log('Logged in successfully!');
}

function ensureLoggedIn() {
    if (isLoggedIn) return Promise.resolve();
    if (!loginPromise) {
        loginPromise = doLogin()
            .catch(err => { isLoggedIn = false; throw err; })
            .finally(() => { loginPromise = null; });
    }
    return loginPromise;
}

// ---------------------------------------------------------------------------
// Scrape the bookshelf. Grabs both the book list and the ebook links in a
// single page visit, then caches them to disk.
// ---------------------------------------------------------------------------
async function scrapeBookshelf() {
    await ensureLoggedIn();

    await page.goto('https://nelsondigital.cengage.com.au/my-bookshelf', {
        waitUntil: 'networkidle2'
    });

    // Check if we got redirected to login (session expired)
    if (page.url().includes('/login')) {
        console.log('Session expired, re-logging in...');
        isLoggedIn = false;
        await ensureLoggedIn();
        await page.goto('https://nelsondigital.cengage.com.au/my-bookshelf', {
            waitUntil: 'networkidle2'
        });
    }

    const data = await page.evaluate(() => {
        // books[].index = position among ALL entitlement containers (unchanged)
        const containers = document.querySelectorAll('.slideUpBlock.entitlement');
        const books = Array.from(containers)
            .map((container, i) => {
                const img = container.querySelector('img.book-item-image');
                const hasEbook = container.querySelector('a.product.btn.lightBlueBtn');
                if (!hasEbook) return null;
                return { index: i, title: img ? img.alt : `Book ${i}` };
            })
            .filter(Boolean);

        // links[] is indexed by ebook-anchor position (what /getlink expects)
        const links = Array.from(document.querySelectorAll('a.product.btn.lightBlueBtn'))
            .map(a => a.href);

        return { books, links };
    });

    cache = { timestamp: Date.now(), books: data.books, links: data.links };
    saveCache();
    console.log(`Scraped bookshelf: ${cache.books.length} books.`);
    return cache;
}

// Return cached data if fresh, otherwise scrape (deduping concurrent scrapes).
function getData({ force = false } = {}) {
    if (!force && cacheIsFresh()) return Promise.resolve(cache);
    if (!refreshPromise) {
        refreshPromise = scrapeBookshelf().finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------
function authCheck(req, res) {
    if (req.headers['x-api-key'] !== API_KEY) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

// GET /getbooks   (?refresh=1 to force a re-scrape)
app.get('/getbooks', async (req, res) => {
    if (!authCheck(req, res)) return;

    try {
        const data = await getData({ force: req.query.refresh === '1' });
        res.json({ books: data.books });
    } catch (err) {
        console.error(err);
        isLoggedIn = false; // force re-login on next request
        res.status(500).json({ error: err.message });
    }
});

// GET /getlink?index=0   (?refresh=1 to force a re-scrape)
app.get('/getlink', async (req, res) => {
    if (!authCheck(req, res)) return;

    const index = parseInt(req.query.index ?? 0);

    try {
        const data = await getData({ force: req.query.refresh === '1' });
        const link = data.links[index] ?? null;

        if (!link) {
            return res.status(404).json({ error: `No book found at index ${index}` });
        }

        res.json({ link });
    } catch (err) {
        console.error(err);
        isLoggedIn = false;
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Startup: listen immediately; the browser only launches when data is needed.
// ---------------------------------------------------------------------------
loadCache();
app.listen(PORT, () => {
    console.log(`Scraper running on port ${PORT}`);
    if (cacheIsFresh()) {
        console.log('Serving from fresh cache; browser launches only on demand.');
    } else {
        console.log('Cache missing or stale — warming up in background...');
        getData().catch(err => console.error('Background warm-up failed:', err.message));
    }
});
