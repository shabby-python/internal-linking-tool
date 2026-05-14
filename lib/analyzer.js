/**
 * lib/analyzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Opportunity discovery + multi-factor scoring engine.
 *
 * Domain-agnostic. No hardcoded selectors, brands, or URL patterns.
 *
 * v2 improvements over v1:
 *  1. Word-boundary-aware anchor matching  — "intel" no longer matches
 *     "intelligence"; "ci" no longer matches "science".
 *  2. All sub-phrase windows are tried, not just leading words — so
 *     "Introduction to Competitive Intelligence" can anchor on
 *     "Competitive Intelligence" (mid-phrase).
 *  3. Cosine-similarity semantic scoring — TF-IDF-style overlap between
 *     the paragraph's keyword set and the target page's keyword set replaces
 *     the simple count threshold.
 *  4. Paragraph-position scoring — links placed earlier in an article
 *     score higher (better SEO value / reader context).
 *  5. Anchor-context window — a short surrounding excerpt is returned with
 *     each opportunity so reviewers can see how natural the anchor looks
 *     in context.
 *  6. minKeywordOverlap is now a configurable setting (default 2).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { STOPWORDS }      from './stopwords.js';
import { GENERIC_ANCHORS } from './extractor.js';
import {
  findBestAnchor,
  classifyAnchorType,
  getAnchorContext as anchorContextFn,
  isGenericAnchor,
} from './anchor.js';

// ─────────────────────────────────────────────────────────────────────────────
//  KEYWORD EXTRACTION  (TF-IDF style, unigrams + bigrams)
// ─────────────────────────────────────────────────────────────────────────────
export function extractKeywords(text, topN = 100) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });

  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i], b = words[i + 1];
    if (a.length > 3 && b.length > 3 && !STOPWORDS.has(a) && !STOPWORDS.has(b)) {
      const bg = `${a} ${b}`;
      freq[bg] = (freq[bg] || 0) + 0.65;
    }
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

// Topics = shorter list from headings/title only (more specific than keywords)
export function extractTopics(title = '', h1 = '', headings = [], meta = '') {
  const src = [title, h1, ...headings.map(h => h.text), meta].join(' ');
  return src
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOPWORDS.has(w))
    .slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE TYPE  (generic — no domain-specific logic)
// ─────────────────────────────────────────────────────────────────────────────
export function detectPageType(url = '', title = '') {
  const u = url.toLowerCase();
  if (/\/blog\/|\/posts?\/|\/articles?\/|\/insights\/|\/news\//.test(u))      return 'blog';
  if (/\/product\/|\/products\/|\/features?\/|\/capability/.test(u))           return 'product';
  if (/\/pricing|\/demo|\/trial|\/request|\/free-trial|\/get-started/.test(u)) return 'commercial';
  if (/\/services?\/|\/solutions?\/|\/offerings?\//.test(u))                   return 'service';
  if (/\/resources?\/|\/category\/|\/topics?\/|\/library\/|\/hub\//.test(u))  return 'resource';
  if (/\/case-stud|\/customer|\/success-stor/.test(u))                         return 'case-study';
  if (/\/about|\/team|\/careers?|\/company|\/who-we-are/.test(u))             return 'company';
  if (/\/comparison|\/vs\/|\/alternative|\/compare/.test(u))                   return 'comparison';
  if (/\/glossary|\/definition|\/what-is|\/guide|\/tutorial/.test(u))         return 'informational';
  return 'general';
}

// ─────────────────────────────────────────────────────────────────────────────
//  LINK TYPE  (source→target relationship label)
// ─────────────────────────────────────────────────────────────────────────────
export function getLinkType(srcType, tgtType) {
  const map = {
    'blog-service':       'Blog-to-service',
    'blog-product':       'Blog-to-product',
    'blog-commercial':    'Blog-to-commercial',
    'blog-resource':      'Blog-to-category',
    'blog-blog':          'Blog-to-blog',
    'blog-informational': 'Blog-to-guide',
    'blog-comparison':    'Blog-to-comparison',
    'informational-product': 'Guide-to-product',
    'informational-service': 'Guide-to-service',
    'product-blog':       'Product-to-blog',
    'resource-blog':      'Category-to-blog',
    'resource-product':   'Category-to-product',
  };
  return map[`${srcType}-${tgtType}`] || `${srcType}-to-${tgtType}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  PHRASE MATCHING  (word-boundary aware)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the case-preserved phrase from `text` if `phrase` appears as a
 * whole-word sequence (not inside another word).
 *
 * "intel"        will NOT match "intelligence"
 * "competitive"  will NOT match "uncompetitive"
 * "ci"           will NOT match "science"
 *
 * @returns {string|null}  The case-preserved match, or null if not found.
 */
