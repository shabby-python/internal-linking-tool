/**
 * pages/api/target-page.js  (v3.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Target Page Mode: find source pages that should link TO a target URL.
 *
 * v3.1 fixes:
 *  - MAX_CANDIDATE_URLS raised to 500 (was 80)
 *  - Thin-content pages not skipped — use title/meta/H1/H2 as pseudo-paragraphs
 *  - Semantic fallback scoring: keyword + cosine similarity even without verbatim anchor
 *  - Full diagnostics object in response
 *  - Manual sitemap URLs accepted and merged
 *  - Always return top 20 closest pages (semantic), even if strict score is 0
 *
 * Request body:
 *   {
 *     targetURL:          string,
 *     candidateURLs?:     string[],
 *     manualSitemapURLs?: string[],
 *     settings?:          object,
 *   }
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

// ── Config ────────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS    = 15000;
const MAX_CANDIDATE_URLS  = 500;   // v3.1: raised from 80
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
//  MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const {
    targetURL      = '',
    candidateURLs  = [],
    manualSitemapURLs = [],
    settings       = {},
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
    sitemapLog:        [],
    sitemapChildDetails: [],
    sitemapFailedFetches: [],
    sitemapSource:     null,
    discoveredURLs:    0,
    manualSitemapURLs: manualSitemapURLs.length,
    selectedCandidates: 0,
    fetchedPages:      0,
    skippedPages:      0,
    thinContentPages:  0,
    scoredPairs:       0,
    oppsBeforeFilter:  0,
    oppsAfterFilter:   0,
    semanticOpps:      0,
    averageScore:      0,
    highestScore:      0,
    rejectionReasons:  {},
    top20Scores:       [],
    zeroOppReason:     null,
  };

  // ── Step 1: Fetch target page ──────────────────────────────────────────────
  const targetResult = await fetchAndProcess(targetURL, settings, true);
  if (!targetResult.success || !targetResult.pageData) {
    diag.zeroOppReason = `Could not fetch target page: ${targetResult.message}`;
    return res.status(422).json({ error: diag.zeroOppReason, diagnostics: diag });
  }
  const targetPage = targetResult.pageData;

  // ── Step 2: Resolve candidate source URLs ─────────────────────────────────
  const targetNorm = normalizeURL(targetURL);
  let resolvedCandidates = [];
  let sitemapError = null;

  const maxCandidates = Math.min(
    settings.maxCandidates || MAX_CANDIDATE_URLS,
    MAX_CANDIDATE_URLS
  );

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
    // Auto-discover via sitemap
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
    return res.status(422).json({
      error: diag.zeroOppReason,
      diagnostics: diag,
      sitemapError,
    });
  }

  // ── Step 3: Fetch candidate pages (with thin-content fallback) ─────────────
  const fetchResults = await Promise.all(
    resolvedCandidates.map(url => fetchAndProcess(url, settings, false))
  );

  const fetchLog = fetchResults.map(r => ({
    url:     r.url,
    success: r.success,
    status:  r.status,
    message: r.message,
    thinContent: r.thinContent || false,
  }));

  const skipped = [];
  fetchResults.forEach(r => { if (r.skipped) skipped.push(r.skipped); });

  const sourcePages = fetchResults
    .filter(r => r.success && r.pageData)
    .map(r => r.pageData);

  diag.fetchedPages     = sourcePages.length;
  diag.skippedPages     = fetchResults.filter(r => !r.success).length;
  diag.thinContentPages = sourcePages.filter(p => p.thinContent).length;

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
        minKeywordOverlap: settings.minKeywordOverlap ?? 1, // more lenient in target mode
        customTopics:      Array.isArray(settings.customTopics) ? settings.customTopics : [],
      })
    : [];

  const strictOpps = allOpps.filter(o => normalizeURL(o.targetURL) === targetNorm);
  diag.oppsBeforeFilter = strictOpps.length;

  // ── Step 8: Semantic fallback scoring ────────────────────────────────────
  // Always score every source page against the target, even without verbatim anchor.
  // This produces a ranked list of "closest semantic candidates".
  const semanticScores = scoreAllCandidates(sourcePages, targetPage, settings);
  diag.scoredPairs = semanticScores.length;

  // Build top-20 semantic opportunities (pages not already in strictOpps)
  const strictSrcNorms = new Set(strictOpps.map(o => normalizeURL(o.sourceURL)));
  const semanticOpps   = buildSemanticOpps(semanticScores, targetPage, strictSrcNorms, settings);
  diag.semanticOpps = semanticOpps.length;

  // Merge: strict first, then semantic fill-ins (deduped)
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
      diag.zeroOppReason = 'No source pages were successfully fetched.';
    } else if (semanticScores.every(s => s.alreadyLinks)) {
      diag.zeroOppReason = 'All fetched pages already link to the target page.';
    } else if (semanticScores.every(s => s.compositeScore < 1)) {
      diag.zeroOppReason = `All ${semanticScores.length} pages scored below 1/10. The target page may have very different content from the rest of the site, or content extraction failed on most pages.`;
    } else {
      diag.zeroOppReason = `Scores found but all were below the minimum threshold (${strictMinScore}/10). The highest score was ${Math.max(...semanticScores.map(s => s.compositeScore), 0).toFixed(1)}.`;
    }
  }

  // ── Step 10: Summary ─────────────────────────────────────────────────────
  const summary = buildSummary(fetchLog, sourcePages, skipped, opportunities);
  summary.sitemapSource    = diag.sitemapSource;
  summary.candidateCount   = resolvedCandidates.length;
  summary.discoveredURLs   = diag.discoveredURLs;
  summary.mode             = 'target-page';

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
//  SEMANTIC SCORING — score every source page against target (no anchor needed)
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
    const cosSim    = cosineSim(srcKws, tgtArr);

    // Try to find the best anchor phrase in any paragraph
    let bestAnchor = null;
    let bestPara   = null;
    for (const para of (source.paragraphs || [])) {
      const found = findBestAnchor(para, target, {
        minWords:       settings.minAnchorWords ?? 2,
        allowSingleWord: settings.allowSingleWord ?? false,
        customTopics:   settings.customTopics || [],
      });
      if (found && (!bestAnchor || found.anchorScore > bestAnchor.anchorScore)) {
        bestAnchor = found;
        bestPara   = para;
      }
    }

    // Also try title/meta match to target keywords
    const titleOverlap = (source.title || '').toLowerCase().split(/\s+/)
      .filter(w => w.length > 4 && tgtKws.has(w)).length;

    // Composite score (0-10):
    // - keyword overlap: up to 4 pts
    // - cosine similarity: up to 3 pts
    // - verbatim anchor found: up to 2 pts bonus
    // - title overlap: up to 1 pt
    let composite = 0;
    composite += Math.min(4, shared.length * 0.4);
    composite += Math.min(3, cosSim * 12);
    if (bestAnchor) composite += Math.min(2, bestAnchor.anchorScore * 0.2);
    composite += Math.min(1, titleOverlap * 0.5);
    composite = Math.round(composite * 10) / 10;

    results.push({
      source,
      sharedKeywords:   shared,
      cosineSimilarity: Math.round(cosSim * 1000) / 1000,
      compositeScore:   composite,
      anchor:           bestAnchor?.anchor || null,
      anchorPara:       bestPara,
      alreadyLinks,
      titleOverlap,
    });
  }

  // Sort by composite score descending
  return results.sort((a, b) => b.compositeScore - a.compositeScore);
}

function buildSemanticOpps(semanticScores, target, excludeNorms, settings) {
  const opps = [];
  const MIN_SEMANTIC_SCORE = 0.5; // very low floor — just exclude completely irrelevant

  for (const s of semanticScores) {
    if (opps.length >= 20) break;
    if (s.alreadyLinks) continue;
    if (s.compositeScore < MIN_SEMANTIC_SCORE) continue;
    if (excludeNorms.has(s.source.normalizedURL)) continue;

    // Pick the most relevant paragraph
    const para = s.anchorPara
      || (s.source.paragraphs?.length > 0 ? s.source.paragraphs[0] : null)
      || s.source.title;

    if (!para) continue;

    // Derive a suggested anchor: best matching keyword phrase from target
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
      bodyContentReason: s.source.thinContent
        ? `Limited content page — scored from title/meta/headings (extraction confidence: ${Math.round((s.source.confidence||0.5)*100)}%)`
        : `Paragraph extracted via "${s.source.extractionMethod}" (${Math.round((s.source.confidence||0.5)*100)}% confidence)`,
      warnings:          s.anchor ? [] : ['No verbatim anchor found — suggested anchor requires minor content edit'],
      sharedKeywords:    s.sharedKeywords.slice(0, 15),
      paraPosition:      0.5,
      paraPositionLabel: 'Middle',
      score:             Math.round(s.compositeScore),
      confidence:        Math.round(s.cosineSimilarity * 100),
      priority,
      opportunityType:   s.anchor ? 'natural' : 'semantic',
    });
  }
  return opps;
}

function deriveAnchorFromKeywords(sharedKeywords, target) {
  if (!sharedKeywords.length) return null;
  // Try bigrams from target keywords that appear in shared
  const tgtKwArr = target.keywords || [];
  for (let i = 0; i < tgtKwArr.length - 1; i++) {
    const bigram = `${tgtKwArr[i]} ${tgtKwArr[i+1]}`;
    if (sharedKeywords.includes(tgtKwArr[i]) || sharedKeywords.includes(tgtKwArr[i+1])) {
      if (bigram.split(/\s+/).length >= 2) return bigram;
    }
  }
  // Fall back to first shared keyword if it's long enough
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
//  FETCH + PARSE  (with thin-content fallback)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAndProcess(url, settings = {}, isTarget = false) {
  const fetchResult = await fetchURL(url);
  if (!fetchResult.success)
    return { url, success: false, status: fetchResult.status, message: fetchResult.message };

  const html = fetchResult.html;
  const $    = cheerio.load(html, { decodeEntities: true });

  // noindex check (only for non-target pages)
  if (!isTarget) {
    const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
    if (robotsMeta.includes('noindex')) {
      return {
        url, success: false, status: 'skipped:noindex',
        message: '⊘ Skipped: noindex',
        skipped: { url, reason: 'noindex', details: 'Has <meta name="robots" content="noindex">' },
      };
    }
  }

  // canonical check
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical && !isTarget) {
    try {
      const canonNorm = normalizeURL(canonical);
      const selfNorm  = normalizeURL(url);
      if (canonNorm !== selfNorm && canonical !== url) {
        return {
          url, success: false, status: 'skipped:canonical',
          message: `⊘ Skipped: canonicalized to ${canonical}`,
          redirectedTo: canonical,
          skipped: { url, reason: 'canonical', details: `Canonical: ${canonical}` },
        };
      }
    } catch {}
  }

  const title    = ($('title').text()  || '').replace(/\s+/g, ' ').trim();
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

  // ── Thin content fallback (v3.1) ──────────────────────────────────────────
  // Instead of skipping, we build pseudo-paragraphs from structural signals.
  let finalParagraphs         = paragraphs;
  let finalParagraphPositions = paragraphPositions;
  let thinContent             = false;

  if (paragraphs.length < 2) {
    thinContent = true;
    const h2s = headings.filter(h => h.level === 'H2').map(h => h.text).filter(Boolean);
    const h3s = headings.filter(h => h.level === 'H3').map(h => h.text).filter(Boolean);

    // Build pseudo-paragraphs from available metadata
    const pseudos = [
      title    ? `${title}.` : null,
      metaDesc ? metaDesc    : null,
      h1       ? `${h1}.`   : null,
      ...h2s.map(h => `${h}.`),
      ...h3s.map(h => `${h}.`),
      // Also extract URL slug words as a pseudo sentence
      (() => {
        try {
          const slug = new URL(url).pathname.replace(/[/-]/g, ' ').trim();
          return slug.length > 5 ? `Topics covered: ${slug}.` : null;
        } catch { return null; }
      })(),
    ].filter(Boolean);

    if (pseudos.length > 0) {
      finalParagraphs         = pseudos;
      finalParagraphPositions = pseudos.map((_, i) => i / Math.max(pseudos.length - 1, 1));
    }
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

  const fullText = [title, metaDesc, h1, ...headings.map(h => h.text), ...finalParagraphs].join(' ');
  const keywords = extractKeywords(fullText);
  const topics   = extractTopics(title, h1, headings, metaDesc);
  const pageType = detectPageType(url, title);

  const msg = thinContent
    ? `⚠ Limited content (${finalParagraphs.length} pseudo-paragraphs from title/meta/headings) — still scoring semantically`
    : `✓ Fetched — ${finalParagraphs.length} paragraphs via "${extractionMethod}" (${Math.round(confidence*100)}% confidence)`;

  return {
    url,
    success:     true,
    status:      'success',
    message:     msg,
    thinContent,
    pageData: {
      url,
      normalizedURL:       normalizeURL(url),
      title:               title || url,
      metaDesc, h1, headings,
      paragraphs:          finalParagraphs,
      paragraphPositions:  finalParagraphPositions,
      existingLinks:       [...existingLinkSet],
      keywords, topics, pageType,
      extractionMethod:    thinContent ? 'thin-content-fallback' : extractionMethod,
      confidence:          thinContent ? 0.4 : confidence,
      wordCount:           fullText.split(/\s+/).length,
      paragraphCount:      finalParagraphs.length,
      thinContent,
      inboundCount: 0,
      isOrphan:     false,
      error:        false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  RAW HTTP FETCH
// ─────────────────────────────────────────────────────────────────────────────
async function fetchURL(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: FETCH_HEADERS, redirect: 'follow' });
    clearTimeout(timer);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      const m = { 403:'Access forbidden', 404:'Not found', 429:'Rate limited', 500:'Server error', 503:'Unavailable' };
      return { success: false, status: `failed:http-${res.status}`, message: `✗ ${m[res.status]||`HTTP ${res.status}`}` };
    }
    if (!ct.includes('html') && !ct.includes('text'))
      return { success: false, status: 'skipped:non-html', message: `⊘ Non-HTML (${ct})` };
    const html = await res.text();
    if (!html || html.trim().length < 100)
      return { success: false, status: 'failed:empty', message: '✗ Empty response' };
    return { success: true, html };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { success: false, status: 'failed:timeout', message: `✗ Timeout after ${FETCH_TIMEOUT_MS/1000}s` };
    if (err.code === 'ECONNREFUSED') return { success: false, status: 'failed:refused', message: '✗ Connection refused' };
    if (err.code === 'ENOTFOUND')    return { success: false, status: 'failed:dns',     message: '✗ Domain not found' };
    return { success: false, status: 'failed:error', message: `✗ ${err.message}` };
  }
}
