/**
 * pages/api/target-page.js — v4.3 Hybrid Extraction Pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 * Target Page Mode: find source pages that should link TO a given target URL.
 *
 * Two-phase fetch (same as analyze-links.js):
 *   Phase 1 — Raw HTTP fetch (concurrency: 5)
 *   Phase 2 — Playwright render for JS-detected pages (concurrency: 2)
 *
 * Body-only rule: every opportunity comes from real visible <p>/<li> elements.
 * No title / meta / heading / JSON-LD fallback.
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
import { fetchSitemapURLs } from '../../lib/sitemap.js';
import { findBestAnchor, classifyAnchorType, getAnchorContext } from '../../lib/anchor.js';
import {
  isJSRendered,
  openBrowser,
  closeBrowser,
  renderWithBrowser,
} from '../../lib/renderer.js';

// ── Config ────────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS    = 30000;
const RENDER_TIMEOUT_MS   = 45000;
const MAX_RETRIES         = 1;
const RAW_CONCURRENCY     = 5;
const RENDER_CONCURRENCY  = 2;
const MAX_CANDIDATE_URLS  = 500;
const DEFAULT_SITEMAP_MAX = 500;

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

  const {
    targetURL         = '',
    candidateURLs     = [],
    manualSitemapURLs = [],
    settings          = {},
  } = req.body || {};

  if (!targetURL || !targetURL.startsWith('http'))
    return res.status(400).json({ error: 'targetURL is required and must start with http.' });

  let targetDomain;
  try {
    targetDomain = new URL(targetURL).hostname.replace(/^www\./, '');
  } catch {
    return res.status(400).json({ error: 'Invalid targetURL.' });
  }

  const diag = {
    targetURL,
    targetDomain,
    sitemapLog:           [],
    sitemapChildDetails:  [],
    sitemapFailedFetches: [],
    sitemapSource:        null,
    discoveredURLs:       0,
    manualSitemapURLs:    manualSitemapURLs.length,
    selectedCandidates:   0,
    rawFetched:           0,
    jsDetected:           0,
    rendered:             0,
    fetchFailed:          0,
    renderFailed:         0,
    noBodyContent:        0,
    scoredPairs:          0,
    oppsBeforeFilter:     0,
    oppsAfterFilter:      0,
    semanticOpps:         0,
    averageScore:         0,
    highestScore:         0,
    top20Scores:          [],
    zeroOppReason:        null,
  };

  // ── Step 1: Fetch target page ──────────────────────────────────────────────
  // The target page also goes through the hybrid pipeline
  const targetRaw = await rawFetchAndProcess(targetURL, settings, true);
  let targetResult = targetRaw;

  if (!targetRaw.success && targetRaw.jsDetected) {
    // Target is JS-rendered — render it
    const browser = await openBrowser();
    try {
      targetResult = await renderAndProcess(targetURL, settings, browser, true);
    } finally {
      await closeBrowser(browser);
    }
  }

  if (!targetResult.success || !targetResult.pageData) {
    diag.zeroOppReason = `Could not fetch/render target page: ${targetResult.message}`;
    return res.status(422).json({ error: diag.zeroOppReason, diagnostics: diag });
  }
  const targetPage = targetResult.pageData;

  // ── Step 2: Resolve candidate source URLs ─────────────────────────────────
  const targetNorm  = normalizeURL(targetURL);
  const maxCandidates = Math.min(
    settings.maxCandidates || MAX_CANDIDATE_URLS,
    MAX_CANDIDATE_URLS
  );
  let resolvedCandidates = [];
  let sitemapError       = null;

  if (Array.isArray(candidateURLs) && candidateURLs.length > 0) {
    resolvedCandidates = candidateURLs
      .map(u => u.trim())
      .filter(u => {
        if (!u.startsWith('http')) return false;
        try { return new URL(u).hostname.replace(/^www\./, '') === targetDomain; }
        catch { return false; }
      })
      .filter(u => normalizeURL(u) !== targetNorm)
      .slice(0, maxCandidates);
    diag.sitemapLog.push(`Using ${resolvedCandidates.length} user-supplied candidate URLs`);
  } else {
    const manualURLs = Array.isArray(manualSitemapURLs)
      ? manualSitemapURLs.filter(u => u && u.startsWith('http'))
      : [];

    const sitemapResult = await fetchSitemapURLs(
      targetDomain,
      settings.maxSitemapURLs || DEFAULT_SITEMAP_MAX,
      manualURLs
    );

    diag.sitemapLog          = sitemapResult.log || [];
    diag.sitemapChildDetails = sitemapResult.childSitemaps || [];
    diag.sitemapFailedFetches= sitemapResult.failedFetches || [];
    diag.sitemapSource       = sitemapResult.sitemapSource;
    diag.discoveredURLs      = sitemapResult.totalFound || sitemapResult.urls.length;
    sitemapError             = sitemapResult.error;

    resolvedCandidates = sitemapResult.urls
      .filter(u => {
        try { return new URL(u).hostname.replace(/^www\./, '') === targetDomain; }
        catch { return false; }
      })
      .filter(u => normalizeURL(u) !== targetNorm)
      .slice(0, maxCandidates);
  }

  diag.selectedCandidates = resolvedCandidates.length;

  if (resolvedCandidates.length === 0) {
    diag.zeroOppReason = sitemapError
      ? `No candidate pages found. Sitemap error: ${sitemapError}`
      : 'No candidate source pages found for this domain.';
    return res.status(422).json({ error: diag.zeroOppReason, diagnostics: diag, sitemapError });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PHASE 1 — Raw fetch all candidates (concurrency: 5)
  // ─────────────────────────────────────────────────────────────────────────
  const phase1 = await concurrentMap(
    resolvedCandidates,
    url => rawFetchAndProcess(url, settings, false),
    RAW_CONCURRENCY
  );

  const rawSuccess  = phase1.filter(r => r.success);
  const needsRender = phase1.filter(r => r.jsDetected);
  const rawFailed   = phase1.filter(r => !r.success && !r.jsDetected && !r.skipped);
  const rawSkipped  = phase1.filter(r => r.skipped);

  diag.rawFetched = rawSuccess.length;
  diag.jsDetected = needsRender.length;

  const skipped = [];
  rawSkipped.forEach(r => skipped.push(r.skippedObj));

  // ─────────────────────────────────────────────────────────────────────────
  //  PHASE 2 — Playwright render (concurrency: 2, JS-detected only)
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
        r => renderAndProcess(r.url, settings, browser, false),
        RENDER_CONCURRENCY
      );
      renderSuccess = phase2.filter(r => r.success);
      renderFailed  = phase2.filter(r => !r.success && !r.noBody);
      renderNoBody  = phase2.filter(r => r.noBody);
    } else {
      renderFailed = needsRender.map(r => ({
        url: r.url, success: false,
        status: 'failed:render-unavailable',
        message: '✗ Playwright not available — run: npm install playwright',
      }));
    }

    await closeBrowser(browser);
  }

  diag.rendered     = renderSuccess.length;
  diag.renderFailed = renderFailed.length;
  diag.fetchFailed  = rawFailed.length;
  diag.noBodyContent = [
    ...phase1.filter(r => r.noBody),
    ...renderNoBody,
  ].length;

  // ── Collect all source pages ──────────────────────────────────────────────
  const sourcePages = [
    ...rawSuccess.filter(r => r.pageData).map(r => r.pageData),
    ...renderSuccess.filter(r => r.pageData).map(r => r.pageData),
  ];

  // ── Build fetch log ───────────────────────────────────────────────────────
  const fetchLog = [
    ...rawSuccess.map(r => ({ url:r.url, success:true,  status:r.status, message:r.message })),
    ...rawFailed.map(r  => ({ url:r.url, success:false, status:r.status, message:r.message })),
    ...needsRender.map(r => ({ url:r.url, success:false, status:'js-detected', message:'⟳ JS-rendered — sending to renderer' })),
    ...renderSuccess.map(r => ({ url:r.url, success:true,  status:r.status, message:r.message })),
    ...renderFailed.map(r  => ({ url:r.url, success:false, status:r.status, message:r.message })),
    ...renderNoBody.map(r  => ({ url:r.url, success:false, status:'no-body-content', message:r.message })),
    ...phase1.filter(r => r.noBody).map(r => ({ url:r.url, success:false, status:'no-body-content', message:r.message })),
  ];

  // ── Step 4: All pages = sources + target ──────────────────────────────────
  const allPages = [...sourcePages, targetPage];

  // ── Step 5: Cross-page boilerplate fingerprinting ─────────────────────────
  if (allPages.length >= 3) {
    const bpSet = findCrossPageBoilerplate(allPages);
    if (bpSet.size > 0) {
      allPages.forEach(p => {
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
      });
    }
  }

  // ── Step 6: Inbound link counts ───────────────────────────────────────────
  const normSet    = new Set(allPages.map(p => p.normalizedURL));
  const inboundMap = {};
  allPages.forEach(p => { inboundMap[p.normalizedURL] = 0; });
  allPages.forEach(src => {
    src.existingLinks.forEach(link => {
      if (normSet.has(link)) inboundMap[link] = (inboundMap[link] || 0) + 1;
    });
  });
  allPages.forEach(p => {
    p.inboundCount = inboundMap[p.normalizedURL] || 0;
    p.isOrphan     = p.inboundCount === 0;
  });

  // ── Step 7: Standard opportunity analysis ─────────────────────────────────
  const strictMinScore = settings.minScore ?? 5;
  const allOpps = allPages.length >= 2
    ? analyzeOpportunities(allPages, {
        ...settings,
        minScore:          strictMinScore,
        minKeywordOverlap: settings.minKeywordOverlap ?? 1,
        customTopics:      Array.isArray(settings.customTopics) ? settings.customTopics : [],
      })
    : [];

  const strictOpps = allOpps.filter(o => normalizeURL(o.targetURL) === targetNorm);
  diag.oppsBeforeFilter = strictOpps.length;

  // ── Step 8: Semantic fallback scoring ─────────────────────────────────────
  const semanticScores = scoreAllCandidates(sourcePages, targetPage, settings);
  diag.scoredPairs = semanticScores.length;

  const strictSrcNorms = new Set(strictOpps.map(o => normalizeURL(o.sourceURL)));
  const semanticOpps   = buildSemanticOpps(semanticScores, targetPage, strictSrcNorms, settings);
  diag.semanticOpps = semanticOpps.length;

  const mergedNorms = new Set(strictOpps.map(o => normalizeURL(o.sourceURL)));
  const fillIns     = semanticOpps.filter(o => !mergedNorms.has(normalizeURL(o.sourceURL)));
  const opportunities = [...strictOpps, ...fillIns].sort((a, b) => b.score - a.score);

  diag.oppsAfterFilter = opportunities.length;
  diag.top20Scores     = semanticScores.slice(0, 20).map(s => ({
    url:          s.source.url,
    title:        s.source.title,
    score:        s.compositeScore,
    sharedKws:    s.sharedKeywords.length,
    cosSim:       s.cosineSimilarity,
    hasAnchor:    s.anchor !== null,
    anchor:       s.anchor,
    alreadyLinks: s.alreadyLinks,
  }));

  if (opportunities.length > 0) {
    diag.averageScore = Math.round(
      (opportunities.reduce((sum, o) => sum + o.score, 0) / opportunities.length) * 10
    ) / 10;
    diag.highestScore = Math.max(...opportunities.map(o => o.score));
  }

  // ── Step 9: Zero-opp reason ───────────────────────────────────────────────
  if (opportunities.length === 0) {
    if (sourcePages.length === 0) {
      diag.zeroOppReason = `No source pages yielded valid body content (${diag.jsDetected} JS-rendered, ${diag.renderFailed} render failures, ${diag.fetchFailed} fetch failures).`;
    } else if (semanticScores.every(s => s.alreadyLinks)) {
      diag.zeroOppReason = 'All fetched pages already link to the target page.';
    } else if (semanticScores.every(s => s.compositeScore < 1)) {
      diag.zeroOppReason = `All ${semanticScores.length} pages scored below 1/10 — target content may be very different from the rest of the site.`;
    } else {
      diag.zeroOppReason = `Scores found but all below minimum threshold (${strictMinScore}/10). Highest: ${Math.max(...semanticScores.map(s => s.compositeScore), 0).toFixed(1)}.`;
    }
  }

  // ── Step 10: Summary ──────────────────────────────────────────────────────
  const summary = buildSummary(fetchLog, sourcePages, skipped, opportunities);
  summary.sitemapSource  = diag.sitemapSource;
  summary.candidateCount = resolvedCandidates.length;
  summary.discoveredURLs = diag.discoveredURLs;
  summary.mode           = 'target-page';
  summary.rawFetched     = diag.rawFetched;
  summary.jsDetected     = diag.jsDetected;
  summary.rendered       = diag.rendered;
  summary.renderFailed   = diag.renderFailed;
  summary.fetchFailed    = diag.fetchFailed;
  summary.noBodyContent  = diag.noBodyContent;

  return res.status(200).json({
    targetPage,
    sourceFetchLog: fetchLog,
    pages:          sourcePages,
    skipped,
    opportunities,
    summary,
    diagnostics:    diag,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  PHASE 1 — Raw fetch + JS detection
// ─────────────────────────────────────────────────────────────────────────────
async function rawFetchAndProcess(url, settings, isTarget = false) {
  const fetchResult = await fetchURL(url);
  if (!fetchResult.success)
    return { url, success: false, status: fetchResult.status, message: fetchResult.message };

  const html = fetchResult.html;

  // Detect JS-rendered (skip for target page — always render if needed)
  if (isJSRendered(html)) {
    return { url, jsDetected: true, success: false, status: 'js-detected' };
  }

  return processHTML(url, html, settings, false, isTarget);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PHASE 2 — Playwright render + process
// ─────────────────────────────────────────────────────────────────────────────
async function renderAndProcess(url, settings, browser, isTarget = false) {
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

  return processHTML(url, result.html, settings, true, isTarget);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED HTML PROCESSING
// ─────────────────────────────────────────────────────────────────────────────
function processHTML(url, html, settings, isRendered, isTarget) {
  const $ = cheerio.load(html, { decodeEntities: true });

  // noindex check (non-target pages only)
  if (!isTarget) {
    const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
    if (robotsMeta.includes('noindex')) {
      return {
        url, success: false, status: 'skipped:noindex',
        message: '⊘ Skipped: noindex',
        skipped: true,
        skippedObj: { url, reason: 'noindex', details: 'Has <meta name="robots" content="noindex">' },
      };
    }
  }

  // canonical check
  if (!isTarget) {
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
  }

  const title    = ($('title').text() || '').replace(/\s+/g, ' ').trim();
  const metaDesc = $('meta[name="description"]').attr('content')
                || $('meta[property="og:description"]').attr('content')
                || '';
  const h1       = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim();

  const { paragraphs, paragraphPositions, headings, extractionMethod, confidence } =
    extractMainContent($, {
      minParagraphWords:     settings.minParagraphWords || 10,
      extraExcludeSelectors: settings.excludeSelectors  || '',
      extraIncludeSelectors: settings.includeSelectors  || '',
    });

  // No valid body content — hard skip (no metadata fallback)
  if (!isTarget && paragraphs.length < 1) {
    return {
      url, success: false, noBody: true,
      status:  isRendered ? 'no-body-content:rendered' : 'no-body-content:raw',
      message: `⊘ No valid body paragraph(s) found after ${isRendered ? 'rendered' : 'raw'} extraction via "${extractionMethod}". No title/meta/heading fallback applied.`,
    };
  }

  // Internal links
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
    message: `✓ ${isRendered ? 'Successfully analyzed: rendered HTML' : 'Successfully analyzed: raw HTML'} — ${paragraphs.length} paragraph(s) via "${extractionMethod}" (${Math.round(confidence * 100)}% confidence)`,
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
//  SEMANTIC SCORING
// ─────────────────────────────────────────────────────────────────────────────
function cosineSim(kwsA, kwsB) {
  if (!kwsA.length || !kwsB.length) return 0;
  const setB = new Set(kwsB);
  const inter = kwsA.filter(k => setB.has(k)).length;
  if (!inter) return 0;
  return inter / Math.sqrt(kwsA.length * kwsB.length);
}

function scoreAllCandidates(sourcePages, target, settings) {
  const tgtKws  = new Set(target.keywords || []);
  const tgtArr  = target.keywords || [];
  const tgtNorm = target.normalizedURL;
  const results = [];

  for (const source of sourcePages) {
    if (source.normalizedURL === tgtNorm) continue;
    const alreadyLinks = source.existingLinks.includes(tgtNorm);
    const srcKws    = source.keywords || [];
    const shared    = srcKws.filter(k => tgtKws.has(k));
    const cosSim_   = cosineSim(srcKws, tgtArr);

    let bestAnchor = null, bestPara = null;
    for (const para of (source.paragraphs || [])) {
      const found = findBestAnchor(para, target, {
        minWords:        settings.minAnchorWords ?? 2,
        allowSingleWord: settings.allowSingleWord ?? false,
        customTopics:    settings.customTopics || [],
      });
      if (found && (!bestAnchor || found.anchorScore > bestAnchor.anchorScore)) {
        bestAnchor = found; bestPara = para;
      }
    }

    const titleOverlap = (source.title || '').toLowerCase().split(/\s+/)
      .filter(w => w.length > 4 && tgtKws.has(w)).length;

    let composite = 0;
    composite += Math.min(4, shared.length * 0.4);
    composite += Math.min(3, cosSim_ * 12);
    if (bestAnchor) composite += Math.min(2, bestAnchor.anchorScore * 0.2);
    composite += Math.min(1, titleOverlap * 0.5);
    composite = Math.round(composite * 10) / 10;

    results.push({
      source,
      sharedKeywords:   shared,
      cosineSimilarity: Math.round(cosSim_ * 1000) / 1000,
      compositeScore:   composite,
      anchor:           bestAnchor?.anchor || null,
      anchorPara:       bestPara,
      alreadyLinks,
      titleOverlap,
    });
  }

  return results.sort((a, b) => b.compositeScore - a.compositeScore);
}

function buildSemanticOpps(semanticScores, target, excludeNorms, settings) {
  const opps = [];
  const MIN_SEMANTIC_SCORE = 0.5;

  for (const s of semanticScores) {
    if (opps.length >= 20) break;
    if (s.alreadyLinks) continue;
    if (s.compositeScore < MIN_SEMANTIC_SCORE) continue;
    if (excludeNorms.has(s.source.normalizedURL)) continue;

    const para = s.anchorPara
      || (s.source.paragraphs?.length > 0 ? s.source.paragraphs[0] : null)
      || s.source.title;
    if (!para) continue;

    const anchor = s.anchor
      || deriveAnchorFromKeywords(s.sharedKeywords, target)
      || (target.h1 || target.title || '').replace(/[\|\-–—].*$/, '').trim().split(/\s+/).slice(0, 4).join(' ');
    if (!anchor) continue;

    const anchorContext = s.anchor
      ? getAnchorContext(para, anchor, 6)
      : `…${para.split(/\s+/).slice(0, 10).join(' ')}…`;

    const priority = s.compositeScore >= 5 ? 'High' : s.compositeScore >= 2.5 ? 'Medium' : 'Low';

    opps.push({
      sourceURL:         s.source.url,
      targetURL:         target.url,
      sourceTitle:       s.source.title,
      targetTitle:       target.title,
      sourcePageType:    s.source.pageType,
      targetPageType:    target.pageType,
      linkType:          `${s.source.pageType}-to-${target.pageType}`,
      existingParagraph: para,
      suggestedAnchor:   anchor,
      anchorContext,
      anchorType:        s.anchor ? classifyAnchorType(anchor, target) : 'semantic',
      updatedParagraph:  s.anchor
        ? para.replace(anchor, `[${anchor}](${target.url})`)
        : `${para}\n\n(Consider adding a link to: [${anchor}](${target.url}))`,
      reason:            buildSemanticReason(s),
      bodyContentReason: `Paragraph extracted via "${s.source.extractionMethod}" (${Math.round((s.source.confidence||0.5)*100)}% confidence)`,
      renderMethod:      s.source.renderMethod || 'raw',
      warnings:          s.anchor ? [] : ['No verbatim anchor found — suggested anchor requires minor content edit'],
      sharedKeywords:    s.sharedKeywords.slice(0, 15),
      paraPosition:      0.5,
      paraPositionLabel: 'Middle',
      score:             Math.round(s.compositeScore),
      confidence:        Math.round(s.cosineSimilarity * 100),
      priority,
      opportunityType:   s.anchor ? 'natural' : 'semantic',
      sourceType:        'main-body',
    });
  }
  return opps;
}

function deriveAnchorFromKeywords(sharedKeywords, target) {
  if (!sharedKeywords.length) return null;
  const tgtKwArr = target.keywords || [];
  for (let i = 0; i < tgtKwArr.length - 1; i++) {
    const bigram = `${tgtKwArr[i]} ${tgtKwArr[i+1]}`;
    if (sharedKeywords.includes(tgtKwArr[i]) || sharedKeywords.includes(tgtKwArr[i+1])) {
      if (bigram.split(/\s+/).length >= 2) return bigram;
    }
  }
  const long = sharedKeywords.find(k => k.split(/\s+/).length >= 2 || k.length >= 8);
  return long || sharedKeywords[0] || null;
}

function buildSemanticReason(s) {
  const parts = [];
  if (s.sharedKeywords.length > 0)
    parts.push(`${s.sharedKeywords.length} shared keywords: ${s.sharedKeywords.slice(0,5).join(', ')}`);
  if (s.cosineSimilarity > 0)
    parts.push(`semantic similarity: ${(s.cosineSimilarity*100).toFixed(1)}%`);
  if (s.anchor)
    parts.push(`natural anchor "${s.anchor}" found in body content`);
  if (s.titleOverlap > 0)
    parts.push(`${s.titleOverlap} target keyword(s) in source title`);
  return parts.join('; ') || 'Low semantic overlap — marginal candidate';
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
    if (!ct.includes('html') && !ct.includes('text'))
      return { success: false, status: 'skipped:non-html', message: `⊘ Skipped: non-HTML (${ct})` };
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
    if (err.name === 'AbortError')       return { success: false, status: 'failed:raw-fetch-timeout', message: `✗ Failed: Raw fetch timeout after ${FETCH_TIMEOUT_MS/1000}s` };
    if (err.code === 'ECONNREFUSED')     return { success: false, status: 'failed:refused',           message: '✗ Failed: Connection refused' };
    if (err.code === 'ENOTFOUND')        return { success: false, status: 'failed:dns',               message: '✗ Failed: Domain not found' };
    if (err.code === 'CERT_HAS_EXPIRED') return { success: false, status: 'failed:ssl',               message: '✗ Failed: SSL certificate error' };
    return { success: false, status: 'failed:error', message: `✗ Failed: ${err.message}` };
  }
}
