/**
 * lib/sitemap.js  (v3.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Sitemap discovery and URL extraction with full debug output.
 *
 * Changes v3.1:
 *  - fetchSitemapURLs returns rich debug: childSitemaps, failedFetches, log
 *  - mergeManualSitemapURLs: accepts manually-provided sitemap URLs, merges
 *    them with auto-discovered results
 *  - No silent cap: always returns as many URLs as found (caller applies limit)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_MAX_URLS = 1000;

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/xml,application/xml,text/html,text/plain,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discover and return up to `maxUrls` URLs for the given domain.
 *
 * @param {string}   domain            — hostname without protocol, e.g. "contify.com"
 * @param {number}   maxUrls           — hard cap on returned URLs
 * @param {string[]} manualSitemapURLs — user-supplied sitemap URLs to fetch
 * @returns {Promise<SitemapResult>}
 */
export async function fetchSitemapURLs(domain, maxUrls = DEFAULT_MAX_URLS, manualSitemapURLs = []) {
  const origin  = `https://${domain}`;
  const urlSet  = new Set();
  const log     = [];
  const childSitemapDetails = [];
  const failedFetches       = [];

  // ── Step 1: robots.txt ────────────────────────────────────────────────────
  const robotsSitemaps = await getSitemapsFromRobots(origin, log);

  // ── Step 2: Build candidate sitemap URLs ─────────────────────────────────
  const autoCandidates = [
    ...robotsSitemaps,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    `${origin}/sitemap/sitemap-index.xml`,
    `${origin}/news-sitemap.xml`,
    `${origin}/page-sitemap.xml`,
    `${origin}/post-sitemap.xml`,
  ];

  // ── Step 3: Merge manual sitemap URLs ────────────────────────────────────
  const allCandidates = [
    ...manualSitemapURLs.filter(u => u && u.startsWith('http')),
    ...autoCandidates,
  ];

  const tried    = new Set();
  let   sitemapSrc = null;

  for (const sitemapURL of allCandidates) {
    if (tried.has(sitemapURL)) continue;
    tried.add(sitemapURL);

    const result = await fetchAndParseSitemapDebug(sitemapURL, origin, log, childSitemapDetails, failedFetches);
    if (result.error) continue;

    result.urls.forEach(u => urlSet.add(u));
    if (!sitemapSrc && result.urls.length > 0) sitemapSrc = sitemapURL;

    // If manual URLs were provided, don't stop early — fetch all of them
    const isManual = manualSitemapURLs.includes(sitemapURL);
    if (!isManual && urlSet.size >= 10 && robotsSitemaps.includes(sitemapURL)) break;
  }

  const finalURLs = [...urlSet].slice(0, maxUrls);

  return {
    urls:             finalURLs,
    totalFound:       urlSet.size,
    sitemapSource:    sitemapSrc || null,
    childSitemaps:    childSitemapDetails,
    failedFetches,
    log,
    error: finalURLs.length === 0 ? 'No URLs found in any sitemap' : null,
  };
}

/**
 * Parse a sitemap XML string.
 * Handles both urlset (regular sitemap) and sitemapindex.
 */
export function parseSitemapText(xml, origin = '') {
  const urls          = [];
  const childSitemaps = [];

  const isIndex = /<sitemapindex/i.test(xml);

  if (isIndex) {
    const sitemapBlocks = xml.match(/<sitemap[\s\S]*?<\/sitemap>/gi) || [];
    for (const block of sitemapBlocks) {
      const loc = extractLoc(block);
      if (loc) childSitemaps.push(loc);
    }
  } else {
    // Try <url><loc>…</loc></url> blocks first
    const urlBlocks = xml.match(/<url[\s\S]*?<\/url>/gi) || [];
    for (const block of urlBlocks) {
      const loc = extractLoc(block);
      if (loc && isHTMLURL(loc)) urls.push(loc);
    }

    // Fallback: flat <loc>…</loc> tags (some CMS plugins omit <url> wrapper)
    if (urls.length === 0) {
      const allLocs = xml.match(/<loc>([\s\S]*?)<\/loc>/gi) || [];
      for (const locTag of allLocs) {
        const u = extractLoc(locTag);
        if (u && isHTMLURL(u)) urls.push(u);
      }
    }
  }

  return { urls, isIndex, childSitemaps };
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAndParseSitemapDebug(sitemapURL, origin, log, childSitemapDetails, failedFetches) {
  const fetchResult = await fetchText(sitemapURL);
  if (!fetchResult.ok) {
    log.push(`✗ Failed to fetch sitemap: ${sitemapURL} — ${fetchResult.error}`);
    failedFetches.push({ url: sitemapURL, error: fetchResult.error });
    return { urls: [], error: fetchResult.error };
  }

  const { urls, isIndex, childSitemaps } = parseSitemapText(fetchResult.text, origin);

  if (!isIndex) {
    log.push(`✓ Sitemap: ${sitemapURL} → ${urls.length} URLs`);
    childSitemapDetails.push({ url: sitemapURL, type: 'urlset', urlCount: urls.length });
    return { urls, error: null };
  }

  // It's a sitemap index — fetch all child sitemaps
  log.push(`✓ Sitemap index: ${sitemapURL} → ${childSitemaps.length} child sitemaps`);
  childSitemapDetails.push({ url: sitemapURL, type: 'index', childCount: childSitemaps.length, urlCount: 0 });

  const allURLs = [];
  for (const childURL of childSitemaps) {
    const childResult = await fetchText(childURL);
    if (!childResult.ok) {
      log.push(`  ✗ Child sitemap failed: ${childURL} — ${childResult.error}`);
      failedFetches.push({ url: childURL, error: childResult.error });
      continue;
    }
    const parsed = parseSitemapText(childResult.text, origin);
    log.push(`  ✓ Child sitemap: ${childURL} → ${parsed.urls.length} URLs`);
    childSitemapDetails.push({ url: childURL, type: 'urlset', urlCount: parsed.urls.length });
    parsed.urls.forEach(u => allURLs.push(u));
  }

  return { urls: allURLs, error: null };
}

async function getSitemapsFromRobots(origin, log) {
  const result = await fetchText(`${origin}/robots.txt`);
  if (!result.ok) {
    log.push(`⚠ robots.txt not found or inaccessible`);
    return [];
  }
  const sitemaps = [];
  const lines    = result.text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^sitemap:\s*(.+)/i);
    if (m) {
      const url = m[1].trim();
      if (url.startsWith('http')) sitemaps.push(url);
    }
  }
  if (sitemaps.length > 0) log.push(`✓ robots.txt → ${sitemaps.length} sitemap(s): ${sitemaps.join(', ')}`);
  else log.push(`⚠ robots.txt found but no Sitemap: directive`);
  return sitemaps;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: FETCH_HEADERS, redirect: 'follow' });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    return { ok: true, text };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { ok: false, error: `Timeout after ${FETCH_TIMEOUT_MS/1000}s` };
    return { ok: false, error: err.message };
  }
}

function extractLoc(block) {
  const m = block.match(/<loc>([\s\S]*?)<\/loc>/i);
  if (!m) return null;
  return decodeEntities(m[1].trim());
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'");
}

function isHTMLURL(url) {
  if (!url || !url.startsWith('http')) return false;
  const lower = url.toLowerCase().split('?')[0];
  return !/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp4|mp3|css|js|json|xml|rss|atom|ico|woff|woff2|ttf)(\?|$)/i.test(lower);
}
