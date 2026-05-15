/**
 * lib/renderer.js — JavaScript Rendering Fallback
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses Playwright (headless Chromium) to render JS-heavy pages when the raw
 * server-fetched HTML contains too little visible body content.
 *
 * Environment support:
 *   1. @sparticuz/chromium + playwright-core  (Vercel / serverless)
 *   2. Standard playwright                    (local / self-hosted)
 *
 * Usage pattern (one browser per API request, pages shared):
 *   const browser = await openBrowser();
 *   try {
 *     const result = await renderWithBrowser(browser, url);
 *   } finally {
 *     await closeBrowser(browser);
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

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

// ─────────────────────────────────────────────────────────────────────────────
//  JS-RENDER DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the raw server HTML indicates a JavaScript-rendered page:
 *   1. Very few visible words after stripping tags (<150), AND
 *   2. Presence of known JS-framework or bundler fingerprints.
 *
 * Both conditions must be true to avoid false-positives on legitimately
 * sparse pages (e.g. a simple 404 page).
 */
export function isJSRendered(html) {
  // ── Condition 1: visible word count ────────────────────────────────────────
  const visibleWords = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1).length;

  if (visibleWords >= 150) return false; // Enough static content → not JS-rendered

  // ── Condition 2: JS-framework fingerprints ──────────────────────────────────
  const JS_INDICATORS = [
    /__NEXT_DATA__/,                     // Next.js
    /id=["']__next["']/,                 // Next.js root div
    /id=["']__nuxt["']/,                 // Nuxt.js
    /id=["']root["'](?!\w)/,             // React / CRA
    /id=["']app["'](?!\w)/,              // Vue / generic SPA
    /data-reactroot/,                    // React SSR marker
    /data-ng-|ng-version/,               // Angular
    /data-v-\w{7,}/,                     // Vue single-file components
    /_app\.[a-f0-9]{8,}\.js/,            // Next.js chunk hashes
    /runtime\.[a-f0-9]{8,}\.js/,         // Webpack runtime
    /chunk\.[a-f0-9]{8,}\.js/,           // Webpack chunks
    /\bwebpack\b/i,                       // Webpack mentions
    /\bvite\b/i,                          // Vite
    /\bnuxt\b/i,                          // Nuxt
  ];

  return JS_INDICATORS.some(rx => rx.test(html));
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROWSER LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Launch a headless Chromium browser.
 * Tries @sparticuz/chromium first (Vercel/serverless), then falls back to
 * the standard playwright package (local/self-hosted).
 *
 * Returns the browser instance, or null if neither package is available.
 */
export async function openBrowser() {
  // ── Option 1: @sparticuz/chromium + playwright-core (serverless) ────────────
  try {
    const [sparticuz, pwCore] = await Promise.all([
      import('@sparticuz/chromium'),
      import('playwright-core'),
    ]);
    const executablePath = await sparticuz.default.executablePath();
    const browser = await pwCore.chromium.launch({
      args:           sparticuz.default.args,
      executablePath,
      headless:       sparticuz.default.headless ?? true,
    });
    return browser;
  } catch {}

  // ── Option 2: standard playwright (local / self-hosted) ─────────────────────
  try {
    const { chromium } = await import('playwright');
    return await chromium.launch({ headless: true });
  } catch {}

  return null; // Neither package available
}

/** Safely close a browser instance. */
export async function closeBrowser(browser) {
  try { if (browser) await browser.close(); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE RENDERING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a URL using a shared browser instance and return the full HTML.
 *
 * Render flow:
 *   1. Open a new browser page
 *   2. Set realistic user-agent + headers
 *   3. Block images/fonts/media (speed optimisation)
 *   4. Navigate — waitUntil: domcontentloaded (fast)
 *   5. Best-effort wait for networkidle (8 s)
 *   6. Wait for a known content container (10 s)
 *   7. Extra 1.5 s pause for deferred content
 *   8. Auto-scroll to trigger lazy-loaded content
 *   9. Return page.content() (full rendered HTML)
 *
 * @param {object} browser  - browser from openBrowser()
 * @param {string} url
 * @param {object} opts
 * @param {number} opts.timeout  - navigation timeout in ms (default: 45 000)
 * @returns {{ success:boolean, html?:string, status:string, error?:string }}
 */
export async function renderWithBrowser(browser, url, { timeout = 45000 } = {}) {
  if (!browser) {
    return {
      success: false,
      status:  'failed:render-unavailable',
      error:   'No headless browser available. Install the playwright package.',
    };
  }

  let page;
  try {
    page = await browser.newPage();

    // Realistic browser headers
    await page.setUserAgent(BROWSER_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Block images, fonts, and media to speed up rendering
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // ── Step 1: Navigate ──────────────────────────────────────────────────────
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // ── Step 2: Wait for network to settle (best-effort) ─────────────────────
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {} // Timeout is fine — content may already be there

    // ── Step 3: Wait for a known content container ────────────────────────────
    const contentSel = RENDER_CONTENT_SELECTORS.join(', ');
    try {
      await page.waitForSelector(contentSel, { timeout: 10000 });
    } catch {} // Selector not found — continue anyway

    // ── Step 4: Short pause for deferred / hydrated content ───────────────────
    await page.waitForTimeout(1500);

    // ── Step 5: Auto-scroll to trigger lazy-loaded content ────────────────────
    await page.evaluate(() => {
      window.scrollTo(0, Math.floor(document.body.scrollHeight / 2));
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(500);

    // ── Step 6: Extract full rendered HTML ────────────────────────────────────
    const html = await page.content();

    return { success: true, html, status: 'rendered' };

  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout');
    return {
      success: false,
      status:  isTimeout ? 'failed:render-timeout' : 'failed:render-error',
      error:   err.message,
    };
  } finally {
    try { if (page) await page.close(); } catch {}
  }
}
