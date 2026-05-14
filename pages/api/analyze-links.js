/**
 * pages/api/analyze-links.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side URL fetcher + content extractor + opportunity analyzer.
 *
 * All fetch calls happen here (Node.js), not in the browser.
 * This completely bypasses CORS — works for any website.
 *
 * Domain-agnostic: zero hardcoded brand names, URL paths, or selectors.
 *
 * v2 improvements:
 *  - paragraphPositions is stored in pageData and forwarded to the analyzer.
 *  - Cross-page boilerplate fingerprinting removes paragraphs that appear
 *    verbatim on 3+ pages (site-wide template text such as author bio
 *    templates or category intro blocks).
 *  - boilerplateRemovedCount included in summary for transparency.
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

// ── Config ────────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 15000;
const MAX_URLS_PER_REQ = 60;

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
//  MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const { urls = [], settings = {} } = req.body || {};

  // ── Validate ──────────────────────────────────────────────────────────────
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

  // Validate URL format
  const invalid = cleanURLs.filter(u => {
    try { new URL(u); return false; } catch { return true; }
  });
  if (invalid.length)
    return res.status(400).json({ error: `Invalid URL(s): ${invalid.slice(0, 3).join(', ')}` });

  // ── Check same domain ─────────────────────────────────────────────────────
  const domains = [...new Set(cleanURLs.map(u => {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  }).filter(Boolean))];

  if (domains.length > 1)
    return res.status(400).json({
      error: `All URLs must be from the same domain. Found: ${domains.join(', ')}`,
    });

  // ── Deduplicate normalized URLs ────────────────────────────────────────────
  const normSeen = new Set();
  const skipped  = [];
  const toFetch  = [];

  for (const url of cleanURLs) {
    const norm = normalizeURL(url);
    if (normSeen.has(norm)) {
      skipped.push({
        url,
        reason: 'duplicate',
        details: `Normalized duplicate of a previously seen URL (${norm})`,
      });
    } else {
      normSeen.add(norm);
      toFetch.push(url);
    }
  }

  // ── Fetch all pages in parallel (server-side — no CORS) ───────────────────
  const fetchResults = await Promise.all(
    toFetch.map(url => fetchAndProcess(url, settings))
  );

  // Separate into fetch log and successful page data
  const fetchLog = fetchResults.map(r => ({
    url:          r.url,
    success:      r.success,
    status:       r.status,
    message:      r.message,
    redirectedTo: r.redirectedTo || null,
  }));

  // Collect per-page skips (noindex, canonical mismatch, thin content)
  fetchResults.forEach(r => {
    if (r.skipped) skipped.push(r.skipped);
  });

  const pages = fetchResults.filter(r => r.success && r.pageData).map(r => r.pageData);

  // ── Cross-page boilerplate fingerprinting ──────────────────────────────────
  // Remove paragraphs that appear verbatim on 3+ pages (site-wide templates).
  // This catches author bio templates, category intros, footer disclaimers, etc.
  // that passed per-page extraction but are clearly site-wide boilerplate.
  let boilerplateRemovedCount = 0;
  if (pages.length >= 3) {
    const bpSet = findCrossPageBoilerplate(pages);
    if (bpSet.size > 0) {
      pages.forEach(p => {
        const before = p.paragraphs.length;

        // Filter out boilerplate, keeping positions in sync
        const kept = p.paragraphs.reduce((acc, text, i) => {
          if (!bpSet.has(text)) acc.push({ text, pos: p.paragraphPositions?.[i] ?? 0.5 });
          return acc;
        }, []);

        p.paragraphs         = kept.map(k => k.text);
        p.paragraphCount     = p.paragraphs.length;

        // Recompute relative positions after filtering
        const total = p.paragraphs.length;
        p.paragraphPositions = p.paragraphs.map((_, i) =>
          total <= 1 ? 0 : parseFloat((i / (total - 1)).toFixed(3))
        );

        boilerplateRemovedCount += before - p.paragraphs.length;
      });
    }
  }

  // ── Compute inbound link counts (from existing on-page links) ─────────────
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

  // ── Discover opportunities ────────────────────────────────────────────────
  const opps    = pages.length >= 2 ? analyzeOpportunities(pages, settings) : [];
  const summary = buildSummary(fetchLog, pages, skipped, opps);

  // Attach boilerplate removal info to summary for transparency
  summary.boilerplateRemovedCount = boilerplateRemovedCount;

  // ── Annotate pages with no outgoing opportunities ─────────────────────────
  const srcWithOpps = new Set(opps.map(o => normalizeURL(o.sourceURL)));
  pages.forEach(p => {
    if (!srcWithOpps.has(p.normalizedURL)) {
      p.noOpportunityReason = diagnoseNoOpportunity(p, pages, opps, settings);
    }
  });

  return res.status(200).json({
    fetchLog,
    pages,
    skipped,
    opportunities: opps,
    summary,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  FETCH + PARSE A SINGLE URL
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAndProcess(url, settings = {}) {
  const fetchResult = await fetchURL(url);

  if (!fetchResult.success) {
    return {
      url,
      success: false,
      status:  fetchResult.status,
      message: fetchResult.message,
    };
  }

  const html = fetchResult.html;

  // ── Parse with Cheerio ────────────────────────────────────────────────────
  const $ = cheerio.load(html, { decodeEntities: true });

  // ── Check noindex ─────────────────────────────────────────────────────────
  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  if (robotsMeta.includes('noindex')) {
    return {
      url,
      success: false,
      status:  'skipped:noindex',
      message: '⊘ Skipped: noindex meta tag found — search engines ignore this page',
      skipped: {
        url,
        reason:  'noindex',
        details: 'Page has <meta name="robots" content="noindex">',
      },
    };
  }

  // ── Check canonical ───────────────────────────────────────────────────────
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) {
    try {
      const canonNorm = normalizeURL(canonical);
      const selfNorm  = normalizeURL(url);
      if (canonNorm !== selfNorm && canonical !== url) {
        return {
          url,
          success:      false,
          status:       'skipped:canonical',
          message:      `⊘ Skipped: canonicalized to ${canonical}`,
          redirectedTo: canonical,
          skipped: {
            url,
            reason:  'canonical',
            details: `Canonical points to: ${canonical}`,
          },
        };
      }
    } catch {}
  }

  // ── Extract meta ───────────────────────────────────────────────────────────
  const title    = ($('title').text() || '').replace(/\s+/g, ' ').trim();
  const metaDesc = $('meta[name="description"]').attr('content')
                || $('meta[property="og:description"]').attr('content')
                || '';
  const h1       = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim();

  // ── Extract main body content (paragraphs + positions) ────────────────────
  // extractMainContent now also returns `paragraphPositions` (0–1 per paragraph)
  const {
    paragraphs,
    paragraphPositions,
    headings,
    extractionMethod,
    confidence,
  } = extractMainContent($, {
    minParagraphWords:     settings.minParagraphWords || 15,
    extraExcludeSelectors: settings.excludeSelectors  || '',
    extraIncludeSelectors: settings.includeSelectors  || '',
  });

  // ── Check content thinness ────────────────────────────────────────────────
  if (paragraphs.length < 2) {
    return {
      url,
      success: false,
      status:  'skipped:thin-content',
      message: `⊘ Skipped: only ${paragraphs.length} body paragraph(s) found — content too thin or extraction failed`,
      skipped: {
        url,
        reason:  'thin-content',
        details: `Extracted ${paragraphs.length} paragraphs via "${extractionMethod}" (confidence ${Math.round(confidence * 100)}%)`,
      },
    };
  }

  // ── Extract internal links from the full page ─────────────────────────────
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

  // ── Build keywords and topics ─────────────────────────────────────────────
  const fullText = [title, metaDesc, h1, ...headings.map(h => h.text), ...paragraphs].join(' ');
  const keywords = extractKeywords(fullText);
  const topics   = extractTopics(title, h1, headings, metaDesc);
  const pageType = detectPageType(url, title);

  const pageData = {
    url,
    normalizedURL:       normalizeURL(url),
    title:               title || url,
    metaDesc,
    h1,
    headings,
    paragraphs,
    paragraphPositions,   // parallel array of relative positions 0–1
    existingLinks:        [...existingLinkSet],
    keywords,
    topics,
    pageType,
    extractionMethod,
    confidence,
    wordCount:            fullText.split(/\s+/).length,
    paragraphCount:       paragraphs.length,
    inboundCount:         0,    // filled in later
    isOrphan:             false,
    error:                false,
  };

  return {
    url,
    success: true,
    status:  'success',
    message: `✓ Fetched — ${paragraphs.length} body paragraphs via "${extractionMethod}" (${Math.round(confidence * 100)}% confidence)`,
    pageData,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  RAW HTTP FETCH  (server-side — no CORS)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchURL(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal:   controller.signal,
      headers:  FETCH_HEADERS,
      redirect: 'follow',
    });
    clearTimeout(timer);

    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (!res.ok) {
      const statusMap = {
        403: 'Access forbidden — server blocked the request',
        404: 'Page not found (404)',
        429: 'Rate limited — too many requests',
        500: 'Server error (500)',
        503: 'Service unavailable (503)',
      };
      return {
        success: false,
        status:  `failed:http-${res.status}`,
        message: `✗ Failed: ${statusMap[res.status] || `HTTP ${res.status}`}`,
      };
    }

    if (!ct.includes('html') && !ct.includes('text')) {
      return {
        success: false,
        status:  'skipped:non-html',
        message: `⊘ Skipped: non-HTML response (Content-Type: ${ct})`,
        skipped: { url, reason: 'non-html', details: `Content-Type was "${ct}"` },
      };
    }

    const html = await res.text();
    if (!html || html.trim().length < 300) {
      return {
        success: false,
        status:  'failed:empty-response',
        message: '✗ Failed: Response body too short or empty',
      };
    }

    return { success: true, html };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError')
      return { success: false, status: 'failed:timeout',  message: `✗ Failed: Timeout after ${FETCH_TIMEOUT_MS / 1000}s` };
    if (err.code === 'ECONNREFUSED')
      return { success: false, status: 'failed:refused',  message: '✗ Failed: Connection refused' };
    if (err.code === 'ENOTFOUND')
      return { success: false, status: 'failed:dns',      message: '✗ Failed: Domain not found (DNS lookup failed)' };
    if (err.code === 'CERT_HAS_EXPIRED')
      return { success: false, status: 'failed:ssl',      message: '✗ Failed: SSL certificate error' };
    return {
      success: false,
      status:  'failed:error',
      message: `✗ Failed: ${err.message}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXPLAIN WHY A PAGE HAS NO OPPORTUNITIES
// ─────────────────────────────────────────────────────────────────────────────
function diagnoseNoOpportunity(page, allPages, opps, settings) {
  const minScore = settings.minScore || 3;

  if (page.paragraphs.length < 2)
    return 'Content too thin — fewer than 2 body paragraphs extracted';

  const alreadyLinked = allPages.filter(
    t => t.normalizedURL !== page.normalizedURL && page.existingLinks.includes(t.normalizedURL)
  );
  if (alreadyLinked.length === allPages.length - 1)
    return 'Already links to every other page in the set';

  const hasAnySrc = opps.some(o => normalizeURL(o.sourceURL) === page.normalizedURL);
  if (!hasAnySrc) {
    const hasAnyTgt = opps.some(o => normalizeURL(o.targetURL) === page.normalizedURL);
    if (!hasAnyTgt)
      return `No natural anchor text found in body paragraphs that matches other pages' titles/headings (min score: ${minScore}/10)`;
    return `No outgoing opportunities found (page may already link to all relevant targets, or keyword overlap below threshold)`;
  }

  return `All suggestions fell below minimum score threshold (${minScore}/10)`;
}
