/**
 * lib/renderer.js — JavaScript Rendering Fallback
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses puppeteer-core + @sparticuz/chromium to render JS-heavy pages in a
 * headless browser when raw server-fetched HTML has insufficient body content.
 *
 * Works in:
 *   • Vercel Pro / serverless  — @sparticuz/chromium provides the binary
 *   • Local Windows/Mac/Linux  — falls back to local Chrome installation
 *
 * next.config.js must list these packages in serverExternalPackages so
 * webpack does NOT attempt to bundle them at build time.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import puppeteer from 'puppeteer-core';
import chromium   from '@sparticuz/chromium';

// ── CSS selectors for known main-content containers ──────────────────────────
export const RENDER_CONTENT_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '.post-content',
  '.entry-content',
  '.article-content',
  '.blog-content',
  '.content-body',
  '.page-content',
  '.post-body',
  '.site-main',
];

// ── Realistic Chrome user-agent ───────────────────────────────────────────────
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ── Local Chrome paths (Windows, Mac, Linux) ──────────────────────────────────
const LOCAL_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

// ─────────────────────────────────────────────────────────────────────────────
//  JS-RENDER DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the raw HTML indicates a JS-rendered page:
 *   1. Very few visible words after stripping tags (<150), AND
 *   2. Presence of known JS-framework or bundler fingerprints.
 */
export function isJSRendered(html) {
  const visibleWords = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1).length;

  if (visibleWords >= 150) return false;

  const JS_INDICATORS = [
    /__NEXT_DATA__/,
    /id=["']__next["']/,
    /id=["']__nuxt["']/,
    /id=["']root["'](?!\w)/,
    /id=["']app["'](?!\w)/,
    /data-reactroot/,
    /data-ng-|ng-version/,
    /data-v-\w{7,}/,
    /_app\.[a-f0-9]{8,}\.js/,
    /runtime\.[a-f0-9]{8,}\.js/,
    /chunk\.[a-f0-9]{8,}\.js/,
    /\bwebpack\b/i,
    /\bvite\b/i,
    /\bnuxt\b/i,
  ];

  return JS_INDICATORS.some(rx => rx.test(html));
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROWSER LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Launch a headless Chromium browser.
 *
 * Priority order:
 *   1. @sparticuz/chromium binary  (Vercel / serverless / CI)
 *   2. Local Chrome/Chromium install  (Windows, Mac, Linux dev)
 *
 * Returns the browser instance, or null if nothing is available.
 */
export async function openBrowser() {
  // ── Option 1: @sparticuz/chromium (Vercel / serverless) ─────────────────────
  try {
    const executablePath = await chromium.executablePath();
    const browser = await puppeteer.launch({
      args:            chromium.args,
      executablePath,
      headless:        chromium.headless ?? true,
      defaultViewport: chromium.defaultViewport,
    });
    return browser;
  } catch {}

  // ── Option 2: local Chrome/Chromium install ───────────────────────────────
  for (const executablePath of LOCAL_CHROME_PATHS) {
    try {
      const browser = await puppeteer.launch({
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
        executablePath,
        headless: true,
      });
      return browser;
    } catch {}
  }

  return null; // No browser available
}

/** Safely close a browser instance. */
export async function closeBrowser(browser) {
  try { if (browser) await browser.close(); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE RENDERING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a URL using a shared browser instance and return the full rendered HTML.
 *
 * Render flow:
 *   1. Open a new page, set user-agent + headers
 *   2. Block images / fonts / media (speed optimisation)
 *   3. Navigate — waitUntil: domcontentloaded
 *   4. Best-effort wait for network idle (8 s)
 *   5. Wait for a known content container (10 s)
 *   6. 1.5 s pause for deferred / hydrated content
 *   7. Auto-scroll to trigger lazy-loaded content
 *   8. Return page.content() (full rendered HTML)
 *
 * @param {object} browser   - instance from openBrowser()
 * @param {string} url
 * @param {object} opts
 * @param {number} opts.timeout  - navigation timeout ms (default: 45 000)
 * @returns {{ success:boolean, html?:string, status:string, error?:string }}
 */
export async function renderWithBrowser(browser, url, { timeout = 45000 } = {}) {
  if (!browser) {
    return {
      success: false,
      status:  'failed:render-unavailable',
      error:   'No headless browser available. Install Chrome or run on Vercel Pro.',
    };
  }

  let page;
  try {
    page = await browser.newPage();

    // ── Realistic headers ─────────────────────────────────────────────────────
    await page.setUserAgent(BROWSER_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ── Block images / fonts / media to speed up rendering ───────────────────
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ── Navigate ──────────────────────────────────────────────────────────────
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // ── Wait for network to settle (best-effort) ──────────────────────────────
    try {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 });
    } catch {} // Timeout is acceptable — content may already be rendered

    // ── Wait for a known content container ────────────────────────────────────
    const contentSel = RENDER_CONTENT_SELECTORS.join(', ');
    try {
      await page.waitForSelector(contentSel, { timeout: 10000 });
    } catch {} // Not found is OK — continue anyway

    // ── Short pause for deferred / hydrated content ───────────────────────────
    await new Promise(r => setTimeout(r, 1500));

    // ── Auto-scroll to trigger lazy-loaded content ────────────────────────────
    await page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight / 2)));
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 500));

    // ── Extract full rendered HTML ────────────────────────────────────────────
    const html = await page.content();

    return { success: true, html, status: 'rendered' };

  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || (err.message || '').includes('timeout');
    return {
      success: false,
      status:  isTimeout ? 'failed:render-timeout' : 'failed:render-error',
      error:   err.message || String(err),
    };
  } finally {
    try { if (page) await page.close(); } catch {}
  }
}
