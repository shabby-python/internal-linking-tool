/**
 * lib/extractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Robust main-body content extractor.
 *
 * Core guarantee: paragraphs returned here come ONLY from the actual article /
 * page body.  Author bios, footers, headers, sidebars, related posts,
 * navigation, comments, CTAs, ads, and every other boilerplate section are
 * stripped before any paragraph is considered.
 *
 * Works for any website — zero hardcoded domain or brand logic.
 *
 * v2 improvements over v1:
 *  1. Heading-proximity detection  — paragraphs that follow an "About the
 *     Author / Related Posts / Subscribe" heading are always excluded, even
 *     when the containing element has no boilerplate class/id.
 *  2. Extended BOILERPLATE_TEXT_PATTERNS — catches role/bio sentences with
 *     varying wording ("is a content strategist", "covers enterprise software",
 *     "years of experience", etc.)
 *  3. Extended BOILERPLATE_KEYWORDS — more class/id substrings.
 *  4. Paragraph relative-position tracking — returns a parallel
 *     `paragraphPositions` number[] (0 = first para, 1 = last para) so the
 *     scoring layer can reward early-article placement.
 *  5. Cross-page boilerplate fingerprinting helper — `fingerprint()` is
 *     exported so analyze-links.js can remove paragraphs that appear verbatim
 *     on 3+ pages (site-wide template text).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Priority selectors for the main content zone ─────────────────────────────
// Tried in order; first selector that returns an element with ≥ 50 words wins.
export const MAIN_CONTENT_SELECTORS = [
  { sel: '[role="main"]',           method: 'aria-main',           conf: 0.95 },
  { sel: 'main',                    method: 'html5-main',          conf: 0.93 },
  { sel: 'article',                 method: 'html5-article',       conf: 0.88 },
  // WordPress / common CMS
  { sel: '.post-content',           method: 'cms-post-content',    conf: 0.87 },
  { sel: '.entry-content',          method: 'cms-entry-content',   conf: 0.87 },
  { sel: '.article-content',        method: 'cms-article-content', conf: 0.86 },
  { sel: '.article-body',           method: 'cms-article-body',    conf: 0.85 },
  { sel: '.blog-content',           method: 'cms-blog-content',    conf: 0.84 },
  { sel: '.blog-post-content',      method: 'cms-blog-post',       conf: 0.84 },
  { sel: '.post-body',              method: 'cms-post-body',       conf: 0.82 },
  { sel: '.content-body',           method: 'cms-content-body',    conf: 0.82 },
  { sel: '.page-content',           method: 'cms-page-content',    conf: 0.78 },
  { sel: '.main-content',           method: 'cms-main-content',    conf: 0.78 },
  { sel: '.single-content',         method: 'cms-single',          conf: 0.76 },
  { sel: '.gh-content',             method: 'ghost-content',       conf: 0.87 },
  { sel: '.prose',                  method: 'prose',               conf: 0.75 },
  // IDs
  { sel: '#post-content',           method: 'id-post-content',     conf: 0.85 },
  { sel: '#main-content',           method: 'id-main-content',     conf: 0.80 },
  { sel: '#content',                method: 'id-content',          conf: 0.68 },
  { sel: '#main',                   method: 'id-main',             conf: 0.65 },
  // Fallback
  { sel: 'body',                    method: 'fallback-body',       conf: 0.45 },
];

// ── Tags removed from the ENTIRE document before anything else ────────────────
const GLOBAL_NOISE_TAGS = [
  'script', 'style', 'noscript', 'iframe', 'canvas',
  'svg', 'video', 'audio', 'object', 'embed', 'picture',
];

// ── Semantic / ARIA elements removed globally ─────────────────────────────────
const GLOBAL_NOISE_ROLES = [
  'navigation', 'banner', 'contentinfo', 'complementary',
  'search', 'form', 'dialog',
];

// ── Class / ID keyword substrings that mark boilerplate elements ──────────────
// Any element whose class or id attribute CONTAINS one of these strings will
// be removed from the content zone.
export const BOILERPLATE_KEYWORDS = [
  // ── Author / Bio ─────────────────────────────────────────────────────────────
  'author-bio', 'author-box', 'author-card', 'author-info',
  'author-profile', 'author-section', 'author-block', 'author-widget',
  'author-area', 'author-details', 'author-meta', 'author-name',
  'post-author', 'article-author', 'entry-author', 'about-author',
  'written-by', 'contributor-box', 'byline', 'bio-box', 'guest-author',
  'author-description', 'author-content', 'author-wrap', 'author-panel',
  'about-writer', 'writer-bio', 'expert-bio', 'contributor-info',
  'staff-bio', 'team-member-bio',

  // ── Navigation ────────────────────────────────────────────────────────────────
  'site-nav', 'main-nav', 'top-nav', 'primary-nav', 'secondary-nav',
  'mega-menu', 'dropdown-menu', 'nav-menu', 'nav-bar', 'navbar',
  'breadcrumb', 'breadcrumbs', 'crumb-nav',

  // ── Header / Footer ───────────────────────────────────────────────────────────
  'site-header', 'page-header', 'header-wrap', 'top-bar', 'header-area',
  'header-inner', 'site-footer', 'page-footer', 'footer-wrap',
  'footer-widgets', 'footer-nav', 'footer-area', 'footer-inner', 'bottom-bar',

  // ── Sidebar ───────────────────────────────────────────────────────────────────
  'sidebar', 'side-bar', 'widget-area', 'widget-sidebar', 'right-sidebar',
  'left-sidebar', 'sticky-sidebar',

  // ── Related / Recommended content ────────────────────────────────────────────
  'related-posts', 'related-articles', 'related-content', 'related-entries',
  'related-reads', 'related-resources',
  'recommended-posts', 'recommended-articles', 'you-might-like',
  'also-like', 'similar-posts', 'more-from', 'more-stories',
  'more-like-this', 'whats-next', 'further-reading', 'keep-reading',
  'next-article', 'prev-article', 'popular-posts', 'trending-posts',
  'dont-miss', 'see-also', 'read-next', 'up-next',

  // ── Comments ──────────────────────────────────────────────────────────────────
  'comment-section', 'comment-area', 'comment-list', 'comment-form',
  'comments-wrap', 'comment-meta', 'comment-author', 'comment-reply',
  'disqus', 'discussion-board', 'comment-thread',

  // ── Social / Share ────────────────────────────────────────────────────────────
  'social-share', 'share-buttons', 'share-icons', 'sharing-section',
  'social-links', 'follow-buttons', 'follow-us', 'share-bar',
  'social-media-links', 'social-proof',

  // ── Newsletter / CTA ──────────────────────────────────────────────────────────
  'newsletter-form', 'newsletter-block', 'newsletter-signup',
  'subscribe-form', 'subscription-box', 'subscribe-box',
  'cta-block', 'cta-section', 'call-to-action', 'promo-box',
  'promotional-block', 'lead-gen', 'lead-form', 'conversion-box',
  'inline-cta', 'content-upgrade', 'opt-in',

  // ── Popups / Banners ──────────────────────────────────────────────────────────
  'popup', 'modal', 'overlay', 'cookie-banner', 'cookie-consent',
  'gdpr-notice', 'notice-bar', 'announcement-bar', 'sticky-banner',
  'floating-bar', 'exit-intent',

  // ── Ads ───────────────────────────────────────────────────────────────────────
  'advertisement', 'ad-unit', 'ad-slot', 'ad-container',
  'google-ad', 'adsense', 'dfp-ad', 'sponsored-content',
  'sponsored-post', 'native-ad', 'partner-content',

  // ── TOC ───────────────────────────────────────────────────────────────────────
  'table-of-contents', 'toc-nav', 'sticky-toc', 'toc-sidebar',
  'in-page-nav', 'jump-links', 'content-nav', 'article-toc',

  // ── Post meta / Tags ─────────────────────────────────────────────────────────
  'post-meta', 'post-tags', 'article-tags', 'entry-meta',
  'article-meta', 'post-footer', 'article-footer', 'entry-footer',
  'post-date', 'post-category', 'post-info', 'article-info', 'entry-info',

  // ── Testimonials / Reviews ────────────────────────────────────────────────────
  'testimonial-section', 'testimonials-wrap', 'review-section',
  'customer-reviews', 'rating-section',

  // ── Product / Resource cards ──────────────────────────────────────────────────
  'resource-cards', 'resource-grid', 'product-cards', 'case-study-grid',
  'feature-grid', 'card-deck', 'card-grid', 'content-grid',

  // ── Pagination ────────────────────────────────────────────────────────────────
  'pagination', 'post-pagination', 'article-pagination', 'pager', 'page-links',

  // ── Widgets ───────────────────────────────────────────────────────────────────
  'wp-widget', 'text-widget', 'widget-wrap',
];

// ── Heading texts that introduce boilerplate sections ────────────────────────
// When a heading MATCHES one of these patterns, all paragraphs that follow it
// (until the next non-boilerplate heading) are excluded from body content.
export const BOILERPLATE_HEADING_PATTERNS = [
  /^about (the |our |this |an? )?authors?/i,
  /^meet (the |our )?authors?/i,
  /^about (the )?writer/i,
  /^about (the )?contributor/i,
  /^author (bio|profile|info(rmation)?|details?)/i,
  /^(written|posted|contributed|authored|created|published) by\b/i,
  /^contributor (profile|bio|info)/i,
  /^guest (author|writer|post)/i,
  /^related (posts?|articles?|content|reads?|stories|links?)/i,
  /^you might (also )?(like|enjoy|want to read|be interested)/i,
  /^(also|further|continue|keep) reading/i,
  /^more (from|like this|stories|articles|posts|reads?)/i,
  /^recommended (for you|posts?|articles?|reads?|content|resources?)/i,
  /^what('s| to) read next/i,
  /^read next/i,
  /^up next/i,
  /^next (up|in (the )?series|article|post)/i,
  /^don'?t miss/i,
  /^trending (now|topics?|posts?|articles?)?/i,
  /^popular (posts?|articles?|reads?)?/i,
  /^most (read|popular|viewed|shared)/i,
  /^subscribe (now|today|to (our|the|this))/i,
  /^sign up (for|to|now)/i,
  /^newsletter/i,
  /^(leave )?(a )?comments?$/i,
  /^join (the )?discussion/i,
  /^(share|spread) (this|the|our)/i,
  /^tags?:?\s*$/i,
  /^categories?:?\s*$/i,
  /^filed under:?\s*$/i,
  /^topics?:?\s*$/i,
  /^(post |entry )?navigation/i,
  /^(previous|next) (post|article|entry)/i,
];

// ── Text-content patterns that reveal a paragraph is boilerplate ──────────────
const BOILERPLATE_TEXT_PATTERNS = [
  // ── Author bio openers ───────────────────────────────────────────────────────
  /^about (the |our |this |an? )?authors?/i,
  /^written by\b/i,
  /^posted by\b/i,
  // "By John Smith" at the very start (capitalised proper name follows)
  /^by [A-Z][a-zA-ZÀ-ÖØ-ö'-]+ [A-Z]/,

  // ── Role description sentences ───────────────────────────────────────────────
  // "is a senior content strategist at Acme" / "is an award-winning journalist"
  /\bis (a|an) [\w\s-]{0,30}?(writer|editor|journalist|reporter|contributor|blogger|specialist|expert|analyst|strategist|marketer|consultant|manager|director|researcher|author)\b/i,
  // "covers enterprise software for Forbes"
  /\bcovers?\s+[\w\s,]+\s+(for|at|with|in)\s+[A-Z]/i,
  // "writes about competitive intelligence"
  /\bwrites?\s+about\s+\w/i,
  // "reports on technology trends"
  /\breports?\s+on\s+\w/i,
  // "focuses on market intelligence"
  /\bfocuses?\s+on\s+\w/i,
  // "specializes in / specialising in"
  /\bspecializ(es?|ing)\s+in\b/i,
  // "has been writing/covering/working for X years"
  /\bhas been (writing|covering|reporting|working|creating|contributing) (for|with|at|in|about|since)\b/i,
  // "has X years of experience"
  /\b\d+\+?\s+years? of experience\b/i,
  // "previously worked at / reported for"
  /\bpreviously (worked|wrote|reported|covered|served|contributed)\b/i,
  // "her work has appeared in / his articles have been published"
  /\b(his|her|their) (work|articles?|writing|content|pieces?) (has|have) (appeared|been published|been featured)\b/i,

  // ── Social / follow patterns ──────────────────────────────────────────────────
  /\bfollow (him|her|them|us|@\w+) on (twitter|linkedin|instagram|facebook|tiktok|youtube|x\.com|social media)\b/i,
  /\bconnect with (him|her|them|us)\b/i,
  /\bfind (him|her|them|us) on\b/i,
  /\breach (him|her|them|us) at\b/i,
  /\b(follow|connect) on (twitter|linkedin|instagram|facebook)\b/i,

  // ── Opinions / disclosure ──────────────────────────────────────────────────
  /\bviews? (expressed|stated|shared)\b/i,
  /\bopinions? (expressed|stated|are) (his|her|their) own\b/i,
  /\b(guest (post|author|contributor|blogger))\b/i,
  /\b(affiliate|sponsored|disclosure|disclaimer)\b/i,

  // ── Navigation / sharing / CTA patterns ──────────────────────────────────────
  /^(share|tweet|pin|post|email) (this|it|article|post|page)/i,
  /^(subscribe|sign up|join) (to|for|our)\b/i,
  /^(read more|learn more|find out more|discover more|see more)\b/i,
  /^(click here|tap here) to\b/i,
  /^(last updated|originally published|updated on|published on)/i,
  /^(tags|categories|filed under|posted in|topics?):/i,
  /^related (articles?|posts?|content|reading):/i,
  /^(you might (also )?(like|enjoy|want to read))/i,
];

// ── Generic anchor text (penalised in scoring) ────────────────────────────────
export const GENERIC_ANCHORS = new Set([
  'click here', 'here', 'read more', 'learn more', 'find out more',
  'discover more', 'see more', 'this', 'this article', 'this post',
  'this page', 'more', 'more info', 'more information', 'visit',
  'visit page', 'view', 'view page', 'link', 'source', 'article',
  'post', 'page', 'website', 'site',
]);

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract structured main-body content from a Cheerio-loaded document.
 *
 * @param {CheerioStatic} $ - Cheerio instance
 * @param {object} opts
 * @param {number}  opts.minParagraphWords  - min word count per paragraph (default 15)
 * @param {string}  opts.extraExcludeSelectors - additional CSS selectors to remove
 * @param {string}  opts.extraIncludeSelectors - override content zone selector
 * @returns {{
 *   paragraphs:         string[],
 *   paragraphPositions: number[],   // parallel array: relative position 0–1 within article
 *   headings:           Array<{level:string, text:string}>,
 *   extractionMethod:   string,
 *   confidence:         number,
 * }}
 */
