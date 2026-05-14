/**
 * lib/anchor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Anchor text selection, quality scoring, and classification.
 *
 * Key responsibilities:
 *  - findBoundedPhrase()   — word-boundary-aware phrase search (moved from analyzer.js)
 *  - buildCandidatePhrases() — generate candidate n-grams from target page signals
 *  - findBestAnchor()      — score all candidates in a paragraph, return best
 *  - isGenericAnchor()     — reject generic single-word / low-value anchors
 *  - classifyAnchorType()  — exact / partial / semantic / entity / branded / long-tail
 *
 * Design goals:
 *  - Strongly prefer 2–6 word anchors over single-word ones
 *  - Reject generic single words (analysis, insights, strategy, market, …)
 *  - Never allow partial word matches (e.g. "intel" must not match "intelligence")
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Generic single-word blacklist ─────────────────────────────────────────────
// Words that are too vague to be useful as anchor text on their own.
export const GENERIC_SINGLE_WORDS = new Set([
  // Actions / verbs
  'learn', 'read', 'click', 'here', 'visit', 'check', 'find', 'get', 'see',
  'view', 'more', 'link', 'page', 'post', 'article', 'blog', 'guide', 'resource',
  'download', 'explore', 'discover', 'understand', 'use', 'know', 'help',

  // Generic nouns
  'analysis', 'insights', 'insight', 'strategy', 'strategies', 'market',
  'trends', 'trend', 'data', 'information', 'info', 'content', 'overview',
  'introduction', 'summary', 'report', 'research', 'study', 'work', 'approach',
  'solution', 'platform', 'tool', 'tools', 'software', 'system', 'process',
  'service', 'services', 'product', 'products', 'technology', 'technologies',
  'framework', 'method', 'methodology', 'best', 'practices', 'tips', 'advice',
  'example', 'examples', 'case', 'results', 'outcome', 'impact', 'value',
  'benefits', 'features', 'details', 'topic', 'topics', 'area', 'field',
  'industry', 'sector', 'domain', 'space', 'landscape', 'ecosystem',

  // Adjectives used as nouns
  'important', 'key', 'critical', 'essential', 'major', 'significant',
  'relevant', 'related', 'similar', 'various', 'different', 'new', 'latest',
  'recent', 'current', 'future', 'next', 'previous', 'many', 'other',

  // Generic qualifiers
  'business', 'company', 'companies', 'organization', 'organizations',
  'enterprise', 'team', 'teams', 'people', 'users', 'customers', 'clients',
  'partners', 'vendors', 'stakeholders',

  // Time/scope
  'today', 'now', 'year', 'years', 'month', 'months', 'quarter', 'week',
  'time', 'level', 'type', 'types', 'kind', 'way', 'ways',
]);

// ── Additional single-word generic patterns (regex) ───────────────────────────
const GENERIC_PATTERNS = [
  /^\d+$/, // pure numbers
  /^[a-z]{1,3}$/, // too short (1-3 chars)
];

// ── Word-boundary-aware phrase search ─────────────────────────────────────────
/**
 * Search for `phrase` inside `text` with word-boundary constraints.
 * Returns the actual matched substring (preserving original casing) or null.
 *
 * Uses Unicode-safe lookbehind/lookahead. Falls back to indexOf if regex fails
 * (e.g. phrase contains special chars that break the engine on older Node).
 */
export function findBoundedPhrase(text, phrase) {
  if (!phrase || !text || phrase.length < 2) return null;

  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    // Word boundaries using lookbehind/lookahead instead of \b
    // so that phrases like "competitive intelligence" match correctly
    // and "intel" does NOT match inside "intelligence".
    const rx = new RegExp(
      `(?<![a-zA-Z0-9À-ɏ])(${escaped})(?![a-zA-Z0-9À-ɏ])`,
      'i'
    );
    const m = rx.exec(text);
    if (!m) return null;
    return text.substring(m.index, m.index + phrase.length);
  } catch {
    // Fallback: simple indexOf with manual boundary check
    const lo = text.toLowerCase().indexOf(phrase.toLowerCase());
    if (lo === -1) return null;
    const before = lo > 0 ? text[lo - 1] : ' ';
    const after = lo + phrase.length < text.length ? text[lo + phrase.length] : ' ';
    if (/[a-zA-Z0-9]/.test(before) || /[a-zA-Z0-9]/.test(after)) return null;
    return text.substring(lo, lo + phrase.length);
  }
}

// ── Check if a phrase is generic / low-value ──────────────────────────────────
/**
 * Returns true if the phrase should be rejected as anchor text.
 *
 * Rejects:
 *  - Single words that are in GENERIC_SINGLE_WORDS
 *  - Single words matching GENERIC_PATTERNS
 *  - Phrases shorter than minWords (when allowSingleWord is false)
 */
