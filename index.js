require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

const EMAIL = process.env.NELSON_EMAIL;
const PASSWORD = process.env.NELSON_PASSWORD;
const API_KEY = process.env.API_KEY;

let browser = null;
let page = null;
let isLoggedIn = false;

async function login() {
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

async function getBookshelf() {
    await page.goto('https://nelsondigital.cengage.com.au/my-bookshelf', {
        waitUntil: 'networkidle2'
    });

    // Check if we got redirected to login (session expired)
    if (page.url().includes('/login')) {
        console.log('Session expired, re-logging in...');
        isLoggedIn = false;
        await login();
        await page.goto('https://nelsondigital.cengage.com.au/my-bookshelf', {
            waitUntil: 'networkidle2'
        });
    }
}

// Auth middleware
function authCheck(req, res) {
    if (req.headers['x-api-key'] !== API_KEY) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

// GET /getbooks
app.get('/getbooks', async (req, res) => {
    if (!authCheck(req, res)) return;

    try {
        await getBookshelf();

        const books = await page.evaluate(() => {
            const containers = document.querySelectorAll('.slideUpBlock.entitlement');
            return Array.from(containers)
                .map((container, i) => {
                    const img = container.querySelector('img.book-item-image');
                    const hasEbook = container.querySelector('a.product.btn.lightBlueBtn');
                    if (!hasEbook) return null;
                    return { index: i, title: img ? img.alt : `Book ${i}` };
                })
                .filter(Boolean);
        });

        res.json({ books });

    } catch (err) {
        console.error(err);
        // Force re-login on next request
        isLoggedIn = false;
        res.status(500).json({ error: err.message });
    }
});

// GET /getlink?index=0
app.get('/getlink', async (req, res) => {
    if (!authCheck(req, res)) return;

    const index = parseInt(req.query.index ?? 0);

    try {
        await getBookshelf();

        const link = await page.evaluate((idx) => {
            const anchors = document.querySelectorAll('a.product.btn.lightBlueBtn');
            return anchors[idx] ? anchors[idx].href : null;
        }, index);

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

// Login on startup
login().then(() => {
    app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));
}).catch(err => {
    console.error('Failed to login on startup:', err);
    process.exit(1);
});