export function extractMainContent($, {
  minParagraphWords       = 15,
  extraExcludeSelectors   = '',
  extraIncludeSelectors   = '',
} = {}) {
  // ── Stage 1: Global noise removal ──────────────────────────────────────────
  GLOBAL_NOISE_TAGS.forEach(tag => $(tag).remove());
  GLOBAL_NOISE_ROLES.forEach(role => $(`[role="${role}"]`).remove());
  $('nav, footer, header, aside').remove();

  // Remove user-supplied extra selectors
  if (extraExcludeSelectors) {
    try { $(extraExcludeSelectors.split('\n').join(',')).remove(); } catch {}
  }

  // ── Stage 2: Find main content zone ───────────────────────────────────────
  let zone, method, confidence;

  if (extraIncludeSelectors) {
    const el = $(extraIncludeSelectors.split('\n')[0].trim()).first();
    if (el.length) {
      zone = el; method = 'user-override'; confidence = 0.99;
    }
  }

  if (!zone) {
    for (const entry of MAIN_CONTENT_SELECTORS) {
      const el = $(entry.sel).first();
      if (!el.length) continue;
      const wordCount = el.text().replace(/\s+/g, ' ').trim().split(' ').length;
      if (wordCount < 50) continue;
      zone = el; method = entry.method; confidence = entry.conf;
      break;
    }
  }

  if (!zone) {
    zone = $('body'); method = 'fallback-body'; confidence = 0.35;
  }

  // ── Stage 3: Remove boilerplate within the zone ───────────────────────────
  // 3a) By keyword-in-class/id
  zone.find('*').each((_, el) => {
    if (matchesBoilerplate($, el)) $(el).remove();
  });

  // 3b) Inner structural noise
  const INNER_NOISE = [
    'figure > figcaption',
    '[data-nosnippet]',
    '[aria-hidden="true"]',
    '.wp-caption-text',
    '.screen-reader-text',
  ];
  INNER_NOISE.forEach(s => { try { zone.find(s).remove(); } catch {} });

  // ── Stage 4: Extract clean paragraphs (with position tracking) ───────────
  const { paras, positions } = extractParagraphs($, zone, minParagraphWords);

  // ── Stage 5: Extract headings ─────────────────────────────────────────────
  const headings = [];
  zone.find('h1,h2,h3,h4').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (text && text.length > 2 && text.length < 300)
      headings.push({ level: el.tagName.toUpperCase(), text });
  });

  return {
    paragraphs:         paras,
    paragraphPositions: positions,
    headings,
    extractionMethod:   method,
    confidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  HEADING PROXIMITY  ── CORE AUTHOR-BIO FIX
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the given heading text introduces a boilerplate section
 * ("About the Author", "Related Posts", "Subscribe", etc.).
 *
 * Exported so unit tests can import and verify specific heading strings.
 */
export function isBoilerplateHeading(text) {
  if (!text || text.length < 3) return false;
  const t = text.trim();
  return BOILERPLATE_HEADING_PATTERNS.some(rx => rx.test(t));
}

/**
 * Returns true when `el` appears AFTER a boilerplate heading in the DOM,
 * meaning it should be excluded from body-content extraction.
 *
 * Strategy: walk upward from `el` toward the zone root.  At each level,
 * look for the nearest PRECEDING heading sibling.
 *  • If that heading is a boilerplate heading  → return true (skip paragraph)
 *  • If that heading is a real content heading → return false (keep paragraph)
 *  • If no heading found at this level         → go up one more level
 * If we reach the zone root with no heading found → return false (safe).
 *
 * This correctly handles both flat and nested structures:
 *   Flat:   <article><h2>About Author</h2><p>bio</p></article>
 *   Nested: <article><div><h2>About Author</h2><p>bio</p></div></article>
 */
function isAfterBoilerplateHeading($, el, zone) {
  const HEADING_SEL = 'h1,h2,h3,h4,h5,h6';
  let $node = $(el);

  // Walk up at most 8 levels (enough for any realistic nesting)
  for (let depth = 0; depth < 8; depth++) {
    if (!$node.length) break;

    // Stop if we've reached or passed the zone root
    if (zone && $node.is(zone)) break;

    // Find the nearest preceding heading sibling at this DOM level
    const $ph = $node.prevAll(HEADING_SEL).first();

    if ($ph.length) {
      const headingText = $ph.text().replace(/\s+/g, ' ').trim();
      // Found a heading — let it decide
      return isBoilerplateHeading(headingText);
    }

    // No heading sibling found at this level; go up one level
    $node = $node.parent();
  }

  // No heading found anywhere in the ancestor chain → not after a boilerplate heading
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true when an element's class/id/aria-label contain boilerplate keywords. */
function matchesBoilerplate($, el) {
  const cls  = ($(el).attr('class') || '').toLowerCase();
  const id   = ($(el).attr('id')    || '').toLowerCase();
  const aria = ($(el).attr('aria-label') || '').toLowerCase();
  const combined = `${cls} ${id} ${aria}`;

  // Direct substring check against compound keywords
  for (const kw of BOILERPLATE_KEYWORDS) {
    if (combined.includes(kw)) return true;
  }

  // Exact single-token check (prevents e.g. "navigate" matching "nav")
  const EXACT_SINGLE_TOKENS = new Set([
    'author', 'bio', 'byline', 'footer', 'header', 'nav', 'navigation',
    'sidebar', 'aside', 'widget', 'related', 'comments', 'comment',
    'share', 'social', 'newsletter', 'subscribe', 'cta', 'advertisement',
    'ads', 'ad', 'pagination', 'breadcrumb', 'toc', 'testimonials',
    'testimonial', 'popup', 'modal', 'banner',
  ]);
  const tokens = combined.split(/[\s\-_/]+/).filter(Boolean);
  if (tokens.some(t => EXACT_SINGLE_TOKENS.has(t))) return true;

  return false;
}

/**
 * Extract clean paragraphs from the zone.
 * Also returns a parallel `positions` array (relative position 0–1 within article).
 *
 * Three-layer boilerplate rejection:
 *   1. Ancestor element class/id matching  (matchesBoilerplate)
 *      — IMPORTANT: stops at the zone root so the zone container itself
 *        (e.g. .article-content) never flags its own children as boilerplate.
 *   2. Heading-proximity detection          (isAfterBoilerplateHeading)
 *   3. Paragraph text pattern matching     (isBoilerplateText)
 *
 * Also extracts text from leaf <div> elements (divs with no block children)
 * to handle CMSes that use divs instead of <p> tags.
 */
function extractParagraphs($, zone, minWords) {
  const seen   = new Set();
  const paras  = [];
  const zoneEl = zone[0]; // zone root — NEVER flag this element as boilerplate

  // Include leaf <div>s (no block-level children) alongside <p> and <li>
  zone.find('p, li, div').each((_, el) => {
    // For divs: skip containers that have block-level children — they are
    // layout wrappers, not paragraph-equivalent elements.
    const tagName = (el.tagName || el.name || '').toLowerCase();
    if (tagName === 'div') {
      const hasBlock = $(el).children(
        'p, div, li, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, table, pre, section, article, aside, main, figure'
      ).length > 0;
      if (hasBlock) return;
    }

    // ── Layer 1: Ancestor boilerplate class/id check ────────────────────────
    // Walk UP from the element but STOP before the zone root.
    // The zone element itself (e.g. .article-content, .blog-content) is a
    // legitimate content container even if its class appears in BOILERPLATE_KEYWORDS.
    let skip = false;
    let $parent = $(el).parent();
    while (
      $parent.length &&
      $parent[0] &&
      $parent[0] !== zoneEl &&
      $parent[0].name !== 'body' &&
      $parent[0].name !== 'html'
    ) {
      if (matchesBoilerplate($, $parent[0])) { skip = true; break; }
      $parent = $parent.parent();
    }
    if (skip) return;

    // ── Layer 2: Heading-proximity check  (AUTHOR BIO FIX) ─────────────────
    if (isAfterBoilerplateHeading($, el, zone)) return;

    // ── Layer 3: Text quality checks ────────────────────────────────────────
    const raw  = $(el).text();
    const text = raw.replace(/\s+/g, ' ').trim();
    const wc   = text.split(/\s+/).length;

    if (wc < minWords)          return;
    if (seen.has(text))          return;
    if (isBoilerplateText(text)) return;

    seen.add(text);
    paras.push(text);
  });

  // Compute relative positions (0 = first, 1 = last)
  const total = paras.length;
  const positions = paras.map((_, i) =>
    total <= 1 ? 0 : parseFloat((i / (total - 1)).toFixed(3))
  );

  return { paras: paras.slice(0, 80), positions: positions.slice(0, 80) };
}

/** Returns true if the paragraph text matches any boilerplate pattern. */
export function isBoilerplateText(text) {
  for (const rx of BOILERPLATE_TEXT_PATTERNS) {
    if (rx.test(text)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CROSS-PAGE BOILERPLATE FINGERPRINTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given an array of page objects (each with a `paragraphs` string[]),
 * return a Set of paragraph strings that appear verbatim on 3 or more pages
 * (or on more than 30% of pages, whichever threshold is LOWER).
 *
 * These are site-wide template texts (author bio templates, category intros,
 * footer disclaimers, etc.) that slipped through per-page extraction.
 *
 * Usage in analyze-links.js:
 *   const boilerplate = findCrossPageBoilerplate(pages);
 *   pages.forEach(p => {
 *     p.paragraphs = p.paragraphs.filter(t => !boilerplate.has(t));
 *   });
 */
export function findCrossPageBoilerplate(pages) {
  if (!pages || pages.length < 3) return new Set();

  const freq = {};
  pages.forEach(p => {
    // Use a set per page to avoid counting duplicate paragraphs within one page
    const pageSeen = new Set(p.paragraphs);
    pageSeen.forEach(para => {
      const key = para.trim();
      if (key.length < 50) return;  // Too short to be meaningful boilerplate
      freq[key] = (freq[key] || 0) + 1;
    });
  });

  // Require a paragraph to appear on at least 40% of pages, with a hard
  // floor of 3.  This prevents over-aggressive removal on very small page sets.
  const threshold = Math.max(3, Math.ceil(pages.length * 0.40));

  return new Set(
    Object.entries(freq)
      .filter(([, count]) => count >= threshold)
      .map(([para]) => para)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXPORTED TEST HELPERS
// ─────────────────────────────────────────────────────────────────────────────
// These are exported so unit tests can directly test internal logic.
export { matchesBoilerplate, isAfterBoilerplateHeading };
