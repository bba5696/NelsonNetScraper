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

const LOGIN_URL = 'https://nelsondigital.cengage.com.au/login';
const BOOKSHELF_URL = 'https://nelsondigital.cengage.com.au/my-bookshelf';
const USER_SEL = '#defaultControl_ctl00_place34_ctl00_PreLoginUserName';
const PASS_SEL = '#defaultControl_ctl00_place34_ctl00_Password';
const BOOK_SEL = '.slideUpBlock.entitlement';

// Bookshelf is cached to disk so we only re-scrape when stale. Two TTLs:
// the book LIST barely changes, but the ebook LINKS are tokens that expire
// ~1h, so they get a much shorter lifetime (stay well under the hour).
const CACHE_FILE = path.join(__dirname, 'cache.json');
const BOOKS_TTL_MS = Number(process.env.BOOKS_TTL_MS) || 1000 * 60 * 60 * 6; // 6 hours
const LINKS_TTL_MS = Number(process.env.LINKS_TTL_MS) || 1000 * 60 * 30;     // 30 minutes

// Saved login session (cookies). Reused across restarts so we skip the slow
// email/password/SSO login whenever the session is still valid.
const SESSION_FILE = path.join(__dirname, 'session.json');

let browser = null;
let page = null;
let isLoggedIn = false;
let loginPromise = null;    // dedupes concurrent logins
let refreshPromise = null;  // dedupes concurrent scrapes
let cache = null;           // { timestamp, books, links }

// ---------------------------------------------------------------------------
// Disk cache (scraped data)
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

function cacheAge() {
    return cache ? Date.now() - cache.timestamp : Infinity;
}

// ---------------------------------------------------------------------------
// Session cookies (persisted across restarts)
// ---------------------------------------------------------------------------
async function saveCookies() {
    try {
        const client = await page.target().createCDPSession();
        const { cookies } = await client.send('Network.getAllCookies');
        fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies));
    } catch (e) {
        console.error('Failed to save session:', e.message);
    }
}

async function loadCookies() {
    try {
        const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        if (Array.isArray(cookies) && cookies.length) {
            await page.setCookie(...cookies);
            return true;
        }
    } catch { /* no saved session yet */ }
    return false;
}

// ---------------------------------------------------------------------------
// Browser lifecycle. We launch on demand and close after each scrape so the
// process idles at ~50MB instead of keeping headless Chromium (~0.7GB) resident
// — important on a small (1GB) server.
// ---------------------------------------------------------------------------
async function launchBrowser() {
    if (browser) return;
    browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    page = await browser.newPage();

    // Skip heavy assets we never read — faster navigations, smaller memory spike.
    await page.setRequestInterception(true);
    page.on('request', req => {
        const type = req.resourceType();
        if (type === 'image' || type === 'media' || type === 'font') req.abort();
        else req.continue();
    });
}

async function closeBrowser() {
    if (browser) await browser.close().catch(() => {});
    browser = null;
    page = null;
    isLoggedIn = false;
}

// ---------------------------------------------------------------------------
// Login. Full credential login is the slow path and only runs when there's no
// valid saved session. Navigations that follow the SSO redirects keep the
// robust networkidle2 wait; the frequent bookshelf scrape uses targeted waits.
// ---------------------------------------------------------------------------
async function doLogin() {
    console.log('Logging in with credentials...');

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector(USER_SEL);
    await page.type(USER_SEL, EMAIL);
    await page.keyboard.press('Enter');

    await page.waitForSelector(PASS_SEL, { timeout: 10000 });
    await page.type(PASS_SEL, PASSWORD);
    await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });

    await saveCookies();
    isLoggedIn = true;
    console.log('Logged in; session saved.');
}

// Make sure we have a browser with a (hopefully) authenticated page. Reuses the
// saved cookies when present; falls back to a full login otherwise.
function ensureSession() {
    if (isLoggedIn) return Promise.resolve();
    if (!loginPromise) {
        loginPromise = (async () => {
            await launchBrowser();
            if (await loadCookies()) {
                isLoggedIn = true; // provisional — verified when we hit the bookshelf
                console.log('Loaded saved session (will log in only if it expired).');
            } else {
                await doLogin();
            }
        })()
            .catch(err => { isLoggedIn = false; throw err; })
            .finally(() => { loginPromise = null; });
    }
    return loginPromise;
}

// ---------------------------------------------------------------------------
// Scrape the bookshelf: book list + ebook links in one visit, then cache and
// close the browser.
// ---------------------------------------------------------------------------
async function scrapeBookshelf() {
    await ensureSession();

    await page.goto(BOOKSHELF_URL, { waitUntil: 'domcontentloaded' });

    // Saved session expired (bounced to login) — do a full login and retry once.
    if (page.url().includes('/login')) {
        console.log('Saved session expired, logging in fresh...');
        isLoggedIn = false;
        await doLogin();
        await page.goto(BOOKSHELF_URL, { waitUntil: 'domcontentloaded' });
    }

    await page.waitForSelector(BOOK_SEL, { timeout: 20000 });

    const data = await page.evaluate((bookSel) => {
        // books[].index = position among ALL entitlement containers (unchanged)
        const containers = document.querySelectorAll(bookSel);
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
    }, BOOK_SEL);

    cache = { timestamp: Date.now(), books: data.books, links: data.links };
    saveCache();
    console.log(`Scraped bookshelf: ${cache.books.length} books.`);

    // Free the memory; the saved session makes the next launch cheap.
    await closeBrowser();
    return cache;
}

// Return cached data if it's fresh enough for the caller's needs (ttl),
// otherwise scrape (deduping concurrent scrapes). /getlink passes the short
// links TTL; /getbooks passes the long book-list TTL.
function getData({ force = false, ttl = LINKS_TTL_MS } = {}) {
    if (!force && cacheAge() < ttl) return Promise.resolve(cache);
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
        const data = await getData({ force: req.query.refresh === '1', ttl: BOOKS_TTL_MS });
        res.json({ books: data.books });
    } catch (err) {
        console.error(err);
        await closeBrowser(); // reset so next request starts clean
        res.status(500).json({ error: err.message });
    }
});

// GET /getlink?index=0   (?refresh=1 to force a re-scrape)
app.get('/getlink', async (req, res) => {
    if (!authCheck(req, res)) return;

    const index = parseInt(req.query.index ?? 0);

    try {
        const data = await getData({ force: req.query.refresh === '1', ttl: LINKS_TTL_MS });
        const link = data.links[index] ?? null;

        if (!link) {
            return res.status(404).json({ error: `No book found at index ${index}` });
        }

        res.json({ link });
    } catch (err) {
        console.error(err);
        await closeBrowser();
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Startup: listen immediately; the browser only launches when data is needed.
// ---------------------------------------------------------------------------
loadCache();
app.listen(PORT, () => {
    console.log(`Scraper running on port ${PORT}`);
    // Keep links fresh: warm up if the cache is older than the links TTL.
    if (cacheAge() < LINKS_TTL_MS) {
        console.log('Serving from fresh cache; browser launches only on demand.');
    } else {
        console.log('Cache missing or stale — warming up in background...');
        getData().catch(err => console.error('Background warm-up failed:', err.message));
    }
});