export function isGenericAnchor(phrase, { minWords = 2, allowSingleWord = false } = {}) {
  if (!phrase) return true;

  const words = phrase.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  if (wordCount === 0) return true;

  // Single-word check
  if (wordCount === 1) {
    if (!allowSingleWord) return true; // Always reject if single-word disallowed

    const w = words[0].toLowerCase();
    if (GENERIC_SINGLE_WORDS.has(w)) return true;
    for (const pat of GENERIC_PATTERNS) {
      if (pat.test(w)) return true;
    }
    return false;
  }

  // Multi-word: check minimum length
  if (wordCount < minWords) return true;

  // Multi-word that consists entirely of generic words is also weak, but we
  // don't reject it — being multi-word already adds specificity.
  return false;
}

// ── Build candidate anchor phrases from target page signals ───────────────────
/**
 * Generate candidate n-grams (1–7 words) from the target page's title, H1,
 * headings, and keywords. Returns array sorted longest-first (prefer longer).
 *
 * @param {object} target — pageData object from the API
 * @param {object} opts
 * @param {number} opts.maxPhraseWords  — max n-gram size (default 7)
 * @param {string[]} opts.customTopics  — extra phrases to include
 */
export function buildCandidatePhrases(target, { maxPhraseWords = 7, customTopics = [] } = {}) {
  const sources = [
    target.title || '',
    target.h1    || '',
    ...(target.headings || []).map(h => h.text || ''),
    ...(target.topics   || []),
    ...(target.keywords || []).slice(0, 30).map(k => k.word || k),
    ...customTopics,
  ];

  const phraseSet = new Set();

  for (const src of sources) {
    if (!src) continue;
    // Clean: remove site-name suffixes like " | Contify" or " - Blog"
    const clean = src.replace(/[\|\-–—].*$/, '').replace(/[^\w\s'-]/g, ' ').trim();
    if (!clean) continue;

    const toks = clean.split(/\s+/).filter(t => t.length > 1);

    // Generate all sub-phrases of 1..maxPhraseWords words
    for (let len = 1; len <= Math.min(maxPhraseWords, toks.length); len++) {
      for (let start = 0; start <= toks.length - len; start++) {
        const phrase = toks.slice(start, start + len).join(' ');
        if (phrase.length >= 3) phraseSet.add(phrase);
      }
    }
  }

  // Sort: longer phrases first, then alphabetically
  return [...phraseSet].sort((a, b) => {
    const wA = a.split(/\s+/).length;
    const wB = b.split(/\s+/).length;
    if (wB !== wA) return wB - wA;
    return a.localeCompare(b);
  });
}

// ── Score a single candidate phrase in context ────────────────────────────────
/**
 * Returns a 0–10 anchor quality score for `phrase` found in `paragraph`.
 *
 * Factors:
 *  F1 (0-4): Word count preference  — 1-word=0, 2-word=2, 3-word=3, 4-6=4, 7+=3
 *  F2 (0-3): Specificity (not generic, not stopword-heavy)
 *  F3 (0-2): Position in paragraph (earlier = better)
 *  F4 (0-1): Capitalization / entity hint
 */
function scoreAnchorQuality(phrase, paragraph, charOffset) {
  const words = phrase.trim().split(/\s+/);
  const wc = words.length;

  // F1: word count preference
  let f1 = 0;
  if      (wc === 1) f1 = 0;
  else if (wc === 2) f1 = 2;
  else if (wc === 3) f1 = 3;
  else if (wc <= 6)  f1 = 4;
  else               f1 = 3; // long-tail (7+)

  // F2: specificity
  let f2 = 3;
  if (wc === 1 && GENERIC_SINGLE_WORDS.has(words[0].toLowerCase())) f2 = 0;
  else if (wc === 1) f2 = 1;
  // Count how many words are generic stopwords
  const genericCount = words.filter(w => GENERIC_SINGLE_WORDS.has(w.toLowerCase())).length;
  if (genericCount > 0 && wc > 1) f2 = Math.max(0, f2 - genericCount);

  // F3: position (earlier in paragraph is better anchor placement)
  const paraLen = paragraph.length;
  const relPos = paraLen > 0 ? charOffset / paraLen : 0.5;
  const f3 = relPos < 0.33 ? 2 : relPos < 0.66 ? 1 : 0;

  // F4: entity hint (contains capitalized words beyond first)
  const hasCapital = words.slice(1).some(w => /^[A-Z]/.test(w));
  const f4 = hasCapital ? 1 : 0;

  return Math.min(10, f1 + f2 + f3 + f4);
}

// ── Find best anchor for a paragraph given a target page ─────────────────────
/**
 * Searches `paragraph` for all candidate phrases derived from `target`.
 * Returns the highest-scoring match, or null if none found.
 *
 * @param {string}   paragraph
 * @param {object}   target       — pageData object
 * @param {object}   opts
 * @param {number}   opts.minWords         — reject anchors below this word count
 * @param {boolean}  opts.allowSingleWord  — override minWords=1
 * @param {string[]} opts.customTopics     — extra candidate phrases
 * @returns {{ anchor: string, anchorScore: number, charOffset: number } | null}
 */
export function findBestAnchor(paragraph, target, opts = {}) {
  const {
    minWords       = 2,
    allowSingleWord = false,
    customTopics   = [],
    maxPhraseWords = 7,
  } = opts;

  const candidates = buildCandidatePhrases(target, { maxPhraseWords, customTopics });

  let best = null;
  let bestScore = -1;

  for (const phrase of candidates) {
    // Quick word count gate
    const wc = phrase.split(/\s+/).length;
    if (isGenericAnchor(phrase, { minWords, allowSingleWord })) continue;

    // Search paragraph
    const matched = findBoundedPhrase(paragraph, phrase);
    if (!matched) continue;

    // Find char offset for position scoring
    const idx = paragraph.toLowerCase().indexOf(matched.toLowerCase());
    const charOffset = idx >= 0 ? idx : 0;

    const score = scoreAnchorQuality(matched, paragraph, charOffset);

    if (score > bestScore) {
      bestScore = score;
      best = { anchor: matched, anchorScore: score, charOffset };
    }
  }

  return best; // null if nothing found
}

// ── Classify anchor type ──────────────────────────────────────────────────────
/**
 * Classify the relationship between the chosen anchor and the target page.
 *
 * Types:
 *  - exact      : anchor == target title/H1 (case-insensitive)
 *  - partial    : anchor is a sub-phrase of the title/H1
 *  - entity     : anchor looks like a proper noun / named entity
 *  - branded    : anchor contains a brand name from target topics/title
 *  - semantic   : keyword overlap without direct title match
 *  - long-tail  : 5+ word phrase
 *
 * @param {string} anchor    — chosen anchor text
 * @param {object} target    — pageData object
 * @returns {string}         — one of: exact | partial | entity | branded | semantic | long-tail
 */
export function classifyAnchorType(anchor, target) {
  if (!anchor) return 'semantic';

  const anchorLow  = anchor.toLowerCase().trim();
  const titleLow   = (target.title || '').toLowerCase().replace(/[\|\-–—].*$/, '').trim();
  const h1Low      = (target.h1   || '').toLowerCase().trim();
  const words      = anchor.trim().split(/\s+/);

  // Long-tail: 5+ words
  if (words.length >= 5) return 'long-tail';

  // Exact: matches title or H1 exactly (stripped)
  if (anchorLow === titleLow || anchorLow === h1Low) return 'exact';

  // Partial: title/H1 contains anchor or vice versa
  if (titleLow.includes(anchorLow) || h1Low.includes(anchorLow)) return 'partial';
  if (anchorLow.includes(titleLow) || anchorLow.includes(h1Low))  return 'partial';

  // Entity: contains at least one capitalized word (not first word)
  const hasInternalCap = words.slice(1).some(w => /^[A-Z]/.test(w));
  if (hasInternalCap) return 'entity';

  // Branded: anchor appears in target topics or first word of title is capitalized
  const topicsLow = (target.topics || []).map(t => t.toLowerCase());
  if (topicsLow.some(t => anchorLow.includes(t) || t.includes(anchorLow))) return 'branded';

  // Semantic: default
  return 'semantic';
}

// ── Get surrounding context for an anchor ─────────────────────────────────────
/**
 * Returns a short excerpt showing the anchor in context.
 * Extracts up to `contextWords` words on each side of the anchor.
 */
export function getAnchorContext(paragraph, anchor, contextWords = 6) {
  if (!paragraph || !anchor) return '';

  const idx = paragraph.toLowerCase().indexOf(anchor.toLowerCase());
  if (idx === -1) return anchor;

  // Walk backwards for contextWords words
  const before = paragraph.substring(0, idx);
  const after  = paragraph.substring(idx + anchor.length);

  const beforeWords = before.trim().split(/\s+/).filter(Boolean);
  const afterWords  = after.trim().split(/\s+/).filter(Boolean);

  const pre  = beforeWords.slice(-contextWords).join(' ');
  const post = afterWords.slice(0, contextWords).join(' ');

  const parts = [];
  if (pre)  parts.push(pre);
  parts.push(`[${anchor}]`);
  if (post) parts.push(post);

  return (pre ? '…' : '') + parts.join(' ') + (post ? '…' : '');
}
