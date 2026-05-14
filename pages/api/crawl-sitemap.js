/**
 * pages/api/crawl-sitemap.js  (v3.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * POST handler: discover URLs for a domain via sitemap.xml / robots.txt.
 *
 * Request body:
 *   { targetURL: string, maxUrls?: number, manualSitemapURLs?: string[] }
 *
 * Response:
 *   { domain, sitemapSource, urls: string[], count, childCount, error }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { fetchSitemapURLs } from '../../lib/sitemap.js';

const DEFAULT_MAX_SITEMAP_URLS = 500;

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const {
    targetURL,
    maxUrls = DEFAULT_MAX_SITEMAP_URLS,
    manualSitemapURLs = [],
  } = req.body || {};

  if (!targetURL || typeof targetURL !== 'string')
    return res.status(400).json({ error: 'targetURL is required.' });

  let domain;
  try {
    domain = new URL(targetURL).hostname.replace(/^www\./, '');
  } catch {
    return res.status(400).json({ error: 'Invalid targetURL.' });
  }

  const manualURLs = Array.isArray(manualSitemapURLs)
    ? manualSitemapURLs.filter(u => u && u.startsWith('http'))
    : [];

  const result = await fetchSitemapURLs(domain, Math.min(maxUrls, 1000), manualURLs);

  // Filter to same domain
  const filtered = result.urls.filter(u => {
    try {
      return new URL(u).hostname.replace(/^www\./, '') === domain;
    } catch { return false; }
  });

  // Exclude the target URL itself from candidates
  const targetNorm = normalizeURL(targetURL);
  const candidates = filtered.filter(u => normalizeURL(u) !== targetNorm);

  return res.status(200).json({
    domain,
    sitemapSource:  result.sitemapSource,
    urls:           candidates,
    count:          candidates.length,
    totalFound:     result.totalFound || result.urls.length,
    childCount:     result.childSitemaps?.length || 0,
    childSitemaps:  result.childSitemaps || [],
    error:          result.error,
  });
}

function normalizeURL(url) {
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.hostname.replace(/^www\./, '')}${path}`.toLowerCase();
  } catch { return url.toLowerCase(); }
}
