/**
 * pages/api/analyze-links.js — v4.3 Hybrid Extraction Pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 * Two-phase fetch:
 *   Phase 1 — Raw HTTP fetch (concurrency: 5)
 *     → Detect JS-rendered pages via word count + framework fingerprints
 *     → Extract body content from SSR pages normally
 *   Phase 2 — Playwright render (concurrency: 2, only for JS-detected pages)
 *     → Render in headless Chromium, extract same body-only content
 *
 * Body-only rule (unchanged):
 *   Every opportunity comes from real visible <p> and <li> elements inside a
 *   known main-content container. No title / meta / heading / JSON-LD fallback.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as cheerio from 'cheerio';
import { extractMainContent, findCrossPageBoilerplate } from '../../lib/extractor.js';
import {
  extractKeywords,
  extractTopics,
  detectPageType,
  analyzeOpportunities,
  buildSummary,
  normalizeURL,
} from '../../lib/analyzer.js';
import {
  isJSRendered,
  openBrowser,
  closeBrowser,
  renderWithBrowser,
} from '../../lib/renderer.js';

// ── Config ────────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS   = 30000;
const RENDER_TIMEOUT_MS  = 45000;
const MAX_RETRIES        = 1;
const RAW_CONCURRENCY    = 5;
const RENDER_CONCURRENCY = 2;
const MAX_URLS_PER_REQ   = 60;

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

// ─────────────────────────────────────────────────────────────────────────────
//  CONTROLLED CONCURRENCY
// ─────────────────────────────────────────────────────────────────────────────
async function concurrentMap(items, fn, concurrency) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.allSettled(workers);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const { urls = [], settings = {} } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0)
    return res.status(400).json({ error: 'No URLs provided.' });

  const cleanURLs = [...new Set(urls.map(u => u.trim()).filter(u => u.startsWith('http')))];

  if (cleanURLs.length < 2)
    return res.status(400).json({
      error: 'Please enter at least 2 URLs. Internal linking requires comparing multiple pages.',
    });

  if (cleanURLs.length > MAX_URLS_PER_REQ)
    return res.status(400).json({
      error: `Maximum ${MAX_URLS_PER_REQ} URLs per request. Please trim the list.`,
    });

  const invalid = cleanURLs.filter(u => { try { new URL(u); return false; } catch { return true; } });
  if (invalid.length)
    return res.status(400).json({ error: `Invalid URL(s): ${invalid.slice(0, 3).join(', ')}` });

  const domains = [...new Set(cleanURLs.map(u => {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  }).filter(Boolean))];

  if (domains.length > 1)
    return res.status(400).json({
      error: `All URLs must be from the same domain. Found: ${domains.join(', ')}`,
    });

  // ── Deduplicate ───────────────────────────────────────────────────────────
  const normSeen = new Set();
  const skipped  = [];
  const toFetch  = [];

  for (const url of cleanURLs) {
    const norm = normalizeURL(url);
    if (normSeen.has(norm)) {
      skipped.push({ url, reason: 'duplicate', details: `Normalized duplicate of ${norm}` });
    } else {
      normSeen.add(norm);
      toFetch.push(url);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PHASE 1 — Raw HTTP fetch (concurrency: 5)
  // ─────────────────────────────────────────────────────────────────────────
  const phase1 = await concurrentMap(
    toFetch,
    url => rawFetchAndProcess(url, settings),
    RAW_CONCURRENCY
  );

  // Partition results
  const rawSuccess  = phase1.filter(r => r.success);
  const needsRender = phase1.filter(r => r.jsDetected);
  const rawFailed   = phase1.filter(r => !r.success && !r.jsDetected && !r.skipped);
  const rawSkipped  = phase1.filter(r => r.skipped);

  rawSkipped.forEach(r => skipped.push(r.skipped));

  // ─────────────────────────────────────────────────────────────────────────
  //  PHASE 2 — Playwright render (concurrency: 2, JS-detected pages only)
  // ─────────────────────────────────────────────────────────────────────────
  let renderSuccess = [];
  let renderFailed  = [];
  let renderNoBody  = [];
  let browser       = null;

  if (needsRender.length > 0) {
    browser = await openBrowser();

    if (browser) {
      const phase2 = await concurrentMap(
        needsRender,
        r => renderAndProcess(r.url, settings, browser),
        RENDER_CONCURRENCY
      );
      renderSuccess = phase2.filter(r => r.success);
      renderFailed  = phase2.filter(r => !r.success && !r.noBody);
      renderNoBody  = phase2.filter(r => r.noBody);
    } else {
      // Playwright not installed
      renderFailed = needsRender.map(r => ({
        url:     r.url,
        success: false,
        status:  'failed:render-unavailable',
        message: '✗ Playwright not available — run: npm install playwright',
      }));
    }

    await closeBrowser(browser);
  }

  // ── Collect page data ──────────────────────────────────────────────────────
  const pages = [
    ...rawSuccess.filter(r => r.pageData).map(r => r.pageData),
    ...renderSuccess.filter(r => r.pageData).map(r => r.pageData),
  ];

  // ── Build fetch log ────────────────────────────────────────────────────────
  const fetchLog = [
    ...rawSuccess.map(r => ({
      url: r.url, success: true,
      status: 'success:raw', message: r.message,
    })),
    ...rawFailed.map(r => ({
      url: r.url, success: false,
      status: r.status, message: r.message,
    })),
    ...needsRender.map(r => ({
      url: r.url, success: false,
      status: 'js-detected', message: `⟳ JS-rendered page detected — sending to renderer`,
    })),
    ...renderSuccess.map(r => ({
      url: r.url, success: true,
      status: 'success:rendered', message: r.message,
    })),
    ...renderFailed.map(r => ({
      url: r.url, success: false,
      status: r.status, message: r.message,
    })),
    ...renderNoBody.map(r => ({
      url: r.url, success: false,
      status: 'no-body-content', message: r.message,
    })),
  ];

  // ── Cross-page boilerplate fingerprinting ─────────────────────────────────
  let boilerplateRemovedCount = 0;
  if (pages.length >= 3) {
    const bpSet = findCrossPageBoilerplate(pages);
    if (bpSet.size > 0) {
      pages.forEach(p => {
        const before = p.paragraphs.length;
        const kept = p.paragraphs.reduce((acc, text, i) => {
          if (!bpSet.has(text)) acc.push({ text, pos: p.paragraphPositions?.[i] ?? 0.5 });
          return acc;
        }, []);
        p.paragraphs         = kept.map(k => k.text);
        p.paragraphCount     = p.paragraphs.length;
        const total = p.paragraphs.length;
        p.paragraphPositions = p.paragraphs.map((_, i) =>
          total <= 1 ? 0 : parseFloat((i / (total - 1)).toFixed(3))
        );
        boilerplateRemovedCount += before - p.paragraphs.length;
      });
    }
  }

  // ── Inbound link counts ────────────────────────────────────────────────────
  const normSet    = new Set(pages.map(p => p.normalizedURL));
  const inboundMap = {};
  pages.forEach(p => { inboundMap[p.normalizedURL] = 0; });
  pages.forEach(src => {
    src.existingLinks.forEach(link => {
      if (normSet.has(link)) inboundMap[link] = (inboundMap[link] || 0) + 1;
    });
  });
  pages.forEach(p => {
    p.inboundCount = inboundMap[p.normalizedURL] || 0;
    p.isOrphan     = p.inboundCount === 0;
  });

  // ── Analyze opportunities ──────────────────────────────────────────────────
  const opps    = pages.length >= 2 ? analyzeOpportunities(pages, settings) : [];
  const summary = buildSummary(fetchLog, pages, skipped, opps);

  // ── Extended summary counters (v4.3) ──────────────────────────────────────
  summary.rawFetched              = rawSuccess.length;
  summary.jsDetected              = needsRender.length;
  summary.rendered                = renderSuccess.length;
  summary.renderFailed            = renderFailed.length;
  summary.noBodyContent           = [
    ...phase1.filter(r => r.noBody),
    ...renderNoBody,
  ].length;
  summary.fetchFailed             = rawFailed.length;
  summary.boilerplateRemovedCount = boilerplateRemovedCount;
  summary.playwrightAvailable     = browser !== null || needsRender.length === 0;

  // ── Annotate pages with no opportunities ──────────────────────────────────
  const srcWithOpps = new Set(opps.map(o => normalizeURL(o.sourceURL)));
  pages.forEach(p => {
    if (!srcWithOpps.has(p.normalizedURL))
      p.noOpportunityReason = diagnoseNoOpportunity(p, pages, opps, settings);
  });

  return res.status(200).json({ fetchLog, pages, skipped, opportunities: opps, summary });
}

// ─────────────────────────────────────────────────────────────────────────────
//  PHASE 1 — Raw fetch + detect JS rendering
// ─────────────────────────────────────────────────────────────────────────────
async function rawFetchAndProcess(url, settings) {
  const fetchResult = await fetchURL(url);

  if (!fetchResult.success)
    return { url, success: false, status: fetchResult.status, message: fetchResult.message };

  const html = fetchResult.html;

  // ── Detect JS-rendered page ───────────────────────────────────────────────
  if (isJSRendered(html)) {
    return { url, jsDetected: true, success: false, status: 'js-detected' };
  }

  // ── Process raw HTML ──────────────────────────────────────────────────────
  return processHTML(url, html, settings, false);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PHASE 2 — Playwright render + process
// ─────────────────────────────────────────────────────────────────────────────
async function renderAndProcess(url, settings, browser) {
  const result = await renderWithBrowser(browser, url, { timeout: RENDER_TIMEOUT_MS });

  if (!result.success) {
    return {
      url, success: false,
      status:  result.status,
      message: result.status === 'failed:render-timeout'
        ? `✗ Failed: render timeout after ${RENDER_TIMEOUT_MS / 1000}s`
        : result.status === 'failed:render-unavailable'
        ? `✗ Failed: render unavailable — ${result.error}`
        : `✗ Failed: render error — ${result.error}`,
    };
  }

  return processHTML(url, result.html, settings, true);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED HTML PROCESSING  (used by both phases)
// ─────────────────────────────────────────────────────────────────────────────
function processHTML(url, html, settings, isRendered) {
  const $ = cheerio.load(html, { decodeEntities: true });

  // ── noindex check ─────────────────────────────────────────────────────────
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  if (robotsMeta.includes('noindex')) {
    return {
      url, success: false, status: 'skipped:noindex',
      message: '⊘ Skipped: noindex meta tag',
      skipped: true,
      skippedObj: { url, reason: 'noindex', details: 'Page has <meta name="robots" content="noindex">' },
    };
  }

  // ── canonical check ───────────────────────────────────────────────────────
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) {
    try {
      if (normalizeURL(canonical) !== normalizeURL(url) && canonical !== url) {
        return {
          url, success: false, status: 'skipped:canonical',
          message: `⊘ Skipped: canonicalized to ${canonical}`,
          skipped: true,
          skippedObj: { url, reason: 'canonical', details: `Canonical: ${canonical}` },
        };
      }
    } catch {}
  }

  // ── Extract meta ──────────────────────────────────────────────────────────
  const title    = ($('title').text() || '').replace(/\s+/g, ' ').trim();
  const metaDesc = $('meta[name="description"]').attr('content')
                || $('meta[property="og:description"]').attr('content')
                || '';
  const h1       = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim();

  // ── Extract main body content ─────────────────────────────────────────────
  const {
    paragraphs,
    paragraphPositions,
    headings,
    extractionMethod,
    confidence,
  } = extractMainContent($, {
    minParagraphWords:     settings.minParagraphWords || 10,
    extraExcludeSelectors: settings.excludeSelectors  || '',
    extraIncludeSelectors: settings.includeSelectors  || '',
  });

  // ── No valid body content ─────────────────────────────────────────────────
  if (paragraphs.length < 1) {
    return {
      url, success: false, noBody: true,
      status:  isRendered ? 'no-body-content:rendered' : 'no-body-content:raw',
      message: `⊘ No valid body paragraph found after ${isRendered ? 'rendered' : 'raw'} extraction via "${extractionMethod}". No title/meta/heading fallback applied.`,
    };
  }

  // ── Internal links ────────────────────────────────────────────────────────
  const baseHost = new URL(url).hostname.replace(/^www\./, '');
  const existingLinkSet = new Set();
  $('a[href]').each((_, el) => {
    try {
      const href = $(el).attr('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      const abs  = new URL(href, url).href;
      const host = new URL(abs).hostname.replace(/^www\./, '');
      if (host === baseHost) existingLinkSet.add(normalizeURL(abs));
    } catch {}
  });

  const fullText = [title, metaDesc, h1, ...headings.map(h => h.text), ...paragraphs].join(' ');
  const keywords = extractKeywords(fullText);
  const topics   = extractTopics(title, h1, headings, metaDesc);
  const pageType = detectPageType(url, title);

  return {
    url,
    success: true,
    status:  isRendered ? 'success:rendered' : 'success:raw',
    message: `✓ ${isRendered ? 'Successfully analyzed: rendered HTML' : 'Successfully analyzed: raw HTML'} — ${paragraphs.length} body paragraph(s) via "${extractionMethod}" (${Math.round(confidence * 100)}% confidence)`,
    pageData: {
      url,
      normalizedURL:       normalizeURL(url),
      title:               title || url,
      metaDesc, h1, headings,
      paragraphs,
      paragraphPositions,
      existingLinks:       [...existingLinkSet],
      keywords, topics, pageType,
      extractionMethod:    isRendered ? `${extractionMethod} [rendered]` : extractionMethod,
      confidence,
      wordCount:           fullText.split(/\s+/).length,
      paragraphCount:      paragraphs.length,
      sourceType:          'main-body',
      renderMethod:        isRendered ? 'playwright' : 'raw',
      inboundCount:        0,
      isOrphan:            false,
      error:               false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  RAW HTTP FETCH  (30 s timeout, retry once)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchURL(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal, headers: FETCH_HEADERS, redirect: 'follow' });
    clearTimeout(timer);

    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (!res.ok) {
      const m = { 403:'Access forbidden', 404:'Not found', 429:'Rate limited', 500:'Server error', 503:'Service unavailable' };
      return { success: false, status: `failed:http-${res.status}`, message: `✗ Failed: ${m[res.status] || `HTTP ${res.status}`}` };
    }
    if (!ct.includes('html') && !ct.includes('text')) {
      return { success: false, status: 'skipped:non-html', message: `⊘ Skipped: non-HTML response (${ct})` };
    }

    const html = await res.text();
    if (!html || html.trim().length < 100)
      return { success: false, status: 'failed:empty', message: '✗ Failed: Empty response' };

    return { success: true, html };

  } catch (err) {
    clearTimeout(timer);
    const isRetryable = err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    if (isRetryable && attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 1500));
      return fetchURL(url, attempt + 1);
    }
    if (err.name === 'AbortError')       return { success: false, status: 'failed:raw-fetch-timeout', message: `✗ Failed: Raw fetch timeout after ${FETCH_TIMEOUT_MS / 1000}s` };
    if (err.code === 'ECONNREFUSED')     return { success: false, status: 'failed:refused',           message: '✗ Failed: Connection refused' };
    if (err.code === 'ENOTFOUND')        return { success: false, status: 'failed:dns',               message: '✗ Failed: Domain not found' };
    if (err.code === 'CERT_HAS_EXPIRED') return { success: false, status: 'failed:ssl',               message: '✗ Failed: SSL certificate error' };
    return { success: false, status: 'failed:error', message: `✗ Failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DIAGNOSE WHY A PAGE HAS NO OPPORTUNITIES
// ─────────────────────────────────────────────────────────────────────────────
function diagnoseNoOpportunity(page, allPages, opps, settings) {
  const minScore = settings.minScore || 3;

  if (page.paragraphs.length < 1)
    return 'No valid body paragraphs extracted from this page';

  const alreadyLinked = allPages.filter(
    t => t.normalizedURL !== page.normalizedURL && page.existingLinks.includes(t.normalizedURL)
  );
  if (alreadyLinked.length === allPages.length - 1)
    return 'Already links to every other page in the set';

  const hasAnyTgt = opps.some(o => normalizeURL(o.targetURL) === page.normalizedURL);
  if (!hasAnyTgt)
    return `No natural anchor text found matching other pages' topics (min score: ${minScore}/10)`;

  return `All suggestions below minimum score threshold (${minScore}/10)`;
}
