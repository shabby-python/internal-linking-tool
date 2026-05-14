/**
 * tests/run.js
 * ─────────────────────────────────────────────────────────────────────────────
 * v3 test suite — 16 test cases.
 *
 * Tests lib/extractor.js and lib/anchor.js directly (pure Node.js, no HTTP).
 * Run with:  node tests/run.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as cheerio from 'cheerio';
import {
  extractMainContent,
  findCrossPageBoilerplate,
  isBoilerplateHeading,
} from '../lib/extractor.js';
import {
  findBoundedPhrase,
  buildCandidatePhrases,
  findBestAnchor,
  isGenericAnchor,
  classifyAnchorType,
  GENERIC_SINGLE_WORDS,
  getAnchorContext,
} from '../lib/anchor.js';

// ─────────────────────────────────────────────────────────────────────────────
//  Test runner
// ─────────────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS  ${name}`);
    passed++;
  } catch(err) {
    console.log(`  ❌ FAIL  ${name}`);
    console.log(`         ${err.message}`);
    failed++;
    failures.push({ name, message: err.message });
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'Expected equal'}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}

function assertIncludes(haystack, needle, msg) {
  if (!String(haystack).includes(needle))
    throw new Error(`${msg || 'Expected to include'} "${needle}" in "${haystack}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 1 — isBoilerplateHeading (extractor.js)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 1: isBoilerplateHeading ─────────────────────────────────────');

test('T01 — "About the Author" is boilerplate heading', () => {
  assert(isBoilerplateHeading('About the Author'), 'Should flag as boilerplate');
});

test('T02 — "About Our Authors" is boilerplate heading', () => {
  assert(isBoilerplateHeading('About Our Authors'), 'Should flag as boilerplate');
});

test('T03 — "Related Posts" is boilerplate heading', () => {
  assert(isBoilerplateHeading('Related Posts'), 'Should flag as boilerplate');
});

test('T04 — Normal H2 "Competitive Intelligence in Practice" is NOT boilerplate', () => {
  assert(!isBoilerplateHeading('Competitive Intelligence in Practice'), 'Should NOT be boilerplate');
});

test('T05 — "Subscribe to our Newsletter" is boilerplate heading', () => {
  assert(isBoilerplateHeading('Subscribe to our Newsletter'), 'Should flag as boilerplate');
});

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 2 — extractMainContent: author bio exclusion
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 2: extractMainContent (author bio exclusion) ─────────────────');

test('T06 — Author bio paragraph after "About the Author" H2 is excluded', () => {
  const html = `
    <article class="post-content">
      <p>Competitive intelligence tools help teams track market signals and competitor moves effectively across industries.</p>
      <p>Understanding your competitors' pricing strategies is essential for positioning your product in a crowded market segment.</p>
      <p>Market research shows that companies using CI tools outperform those that do not by a significant margin.</p>
      <h2>About the Author</h2>
      <p>Jane Smith is a content strategist at Contify Corp, specializing in competitive intelligence and market research.</p>
      <p>She has over 10 years of experience in B2B SaaS marketing and demand generation.</p>
    </article>`;
  const $ = cheerio.load(html);
  const { paragraphs } = extractMainContent($, { minParagraphWords: 5 });

  // The author bio paragraphs should NOT be in the result
  const hasBio = paragraphs.some(p =>
    p.toLowerCase().includes('jane smith') || p.toLowerCase().includes('years of experience')
  );
  assert(!hasBio, `Author bio leaked into paragraphs: ${paragraphs.find(p => p.includes('Jane'))}`);
  assert(paragraphs.length >= 2, `Expected ≥2 body paragraphs, got ${paragraphs.length}`);
});

test('T07 — Content before boilerplate heading is preserved', () => {
  const html = `
    <main>
      <p>Tracking competitive intelligence data in real time allows businesses to respond to market changes quickly.</p>
      <p>Automated monitoring platforms aggregate news, social signals, and pricing data into unified dashboards.</p>
      <h2>About the Author</h2>
      <p>Bob Jones covers enterprise software for TechBlog. He specializes in SaaS tools.</p>
    </main>`;
  const $ = cheerio.load(html);
  const { paragraphs } = extractMainContent($, { minParagraphWords: 5 });
  assert(paragraphs.length >= 2, `Expected ≥2 paragraphs, got ${paragraphs.length}`);
  assert(paragraphs.some(p => p.includes('competitive intelligence')), 'Body content missing');
});

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 3 — findCrossPageBoilerplate (extractor.js)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 3: findCrossPageBoilerplate ─────────────────────────────────');

test('T08 — Paragraph appearing on all 3 pages is flagged as boilerplate', () => {
  const shared = 'Subscribe to our newsletter to get the latest insights and updates from our team directly in your inbox.';
  const pages = [
    { paragraphs: [shared, 'Competitive intelligence is critical for modern enterprise growth strategies in B2B markets.'] },
    { paragraphs: [shared, 'Market analysis platforms help procurement teams identify supplier risks and opportunities.'] },
    { paragraphs: [shared, 'Revenue intelligence tools aggregate CRM data to provide actionable pipeline insights for sales.'] },
  ];
  const bpSet = findCrossPageBoilerplate(pages);
  assert(bpSet.has(shared), 'Shared paragraph should be in boilerplate set');
  assert(!bpSet.has('Competitive intelligence is critical for modern enterprise growth strategies in B2B markets.'), 'Unique paragraph should NOT be boilerplate');
});

test('T09 — Paragraph on only 2 of 3 pages is NOT flagged', () => {
  const partial = 'This article was originally published on our partner site and has been updated for accuracy and completeness.';
  const pages = [
    { paragraphs: [partial, 'Intelligence platforms reduce manual research by automating data collection and synthesis.'] },
    { paragraphs: [partial, 'Predictive analytics models use historical market data to forecast competitive behavior effectively.'] },
    { paragraphs: ['Customer research shows that win-rate improves significantly when teams use structured intelligence workflows.'] },
  ];
  const bpSet = findCrossPageBoilerplate(pages);
  assert(!bpSet.has(partial), 'Paragraph on 2/3 pages should NOT be boilerplate (threshold is 3/3)');
});

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 4 — findBoundedPhrase (anchor.js)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 4: findBoundedPhrase ────────────────────────────────────────');

test('T10 — "intel" does NOT match inside "intelligence"', () => {
  const result = findBoundedPhrase('competitive intelligence platform', 'intel');
  assert(result === null, `Expected null, got "${result}"`);
});

test('T11 — "competitive intelligence" matches as a whole phrase', () => {
  const result = findBoundedPhrase('We use competitive intelligence tools to track the market.', 'competitive intelligence');
  assert(result !== null, 'Should match "competitive intelligence"');
  assertIncludes(result.toLowerCase(), 'competitive intelligence', 'Match should contain the phrase');
});

test('T12 — Word boundary: "ci" does NOT match inside "science"', () => {
  const result = findBoundedPhrase('The science of market analysis', 'ci');
  assert(result === null, `"ci" should not match inside "science", got: "${result}"`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 5 — isGenericAnchor (anchor.js)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 5: isGenericAnchor ───────────────────────────────────────────');

test('T13 — Single word "analysis" is rejected as generic', () => {
  assert(isGenericAnchor('analysis', { minWords: 2, allowSingleWord: false }), '"analysis" should be generic');
});

test('T14 — "competitive intelligence tools" (3 words) is NOT generic', () => {
  assert(!isGenericAnchor('competitive intelligence tools', { minWords: 2 }), 'Multi-word specific phrase should not be generic');
});

test('T15 — Single word "insights" is rejected', () => {
  assert(isGenericAnchor('insights', { minWords: 2, allowSingleWord: false }), '"insights" should be generic');
});

// ─────────────────────────────────────────────────────────────────────────────
//  SECTION 6 — classifyAnchorType (anchor.js)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 6: classifyAnchorType ───────────────────────────────────────');

test('T16 — Anchor matching H1 exactly → "exact" type', () => {
  const target = {
    title: 'Competitive Intelligence Platform | Contify',
    h1: 'Competitive Intelligence Platform',
    headings: [],
    topics: [],
  };
  const type = classifyAnchorType('competitive intelligence platform', target);
  assertEq(type, 'exact', 'Should be classified as exact');
});

// ─────────────────────────────────────────────────────────────────────────────
//  RESULTS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`\n  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

if (failures.length > 0) {
  console.log('  Failed tests:');
  failures.forEach(f => console.log(`    • ${f.name}: ${f.message}`));
  console.log('');
  process.exit(1);
} else {
  console.log('  🎉 All tests passed!\n');
}