function findBoundedPhrase(text, phrase) {
  if (!phrase || !text || phrase.length < 2) return null;

  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  try {
    // Lookbehind / lookahead: surrounding char must not be alphanumeric
    const rx = new RegExp(
      `(?<![a-zA-Z0-9])(${escaped})(?![a-zA-Z0-9])`,
      'i'
    );
    const m = rx.exec(text);
    if (!m) return null;
    // m.index points to the start of the captured phrase
    return text.substring(m.index, m.index + phrase.length);
  } catch {
    // Fallback for unusual phrases (complex regex failures)
    const lo = text.toLowerCase().indexOf(phrase.toLowerCase());
    if (lo === -1) return null;
    // Rough boundary check without regex
    const before = lo > 0 ? text[lo - 1] : ' ';
    const after  = lo + phrase.length < text.length ? text[lo + phrase.length] : ' ';
    if (/[a-zA-Z0-9]/.test(before) || /[a-zA-Z0-9]/.test(after)) return null;
    return text.substring(lo, lo + phrase.length);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ANCHOR TEXT  — find the most natural phrase in a paragraph that maps to
//  the target page.  Must already exist as a natural phrase in the text.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Searches `paragraph` for the best natural anchor phrase that relates to
 * `target`.  Returns the case-preserved phrase from the paragraph, or null.
 *
 * Candidate sources (in priority order):
 *   1. Target H1 (most authoritative)
 *   2. Target title tag
 *   3. Target H2 headings
 *   4. Target topics (from title + headings + meta)
 *
 * For each candidate, we try:
 *   a. Full phrase (word-boundary check)
 *   b. All sliding windows of length 5, 4, 3, 2 words (avoids stop-words)
 *      — windows start at every possible offset, not just the beginning,
 *        so "Competitive Intelligence" can be found inside
 *        "Introduction to Competitive Intelligence Tools"
 */
export function findNaturalAnchor(paragraph, target) {
  // Build candidate list, longest first (more specific = better anchor)
  const candidates = [
    target.h1,
    target.title,
    ...target.headings.filter(h => h.level === 'H2').map(h => h.text),
    ...target.topics.slice(0, 20),
  ]
    .filter(Boolean)
    .map(c => c.replace(/\s+/g, ' ').trim())
    .filter(c => c.length > 4 && !GENERIC_ANCHORS.has(c.toLowerCase()));

  // Prefer longer phrases (more specific, better SEO value)
  candidates.sort((a, b) => b.length - a.length);

  for (const phrase of candidates) {
    // ── Try the full phrase first ────────────────────────────────────────────
    const fullMatch = findBoundedPhrase(paragraph, phrase);
    if (fullMatch) return fullMatch;

    // ── Try sliding sub-phrase windows ───────────────────────────────────────
    const words = phrase
      .toLowerCase()
      .split(' ')
      .filter(w => w.length > 3 && !STOPWORDS.has(w));

    if (words.length < 2) continue;

    const maxLen = Math.min(words.length, 5);
    for (let len = maxLen; len >= 2; len--) {
      for (let start = 0; start <= words.length - len; start++) {
        const chunk = words.slice(start, start + len).join(' ');
        if (GENERIC_ANCHORS.has(chunk)) continue;
        const subMatch = findBoundedPhrase(paragraph, chunk);
        if (subMatch) return subMatch;
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ANCHOR CONTEXT WINDOW
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a short excerpt of `para` centred on `anchor` (±contextWords words).
 * Useful for reviewers to see whether the anchor looks natural in context.
 *
 * @param {string} para
 * @param {string} anchor
 * @param {number} contextWords  words on each side (default 6)
 * @returns {string}  e.g. "…helps teams using competitive intelligence tools to…"
 */
export function getAnchorContext(para, anchor, contextWords = 6) {
  if (!anchor || !para) return '';

  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let rx;
  try {
    rx = new RegExp(`(?<![a-zA-Z0-9])(${escaped})(?![a-zA-Z0-9])`, 'i');
  } catch {
    rx = new RegExp(escaped, 'i');
  }
  const m = rx.exec(para);
  if (!m) return '';

  // Split into words and find the word index of the anchor start
  const allWords = para.split(/(\s+)/);  // keep spaces as separators
  const words    = para.split(/\s+/);

  // Find roughly which word index the anchor starts at
  let charSoFar = 0;
  let anchorWordIdx = 0;
  for (let i = 0; i < words.length; i++) {
    if (charSoFar >= m.index) { anchorWordIdx = i; break; }
    charSoFar += words[i].length + 1; // +1 for space
  }

  const anchorWordCount = anchor.split(/\s+/).length;
  const start = Math.max(0, anchorWordIdx - contextWords);
  const end   = Math.min(words.length, anchorWordIdx + anchorWordCount + contextWords);

  const prefix = start > 0 ? '…' : '';
  const suffix = end < words.length ? '…' : '';
  return prefix + words.slice(start, end).join(' ') + suffix;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SEMANTIC SIMILARITY  (cosine over keyword sets)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two keyword lists (treated as term-frequency vectors).
 * Returns 0–1 where 1 = identical keyword sets.
 *
 * Used to score semantic relevance between a source paragraph and a target page,
 * going beyond simple intersection count.
 */
function cosineSimilarity(kwsA, kwsB) {
  if (!kwsA.length || !kwsB.length) return 0;
  const setB  = new Set(kwsB);
  const intersection = kwsA.filter(k => setB.has(k)).length;
  if (!intersection) return 0;
  return intersection / Math.sqrt(kwsA.length * kwsB.length);
}

/**
 * Extract keywords from a single paragraph string (subset of extractKeywords).
 * Smaller, faster version for per-paragraph comparisons.
 */
function paragraphKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .slice(0, 60);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SCORING  (1–10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score an internal linking opportunity from 1 to 10.
 *
 * Factors (max raw points before clamping):
 *   F1  Anchor ↔ Target relevance     0–3 pts
 *   F2  Keyword / semantic overlap     0–3 pts  (cosine-upgraded)
 *   F3  Paragraph quality / context    0–2 pts
 *   F4  Strategic / crawlability       0–2 pts
 *   F5  Paragraph position             0–1 pt   (early = better)
 *   Penalties: generic anchor, very short anchor, single-word anchor
 *
 * @param {object} opts
 * @param {string} opts.anchor          - anchor text found in paragraph
 * @param {string} opts.paragraph       - source paragraph text
 * @param {object} opts.source          - source pageData object
 * @param {object} opts.target          - target pageData object
 * @param {string[]} opts.sharedKeywords - keyword overlap between pages
 * @param {number}  opts.paraPosition   - relative position 0–1 (0 = first para)
 */
export function scoreOpportunity({
  anchor, paragraph, source, target, sharedKeywords, paraPosition = 0.5,
}) {
  let raw = 0;
  const reasons  = [];
  const warnings = [];

  const anchorLow   = anchor.toLowerCase().trim();
  const tgtH1Low    = (target.h1 || '').toLowerCase();
  const tgtTitleLow = (target.title || '').toLowerCase();
  const tgtH2sLow   = target.headings.filter(h => h.level === 'H2').map(h => h.text.toLowerCase());
  const tgtMetaLow  = (target.metaDesc || '').toLowerCase();
  const tgtSlug     = extractSlug(target.url);

  // ── Factor 1: Anchor ↔ Target relevance (0–3 pts) ────────────────────────
  if (tgtH1Low && (tgtH1Low.includes(anchorLow) || anchorLow.includes(tgtH1Low.split(' ').slice(0, 4).join(' ')))) {
    raw += 3; reasons.push('Anchor closely matches target H1');
  } else if (tgtTitleLow.includes(anchorLow)) {
    raw += 2.5; reasons.push('Anchor found in target page title');
  } else if (tgtH2sLow.some(h2 =>
    h2.includes(anchorLow) || anchorLow.includes(h2.split(' ').slice(0, 3).join(' ')))) {
    raw += 2; reasons.push('Anchor matches a target H2 heading');
  } else if (tgtMetaLow.includes(anchorLow)) {
    raw += 1.5; reasons.push('Anchor found in target meta description');
  } else if (tgtSlug.includes(anchorLow.replace(/\s+/g, '-'))) {
    raw += 1; reasons.push('Anchor phrase matches target URL slug');
  } else if (sharedKeywords.length > 0) {
    raw += 0.5;
  }

  // ── Factor 2: Keyword / semantic overlap (0–3 pts, cosine-weighted) ──────
  const paraKws = paragraphKeywords(paragraph);
  const tgtKws  = target.keywords || [];

  // Inter-page keyword overlap (shared between source and target pages)
  const kc = sharedKeywords.length;
  if (kc >= 10)      { raw += 2;   reasons.push(`Very high inter-page keyword overlap (${kc} shared terms)`); }
  else if (kc >= 6)  { raw += 1.5; reasons.push(`High inter-page keyword overlap (${kc} terms)`); }
  else if (kc >= 3)  { raw += 1;   reasons.push(`Good inter-page keyword overlap (${kc} terms)`); }
  else if (kc >= 1)  { raw += 0.5; }

  // Paragraph-to-target cosine similarity (local paragraph vs target page)
  const cosSim = cosineSimilarity(paraKws, tgtKws);
  if (cosSim >= 0.25)      { raw += 1;   reasons.push(`Strong paragraph-to-target semantic similarity (${(cosSim * 100).toFixed(0)}%)`); }
  else if (cosSim >= 0.12) { raw += 0.5; reasons.push(`Moderate paragraph-to-target semantic overlap`); }

  // ── Factor 3: Paragraph quality / context (0–2 pts) ─────────────────────
  const wc = paragraph.split(/\s+/).length;
  if (wc >= 80)      { raw += 2;   reasons.push('Rich paragraph context (80+ words)'); }
  else if (wc >= 40) { raw += 1.5; reasons.push('Good paragraph length (40+ words)'); }
  else if (wc >= 20) { raw += 1;   reasons.push('Acceptable paragraph length (20+ words)'); }

  // ── Factor 4: Strategic / crawlability value (0–2 pts) ───────────────────
  if (target.isOrphan) {
    raw += 2; reasons.push('Target is an orphan page (zero inbound internal links)');
  } else if ((target.inboundCount || 0) < 2) {
    raw += 1; reasons.push('Target has very few inbound internal links');
  }
  if (['product', 'commercial', 'service'].includes(target.pageType)) {
    raw += 1; reasons.push('Target is a high-value conversion / money page');
  }

  // ── Factor 5: Paragraph position (0–1 pt) ────────────────────────────────
  // Paragraphs in the first 50% of the article are preferred (better reader
  // context and crawl signal).
  if (paraPosition <= 0.25) {
    raw += 1;   reasons.push('Anchor is in the opening section of the article (high SEO value)');
  } else if (paraPosition <= 0.50) {
    raw += 0.5; reasons.push('Anchor is in the first half of the article');
  }

  // ── Penalties ─────────────────────────────────────────────────────────────
  if (GENERIC_ANCHORS.has(anchorLow)) {
    raw -= 3; warnings.push('Generic anchor text (click here / read more / etc.)');
  }
  if (anchor.length < 4) {
    raw -= 2; warnings.push('Anchor text too short (< 4 characters)');
  }
  if (anchor.split(' ').length === 1 && anchor.length < 8) {
    raw -= 0.5; warnings.push('Single very short word used as anchor');
  }

  const score = Math.max(1, Math.min(10, Math.round(raw)));

  // Confidence: weighted blend of extraction confidence + anchor naturalness + score
  const anchorWords = anchor.split(' ').length;
  const anchorNat   = anchorWords >= 3 ? 0.95 : anchorWords >= 2 ? 0.85 : 0.70;
  const confidence  = Math.round(
    (source.confidence * 0.40 + anchorNat * 0.30 + (score / 10) * 0.30) * 100
  );

  return { score, confidence, reasons, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ANALYSIS LOOP
// ─────────────────────────────────────────────────────────────────────────────
export function analyzeOpportunities(pages, settings = {}) {
  const {
    maxLinksPerSource  = 5,
    maxLinksPerTarget  = 10,
    minScore           = 7,   // v3: raised default to 7 (High ≥8, Medium 6-7.9, Low <6)
    minKeywordOverlap  = 2,
    minAnchorWords     = 2,   // v3: prefer multi-word anchors
    allowSingleWord    = false, // v3: reject single-word anchors by default
    customTopics       = [],  // v3: extra phrases to include in anchor candidates
    linkInHeadings     = false,
  } = settings;

  const opps          = [];
  const srcLinkCount  = {}; // normalizedURL → opps emitted from this source
  const tgtLinkCount  = {}; // normalizedURL → opps pointing to this target
  const usedAnchors   = {}; // sourceNorm → Set<anchorLow> already used

  pages.forEach(p => {
    srcLinkCount[p.normalizedURL] = 0;
    tgtLinkCount[p.normalizedURL] = 0;
    usedAnchors[p.normalizedURL]  = new Set();
  });

  for (const source of pages) {
    if (source.error || source.paragraphs.length === 0) continue;

    for (const target of pages) {
      if (source.normalizedURL === target.normalizedURL) continue;
      if (target.error) continue;

      // Already links to target?
      if (source.existingLinks.includes(target.normalizedURL)) continue;

      // Cap outgoing suggestions per source page
      if (srcLinkCount[source.normalizedURL] >= maxLinksPerSource) break;

      // Cap incoming suggestions per target page
      if (tgtLinkCount[target.normalizedURL] >= maxLinksPerTarget) continue;

      // Inter-page keyword overlap gate (configurable)
      const tgtSet  = new Set(target.keywords);
      const overlap = source.keywords.filter(k => tgtSet.has(k));
      if (overlap.length < minKeywordOverlap) continue;

      // Find the best scoring paragraph + anchor for this source→target pair
      let bestResult = null;
      let bestScore  = 0;

      source.paragraphs.forEach((para, paraIdx) => {
        // v3: Use findBestAnchor from anchor.js (multi-word preference, blacklist)
        const anchorResult = findBestAnchor(para, target, {
          minWords:       minAnchorWords,
          allowSingleWord,
          customTopics,
        });
        if (!anchorResult) return;

        const anchor = anchorResult.anchor;

        // Don't reuse the same anchor phrase on this source page
        if (usedAnchors[source.normalizedURL].has(anchor.toLowerCase())) return;

        const paraPosition = source.paragraphPositions?.[paraIdx] ?? 0.5;

        const { score, confidence, reasons, warnings } = scoreOpportunity({
          anchor,
          paragraph: para,
          source,
          target,
          sharedKeywords: overlap,
          paraPosition,
        });

        if (score > bestScore) {
          bestScore  = score;
          bestResult = { para, anchor, score, confidence, reasons, warnings, paraPosition, paraIdx };
        }
      });

      if (!bestResult || bestResult.score < minScore) continue;

      const {
        para, anchor, score, confidence, reasons, warnings, paraPosition, paraIdx,
      } = bestResult;

      // Build updated paragraph with markdown link placeholder
      const updatedParagraph = insertLink(para, anchor, target.url);

      // Anchor context window (shows how natural the anchor looks in context)
      const anchorContext = getAnchorContext(para, anchor, 6);

      // v3: Classify anchor type (exact / partial / entity / branded / semantic / long-tail)
      const anchorType = classifyAnchorType(anchor, target);

      // Human-readable paragraph position label
      const posLabel = paraPosition <= 0.25 ? 'Early'
                     : paraPosition <= 0.60 ? 'Middle'
                     : 'Late';

      // Body-content proof string
      const bodyContentReason =
        `Paragraph #${paraIdx + 1} extracted via "${source.extractionMethod}" ` +
        `(confidence ${Math.round(source.confidence * 100)}%) — ` +
        `confirmed main-body content (${posLabel} section of article), ` +
        `not from author bio, sidebar, or template section.`;

      opps.push({
        sourceURL:         source.url,
        targetURL:         target.url,
        sourceTitle:       source.title,
        targetTitle:       target.title,
        sourcePageType:    source.pageType,
        targetPageType:    target.pageType,
        linkType:          getLinkType(source.pageType, target.pageType),
        existingParagraph: para,
        suggestedAnchor:   anchor,
        anchorContext,
        anchorType,             // v3: exact | partial | entity | branded | semantic | long-tail
        updatedParagraph,
        reason:            reasons.join('; '),
        bodyContentReason,
        warnings,
        sharedKeywords:    overlap.slice(0, 15),
        paraPosition,
        paraPositionLabel: posLabel,  // 'Early' | 'Middle' | 'Late'
        score,
        confidence,
        priority:          score >= 8 ? 'High' : score >= 6 ? 'Medium' : 'Low', // v3 thresholds
      });

      srcLinkCount[source.normalizedURL]++;
      tgtLinkCount[target.normalizedURL]++;
      usedAnchors[source.normalizedURL].add(anchor.toLowerCase());
    }
  }

  return opps.sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUMMARY STATS
// ─────────────────────────────────────────────────────────────────────────────
export function buildSummary(allFetchLog, pages, skipped, opps) {
  const normSet = new Set(pages.map(p => p.normalizedURL));

  const inbound  = {};
  const outbound = {};
  pages.forEach(p => { inbound[p.normalizedURL] = 0; outbound[p.normalizedURL] = 0; });

  pages.forEach(src => {
    src.existingLinks.forEach(link => {
      if (normSet.has(link)) {
        inbound[link]               = (inbound[link] || 0) + 1;
        outbound[src.normalizedURL] = (outbound[src.normalizedURL] || 0) + 1;
      }
    });
  });

  // Opportunity-derived counts (potential improvement from suggestions)
  opps.forEach(o => {
    const sn = normalizeURL(o.sourceURL), tn = normalizeURL(o.targetURL);
    inbound[tn]  = (inbound[tn] || 0) + 1;
    outbound[sn] = (outbound[sn] || 0) + 1;
  });

  const orphans   = pages.filter(p => !p.error && (inbound[p.normalizedURL] || 0) === 0);
  const needsMore = pages.filter(p => !p.error && (inbound[p.normalizedURL] || 0) > 0 && (inbound[p.normalizedURL] || 0) < 2);
  const tooMany   = pages.filter(p => !p.error && (outbound[p.normalizedURL] || 0) > 7);

  return {
    totalURLsEntered: allFetchLog.length + skipped.length,
    fetchedOK:        pages.length,
    fetchFailed:      allFetchLog.filter(r => !r.success).length,
    skippedTotal:     skipped.length,
    totalOpps:        opps.length,
    highPriority:     opps.filter(o => o.score >= 8).length,   // v3: ≥8
    medPriority:      opps.filter(o => o.score >= 6 && o.score < 8).length, // v3: 6–7.9
    lowPriority:      opps.filter(o => o.score < 6).length,   // v3: <6
    orphanPages:      orphans.map(p => ({ url: p.url, title: p.title, pageType: p.pageType })),
    needsMoreLinks:   needsMore.map(p => ({ url: p.url, title: p.title, inbound: inbound[p.normalizedURL] })),
    tooManyLinks:     tooMany.map(p => ({ url: p.url, title: p.title, outbound: outbound[p.normalizedURL] })),
    anchorVariations: [...new Set(opps.map(o => o.suggestedAnchor))].slice(0, 25),
    topOpps:          opps.slice(0, 8),
    byType:           groupBy(opps, 'linkType'),
    byPageType:       groupBy(opps, 'sourcePageType'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function insertLink(para, anchor, targetURL) {
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`(${escaped})`, 'i');
  if (rx.test(para)) return para.replace(rx, `[${anchor}](${targetURL})`);
  return para + ` (See also: [${anchor}](${targetURL}))`;
}

function extractSlug(url) {
  try {
    return new URL(url).pathname.replace(/[/-]/g, ' ').trim().toLowerCase();
  } catch { return ''; }
}

export function normalizeURL(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, '') + u.pathname)
      .replace(/\/$/, '')
      .toLowerCase();
  } catch { return url.toLowerCase(); }
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}
