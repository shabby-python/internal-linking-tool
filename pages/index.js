/**
 * pages/index.js
 * Internal Linking Opportunity Finder — v3
 * Domain-agnostic — works for any website.
 *
 * v3 additions:
 *  - Target Page Mode: find pages that should link TO one target URL
 *  - Sitemap auto-discovery for candidate source pages
 *  - Anchor type classification badge (exact/partial/entity/branded/semantic/long-tail)
 *  - New filters: anchor type, orphan-target-only, low-inbound-target-only
 *  - New settings: minAnchorWords, allowSingleWord, customTopics
 *  - Updated scoring thresholds: High ≥8, Medium 6-7.9, Low <6
 *  - Expanded CSV export with anchor type and target link count
 */

import { useState, useMemo, useCallback } from 'react';
import Head from 'next/head';

// ─────────────────────────────────────────────────────────────────────────────
//  DEFAULT SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  maxLinksPerSource:  5,
  maxLinksPerTarget:  10,
  minScore:           7,     // v3: raised to 7 (High ≥8, Medium 6–7.9, Low <6)
  minParagraphWords:  15,
  minKeywordOverlap:  2,
  minAnchorWords:     2,     // v3: prefer 2+ word anchors
  allowSingleWord:    false, // v3: reject single-word anchors by default
  customTopics:       '',    // v3: extra anchor candidate phrases (newline-separated)
  maxPages:           50,
  maxSitemapURLs:     60,    // v3: cap for sitemap auto-discovery (60 = safe for Vercel free tier)
  excludePatterns:    '',
  includePatterns:    '',
  excludeSelectors:   '',
  includeSelectors:   '',
  linkInHeadings:     false,
};

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  brand:   '#1a56db',
  brandL:  '#e8f0fe',
  green:   '#0e9f6e',
  greenL:  '#def7ec',
  orange:  '#d97706',
  orangeL: '#fef3c7',
  red:     '#e02424',
  redL:    '#fde8e8',
  purple:  '#7c3aed',
  purpleL: '#ede9fe',
  teal:    '#0891b2',
  tealL:   '#cffafe',
  g50:     '#f9fafb',
  g100:    '#f3f4f6',
  g200:    '#e5e7eb',
  g300:    '#d1d5db',
  g400:    '#9ca3af',
  g500:    '#6b7280',
  g600:    '#4b5563',
  g700:    '#374151',
  g800:    '#1f2937',
  g900:    '#111827',
};

const card   = { background:'#fff', border:`1px solid ${C.g200}`, borderRadius:10, boxShadow:'0 1px 3px rgba(0,0,0,.07)', padding:'1.4rem', marginBottom:'1.1rem' };
const tabBtn = (active) => ({ padding:'8px 14px', fontSize:12, fontWeight:600, border:'none', background:'transparent', color:active?C.brand:C.g500, borderBottom:`2.5px solid ${active?C.brand:'transparent'}`, cursor:'pointer', marginBottom:-1, borderRadius:'6px 6px 0 0', transition:'color .15s' });
const btn    = (primary, small) => ({ display:'inline-flex', alignItems:'center', gap:6, padding:small?'6px 13px':'9px 18px', borderRadius:8, fontSize:small?11:13, fontWeight:600, border:primary?'none':`1.5px solid ${C.g300}`, background:primary?C.brand:'#fff', color:primary?'#fff':C.g600, cursor:'pointer', transition:'all .15s' });
const input  = { padding:'7px 11px', border:`1.5px solid ${C.g300}`, borderRadius:8, fontSize:12, outline:'none', background:'#fff' };
const badge  = (bg, col) => ({ display:'inline-flex', alignItems:'center', padding:'3px 9px', borderRadius:20, fontSize:10, fontWeight:700, background:bg, color:col, whiteSpace:'nowrap' });

const LINK_TYPE_STYLE = {
  'Blog-to-service':    [C.brandL,  C.brand],
  'Blog-to-product':    [C.purpleL, C.purple],
  'Blog-to-blog':       [C.greenL,  C.green],
  'Blog-to-category':   ['#fce7f3', '#9d174d'],
  'Blog-to-commercial': [C.orangeL, C.orange],
  'Blog-to-guide':      [C.tealL,   C.teal],
  'Blog-to-comparison': ['#fce7f3', '#be185d'],
};

const POS_STYLE = {
  Early:  [C.greenL,  C.green],
  Middle: [C.brandL,  C.brand],
  Late:   [C.g100,    C.g500],
};

const ANCHOR_TYPE_STYLE = {
  exact:     [C.greenL,  C.green],
  partial:   [C.brandL,  C.brand],
  entity:    [C.purpleL, C.purple],
  branded:   [C.orangeL, C.orange],
  semantic:  [C.tealL,   C.teal],
  'long-tail': ['#fce7f3', '#9d174d'],
};

const trim      = (s='', n=55) => s.length > n ? s.slice(0,n)+'…' : s;
const pathOf    = (url='') => { try { return new URL(url).pathname || '/'; } catch { return url; } };
const scoreColor = s => s>=8 ? C.green : s>=6 ? C.orange : C.g400;  // v3 thresholds
const scoreBg    = s => s>=8 ? C.greenL : s>=6 ? C.orangeL : C.g100;

// ─────────────────────────────────────────────────────────────────────────────
//  OPPORTUNITY CARD
// ─────────────────────────────────────────────────────────────────────────────
function OppCard({ opp, idx }) {
  const [open, setOpen] = useState(false);
  const [bgH,  setBgH]  = useState('#fff');
  const ltStyle  = LINK_TYPE_STYLE[opp.linkType] || [C.g100, C.g600];
  const posStyle = POS_STYLE[opp.paraPositionLabel] || POS_STYLE.Middle;
  const atStyle  = ANCHOR_TYPE_STYLE[opp.anchorType] || [C.g100, C.g500];
  const sc = opp.score, cf = opp.confidence;

  // Highlight anchor text inside a paragraph
  const hlPara = (para, anchor) => {
    if (!anchor) return para;
    const esc   = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let rx;
    try { rx = new RegExp(`(${esc})`, 'i'); } catch { return para; }
    const parts = para.split(rx);
    return parts.map((p, i) =>
      i % 2 === 1
        ? <mark key={i} style={{background:'#fef08a',borderRadius:2,padding:'0 2px',fontWeight:700}}>{p}</mark>
        : p
    );
  };

  // Render markdown-style [anchor](url) as a styled link chip
  const renderUpdated = txt => {
    const rx = /\[([^\]]+)\]\(([^)]+)\)/g;
    const parts = []; let last = 0, m;
    while ((m = rx.exec(txt)) !== null) {
      if (m.index > last) parts.push(txt.slice(last, m.index));
      parts.push(
        <span key={m.index} style={{background:C.brandL,color:C.brand,fontWeight:700,borderRadius:4,padding:'1px 5px',borderBottom:`2px solid ${C.brand}`,display:'inline-block'}}>{m[1]} ↗</span>
      );
      last = m.index + m[0].length;
    }
    if (last < txt.length) parts.push(txt.slice(last));
    return parts;
  };

  return (
    <div style={{border:`1px solid ${C.g200}`,borderRadius:10,marginBottom:8,overflow:'hidden',background:'#fff',boxShadow:'0 1px 3px rgba(0,0,0,.05)'}}>
      {/* Row header */}
      <div
        onClick={()=>setOpen(!open)}
        onMouseEnter={()=>setBgH(C.g50)}
        onMouseLeave={()=>setBgH('#fff')}
        style={{display:'flex',alignItems:'center',gap:10,padding:'11px 15px',cursor:'pointer',userSelect:'none',background:bgH}}
      >
        <div style={{width:24,height:24,borderRadius:'50%',background:C.brandL,color:C.brand,fontSize:10,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>{idx+1}</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:12,fontWeight:700,color:C.g800,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
            {pathOf(opp.sourceURL)} → {pathOf(opp.targetURL)}
          </div>
          <div style={{fontSize:11,color:C.g400,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
            Anchor: "{opp.suggestedAnchor}" · {opp.sharedKeywords.slice(0,5).join(', ')}
          </div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:7,flexShrink:0}}>
          {/* Anchor type badge */}
          {opp.anchorType && (
            <span style={badge(atStyle[0], atStyle[1])}>{opp.anchorType}</span>
          )}
          {/* Position badge */}
          {opp.paraPositionLabel && (
            <span style={badge(posStyle[0], posStyle[1])}>{opp.paraPositionLabel}</span>
          )}
          <span style={badge(ltStyle[0],ltStyle[1])}>{opp.linkType}</span>
          <div style={{width:34,height:34,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:800,color:scoreColor(sc),background:scoreBg(sc),border:`2.5px solid ${scoreColor(sc)}`,flexShrink:0}}>{sc}</div>
          <span style={{fontSize:10,color:C.g400,transform:open?'rotate(180deg)':'none',transition:'transform .2s',display:'inline-block'}}>▼</span>
        </div>
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{borderTop:`1px solid ${C.g100}`,padding:16}}>
          <div style={{display:'grid',gap:14}}>

            <FieldRow label="🎯 Target Page">
              <a href={opp.targetURL} target="_blank" rel="noreferrer" style={{color:C.brand,fontWeight:600,fontSize:12,wordBreak:'break-all'}}>{opp.targetURL}</a>
              <div style={{fontSize:11,color:C.g400,marginTop:2}}>{opp.targetTitle} <span style={badge(C.g100,C.g500)}>{opp.targetPageType}</span></div>
            </FieldRow>

            <FieldRow label="📄 Source Page">
              <a href={opp.sourceURL} target="_blank" rel="noreferrer" style={{color:C.brand,fontWeight:600,fontSize:12,wordBreak:'break-all'}}>{opp.sourceURL}</a>
              <div style={{fontSize:11,color:C.g400,marginTop:2}}>{opp.sourceTitle}</div>
            </FieldRow>

            <FieldRow label="📝 Existing Paragraph">
              <div style={{background:C.g50,border:`1px solid ${C.g200}`,borderRadius:7,padding:'11px 14px',fontSize:13,color:C.g700,lineHeight:1.7}}>{hlPara(opp.existingParagraph,opp.suggestedAnchor)}</div>
              <div style={{fontSize:11,color:C.g400,marginTop:4}}>
                ↑ Highlighted = suggested anchor location &nbsp;·&nbsp;
                Extracted from: <strong>{opp.bodyContentReason?.split('"')[1] || 'body'}</strong>
              </div>
            </FieldRow>

            <FieldRow label="🔗 Suggested Anchor">
              <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                <span style={{background:C.brandL,color:C.brand,fontSize:12,fontWeight:700,padding:'4px 11px',borderRadius:5,fontFamily:'monospace'}}>{opp.suggestedAnchor}</span>
                {/* Position badge */}
                {opp.paraPositionLabel && (
                  <span style={{...badge(posStyle[0],posStyle[1]),fontSize:11}}>
                    {opp.paraPositionLabel === 'Early' ? '📍 Early in article' : opp.paraPositionLabel === 'Middle' ? '📌 Mid article' : '📎 Late in article'}
                  </span>
                )}
              </div>
              {/* Anchor context window */}
              {opp.anchorContext && (
                <div style={{marginTop:7,background:'#fffbeb',border:'1px solid #fde68a',borderRadius:6,padding:'7px 12px',fontSize:12,color:C.g600,fontStyle:'italic',lineHeight:1.6}}>
                  Context: "{opp.anchorContext}"
                </div>
              )}
            </FieldRow>

            <FieldRow label="✏️ Updated Paragraph">
              <div style={{background:'#f0fdf4',border:'1px solid #86efac',borderRadius:7,padding:'11px 14px',fontSize:13,color:C.g700,lineHeight:1.7}}>{renderUpdated(opp.updatedParagraph)}</div>
              <div style={{fontSize:11,color:C.g400,marginTop:4}}>↑ Blue chip = where to insert the internal link</div>
            </FieldRow>

            <FieldRow label="💡 Why This Link">
              <div style={{background:C.brandL,borderLeft:`3px solid ${C.brand}`,padding:'9px 13px',borderRadius:'0 6px 6px 0',fontSize:12,color:C.g700,lineHeight:1.6}}>{opp.reason}</div>
            </FieldRow>

            <FieldRow label="✅ Body Content Proof">
              <div style={{background:C.greenL,borderLeft:`3px solid ${C.green}`,padding:'9px 13px',borderRadius:'0 6px 6px 0',fontSize:12,color:C.g700,lineHeight:1.6}}>{opp.bodyContentReason}</div>
            </FieldRow>

            {opp.warnings?.length > 0 && (
              <FieldRow label="⚠ Warnings">
                <div style={{background:C.orangeL,borderLeft:`3px solid ${C.orange}`,padding:'9px 13px',borderRadius:'0 6px 6px 0',fontSize:12,color:C.g700}}>{opp.warnings.join('; ')}</div>
              </FieldRow>
            )}

            <FieldRow label="🔑 Shared Keywords">
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {opp.sharedKeywords.map(kw => <span key={kw} style={{background:C.g100,color:C.g600,fontSize:11,fontWeight:600,padding:'2px 8px',borderRadius:4,fontFamily:'monospace'}}>{kw}</span>)}
              </div>
            </FieldRow>

            <FieldRow label="⭐ Score / Confidence">
              <div style={{display:'flex',alignItems:'center',gap:12}}>
                <div style={{width:44,height:44,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,fontWeight:800,color:scoreColor(sc),background:scoreBg(sc),border:`2.5px solid ${scoreColor(sc)}`}}>{sc}/10</div>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:C.g900}}>{opp.priority} Priority</div>
                  <div style={{fontSize:11,color:C.g400}}>Confidence: {cf}% · {opp.sharedKeywords.length} shared terms</div>
                </div>
              </div>
            </FieldRow>

            <FieldRow label="🏷 Link Type">
              <span style={{...badge(ltStyle[0],ltStyle[1]),fontSize:12,padding:'5px 13px'}}>{opp.linkType}</span>
            </FieldRow>

            {opp.anchorType && (
              <FieldRow label="🔤 Anchor Type">
                <span style={{...badge(atStyle[0],atStyle[1]),fontSize:12,padding:'5px 13px'}}>{opp.anchorType}</span>
                <div style={{fontSize:11,color:C.g400,marginTop:4}}>
                  {{exact:'Anchor matches target title/H1 exactly',partial:'Anchor is a sub-phrase of the title',entity:'Contains a named entity / proper noun',branded:'Matches a brand or topic signal',semantic:'Keyword overlap without direct title match','long-tail':'5+ word descriptive phrase'}[opp.anchorType] || ''}
                </div>
              </FieldRow>
            )}

          </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, children }) {
  return (
    <div style={{display:'grid',gridTemplateColumns:'160px 1fr',gap:10,alignItems:'start'}}>
      <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.5px',color:C.g500,paddingTop:3}}>{label}</div>
      <div style={{fontSize:13,color:C.g700}}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUMMARY REPORT TAB
// ─────────────────────────────────────────────────────────────────────────────
function SummaryTab({ summary, opps }) {
  if (!summary) return null;
  return (
    <div style={{display:'grid',gap:20}}>

      {summary.boilerplateRemovedCount > 0 && (
        <div style={{padding:'10px 14px',background:C.tealL,border:`1px solid ${C.teal}`,borderRadius:8,fontSize:12,color:C.teal,fontWeight:600}}>
          🧹 Cross-page boilerplate fingerprinting removed {summary.boilerplateRemovedCount} repeated paragraph(s) that appeared across 3+ pages (e.g., author bio templates, category intros).
        </div>
      )}

      <SummarySection title="🏆 Top Opportunities">
        {summary.topOpps.map((o,i) => (
          <RecItem key={i} icon={['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣'][i]||'📌'}>
            <strong>{trim(o.sourceTitle,42)}</strong> → <strong>{trim(o.targetTitle,42)}</strong>
            <div style={{fontSize:11,color:C.g500,marginTop:2}}>
              Score {o.score}/10 · {o.linkType} · Anchor: "{o.suggestedAnchor}"
              {o.paraPositionLabel && <span style={{marginLeft:6,...badge(POS_STYLE[o.paraPositionLabel]?.[0]||C.g100, POS_STYLE[o.paraPositionLabel]?.[1]||C.g500)}}>{o.paraPositionLabel}</span>}
            </div>
          </RecItem>
        ))}
      </SummarySection>

      {summary.orphanPages.length > 0 && (
        <SummarySection title="🚨 Orphan Pages (No Inbound Links)">
          {summary.orphanPages.map((p,i) => (
            <RecItem key={i} icon="🔴">
              <strong>{trim(p.title,52)}</strong> <span style={badge(C.g100,C.g500)}>{p.pageType}</span>
              <div style={{fontSize:11,color:C.g400,marginTop:2}}>
                <a href={p.url} target="_blank" rel="noreferrer" style={{color:C.brand}}>{p.url}</a>
              </div>
            </RecItem>
          ))}
        </SummarySection>
      )}

      {summary.needsMoreLinks.length > 0 && (
        <SummarySection title="📉 Pages Needing More Inbound Links">
          {summary.needsMoreLinks.map((p,i) => (
            <RecItem key={i} icon="⚠️">
              <strong>{trim(p.title,52)}</strong>
              <div style={{fontSize:11,color:C.g500,marginTop:2}}>Only {p.inbound} inbound link(s) — add more contextual links from related pages</div>
            </RecItem>
          ))}
        </SummarySection>
      )}

      {summary.tooManyLinks?.length > 0 && (
        <SummarySection title="📊 Pages with Many Outgoing Links (Review)">
          {summary.tooManyLinks.map((p,i) => (
            <RecItem key={i} icon="📋">
              <strong>{trim(p.title,52)}</strong>
              <div style={{fontSize:11,color:C.g500,marginTop:2}}>{p.outbound} outgoing link opportunities — prioritise highest-scoring ones</div>
            </RecItem>
          ))}
        </SummarySection>
      )}

      <SummarySection title="🔤 Anchor Text Variations Found">
        <div style={{display:'flex',flexWrap:'wrap',gap:8,padding:'4px 0'}}>
          {summary.anchorVariations.map(a => (
            <span key={a} style={{background:C.brandL,color:C.brand,fontSize:11,fontWeight:700,padding:'3px 10px',borderRadius:5,fontFamily:'monospace'}}>{a}</span>
          ))}
        </div>
      </SummarySection>

      {Object.keys(summary.byType||{}).length > 0 && (
        <SummarySection title="📊 Opportunities by Link Type">
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:8}}>
            {Object.entries(summary.byType).map(([type,count]) => {
              const s = LINK_TYPE_STYLE[type]||[C.g100,C.g600];
              return (
                <div key={type} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',background:s[0],borderRadius:7}}>
                  <span style={{fontSize:11,fontWeight:700,color:s[1]}}>{type}</span>
                  <span style={{fontSize:14,fontWeight:800,color:s[1]}}>{count}</span>
                </div>
              );
            })}
          </div>
        </SummarySection>
      )}

    </div>
  );
}

function SummarySection({ title, children }) {
  return (
    <div>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g500,marginBottom:10}}>{title}</div>
      <div style={{display:'flex',flexDirection:'column',gap:7}}>{children}</div>
    </div>
  );
}
function RecItem({ icon, children }) {
  return (
    <div style={{display:'flex',gap:10,alignItems:'flex-start',padding:'9px 12px',borderRadius:7,background:C.g50,border:`1px solid ${C.g200}`,fontSize:12,color:C.g700,lineHeight:1.5}}>
      <span style={{fontSize:14,flexShrink:0}}>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETTINGS TAB
// ─────────────────────────────────────────────────────────────────────────────
function SettingsTab({ settings, onChange }) {
  const num = (key, label, min, max, step=1, hint='') => (
    <div style={{display:'grid',gridTemplateColumns:'240px 1fr',gap:10,alignItems:'start',marginBottom:14}}>
      <div>
        <label style={{fontSize:12,fontWeight:600,color:C.g700,display:'block'}}>{label}</label>
        {hint && <div style={{fontSize:10,color:C.g400,marginTop:2}}>{hint}</div>}
      </div>
      <input type="number" min={min} max={max} step={step} value={settings[key]}
        onChange={e=>onChange(key, Number(e.target.value))}
        style={{...input,width:100}}/>
    </div>
  );
  const toggle = (key, label) => (
    <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
      <input type="checkbox" checked={!!settings[key]} onChange={e=>onChange(key,e.target.checked)} id={key}/>
      <label htmlFor={key} style={{fontSize:12,fontWeight:600,color:C.g700,cursor:'pointer'}}>{label}</label>
    </div>
  );
  const textarea = (key, label, placeholder) => (
    <div style={{marginBottom:16}}>
      <label style={{fontSize:12,fontWeight:600,color:C.g700,display:'block',marginBottom:5}}>{label}</label>
      <textarea value={settings[key]} onChange={e=>onChange(key,e.target.value)}
        placeholder={placeholder}
        style={{...input,width:'100%',minHeight:70,fontFamily:'monospace',fontSize:11,resize:'vertical'}}/>
    </div>
  );

  return (
    <div style={{maxWidth:700}}>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:16}}>Link Limits</div>
      {num('maxLinksPerSource',  'Max outgoing links per source page', 1, 20, 1)}
      {num('maxLinksPerTarget',  'Max incoming links per target page', 1, 30, 1)}
      {num('minScore',           'Minimum opportunity score (1–10)',   1, 10, 1,
            'Only show opportunities at or above this score.')}
      {num('minKeywordOverlap',  'Minimum inter-page keyword overlap', 1, 20, 1,
            'Source and target pages must share at least this many keywords. Raise to reduce false positives.')}
      {num('minParagraphWords',  'Min words per body paragraph',       5, 100, 1,
            'Paragraphs shorter than this are ignored.')}
      {num('maxPages',           'Max pages to analyze', 5, 100, 1)}

      <div style={{borderTop:`1px solid ${C.g200}`,margin:'16px 0'}}/>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:16}}>Anchor Quality (v3)</div>
      {num('minAnchorWords',   'Minimum anchor words',          1, 6, 1,
            'Reject anchors shorter than this many words. Default 2 — prefers "competitive intelligence" over "intelligence".')}
      {toggle('allowSingleWord', 'Allow single-word anchors (not recommended)')}
      {textarea('customTopics', 'Custom anchor candidate phrases (one per line)',
        'Extra phrases to use as anchor candidates.\ne.g.\ncompetitive intelligence platform\nmarket intelligence tools')}

      <div style={{borderTop:`1px solid ${C.g200}`,margin:'16px 0'}}/>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:16}}>Target Page Mode</div>
      {num('maxSitemapURLs', 'Max sitemap URLs to discover', 10, 500, 10,
            'Vercel free tier: keep at ≤60 to stay within the 10s function timeout. Vercel Pro supports up to 300+. Running locally: no limit.')}

      <div style={{borderTop:`1px solid ${C.g200}`,margin:'16px 0'}}/>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:16}}>Content Extraction</div>
      {toggle('linkInHeadings', 'Allow link suggestions inside headings (not recommended)')}
      {textarea('excludeSelectors', 'Extra CSS selectors to exclude from content extraction', 'e.g.\n.my-custom-author-box\n#promo-section\n.sidebar-widget')}
      {textarea('includeSelectors', 'Override content zone selector (optional — use if auto-detection fails)', 'e.g. .my-article-body')}

      <div style={{borderTop:`1px solid ${C.g200}`,margin:'16px 0'}}/>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:16}}>URL Filters</div>
      {textarea('excludePatterns', 'Exclude URL patterns (one per line)', 'e.g.\n/tag/\n/author/\n?page=\n/category/')}
      {textarea('includePatterns', 'Only analyze URLs matching these patterns (one per line)', 'e.g.\n/blog/\n/resources/')}

      <div style={{padding:'12px 14px',background:C.brandL,borderRadius:8,fontSize:12,color:C.brand}}>
        ℹ Settings are applied on the next analysis run. Click <strong>Find Linking Opportunities</strong> to re-analyze.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGES TABLE
// ─────────────────────────────────────────────────────────────────────────────
function PagesTable({ pages }) {
  return (
    <div style={{overflowX:'auto',border:`1px solid ${C.g200}`,borderRadius:8}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
        <thead>
          <tr style={{background:C.g50}}>
            {['Page','Type','Extract Method','Confidence','Paragraphs','Keywords','Existing Links','Inbound','Status'].map(h=>(
              <th key={h} style={{padding:'9px 12px',textAlign:'left',fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.5px',color:C.g500,borderBottom:`1px solid ${C.g200}`,whiteSpace:'nowrap'}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pages.map((p,i)=>(
            <tr key={i} style={{borderBottom:`1px solid ${C.g100}`}}>
              <td style={{padding:'10px 12px'}}>
                <a href={p.url} target="_blank" rel="noreferrer" style={{color:C.brand,fontWeight:600,display:'block',maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontSize:11}}>{pathOf(p.url)}</a>
                <div style={{fontSize:11,color:C.g400,marginTop:1}}>{trim(p.title,38)}</div>
              </td>
              <td style={{padding:'10px 12px'}}><span style={badge(C.brandL,C.brand)}>{p.pageType}</span></td>
              <td style={{padding:'10px 12px',fontSize:11,color:C.g600,fontFamily:'monospace'}}>{p.extractionMethod}</td>
              <td style={{padding:'10px 12px'}}>
                <div style={{display:'flex',alignItems:'center',gap:5}}>
                  <div style={{flex:1,background:C.g200,borderRadius:99,height:5,overflow:'hidden',minWidth:50}}>
                    <div style={{height:'100%',background:p.confidence>=0.8?C.green:p.confidence>=0.6?C.orange:C.red,width:`${Math.round(p.confidence*100)}%`}}/>
                  </div>
                  <span style={{fontSize:10,color:C.g500,flexShrink:0}}>{Math.round(p.confidence*100)}%</span>
                </div>
              </td>
              <td style={{padding:'10px 12px',fontWeight:700,color:C.g800}}>{p.paragraphCount}</td>
              <td style={{padding:'10px 12px',fontWeight:700,color:C.g800}}>{p.keywords?.length||0}</td>
              <td style={{padding:'10px 12px',fontWeight:700,color:C.green}}>{p.existingLinks?.length||0}</td>
              <td style={{padding:'10px 12px',fontWeight:700,color:C.brand}}>{p.inboundCount||0}</td>
              <td style={{padding:'10px 12px',fontSize:11,color:p.noOpportunityReason?C.orange:C.green}}>
                {p.noOpportunityReason ? `⚠ ${trim(p.noOpportunityReason,45)}` : '✓ Has opportunities'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  ORPHAN PAGES TAB
// ─────────────────────────────────────────────────────────────────────────────
function OrphanTab({ summary }) {
  const orphans = summary?.orphanPages || [];
  if (orphans.length === 0)
    return <div style={{textAlign:'center',padding:'2.5rem',color:C.g400,fontSize:13}}>🎉 No orphan pages detected in the URL set.</div>;
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <div style={{padding:'10px 14px',background:C.orangeL,border:`1px solid ${C.orange}`,borderRadius:8,fontSize:12,color:C.orange,fontWeight:600,marginBottom:4}}>
        ⚠ {orphans.length} orphan page{orphans.length!==1?'s':''} detected — these have zero inbound internal links from the pages you provided. Prioritize them as link targets.
      </div>
      {orphans.map((p,i)=>(
        <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 16px',background:'#fff',border:`1px solid ${C.g200}`,borderRadius:8,gap:12}}>
          <div>
            <a href={p.url} target="_blank" rel="noreferrer" style={{color:C.brand,fontWeight:600,fontSize:12}}>{p.url}</a>
            <div style={{fontSize:11,color:C.g500,marginTop:2}}>{p.title} · <span style={{fontWeight:700}}>{p.pageType}</span></div>
          </div>
          <span style={badge(C.redL,C.red)}>No inbound links</span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  FAILURES TAB
// ─────────────────────────────────────────────────────────────────────────────
function FailuresTab({ fetchLog, skipped }) {
  const failures = fetchLog.filter(l => !l.success && !l.status?.startsWith('skipped'));
  const skips    = [...skipped, ...fetchLog.filter(l => l.status?.startsWith('skipped'))];

  return (
    <div style={{display:'grid',gap:20}}>
      {failures.length > 0 && (
        <div>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:10}}>Fetch Failures ({failures.length})</div>
          <div style={{display:'flex',flexDirection:'column',gap:7}}>
            {failures.map((f,i)=>(
              <div key={i} style={{padding:'10px 14px',background:C.redL,border:`1px solid #fca5a5`,borderRadius:7,fontSize:12}}>
                <div style={{fontWeight:700,color:C.red}}>{f.url}</div>
                <div style={{color:C.g600,marginTop:2}}>{f.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {skips.length > 0 && (
        <div>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:10}}>Skipped URLs ({skips.length})</div>
          <div style={{display:'flex',flexDirection:'column',gap:7}}>
            {skips.map((s,i)=>(
              <div key={i} style={{padding:'10px 14px',background:C.orangeL,border:`1px solid #fde68a`,borderRadius:7,fontSize:12}}>
                <div style={{fontWeight:700,color:C.orange}}>{s.url}</div>
                <div style={{color:C.g600,marginTop:2}}><strong>Reason:</strong> {s.reason} — {s.details}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {failures.length === 0 && skips.length === 0 && (
        <div style={{textAlign:'center',padding:'2.5rem',color:C.g400,fontSize:13}}>✓ No failures or skipped URLs.</div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  DIAGNOSTICS TAB (v3.1 — Target Page Mode)
// ─────────────────────────────────────────────────────────────────────────────
function DiagnosticsTab({ diag }) {
  if (!diag) return <div style={{textAlign:'center',padding:'2.5rem',color:C.g400,fontSize:13}}>No diagnostics available yet — run a Target Page analysis first.</div>;

  const statRow = (label, val, hint) => (
    <div key={label} style={{display:'grid',gridTemplateColumns:'260px 1fr',gap:10,alignItems:'start',padding:'7px 0',borderBottom:`1px solid ${C.g100}`}}>
      <div style={{fontSize:11,fontWeight:700,color:C.g500}}>{label}</div>
      <div>
        <span style={{fontSize:13,fontWeight:800,color:C.g800}}>{val}</span>
        {hint && <span style={{fontSize:10,color:C.g400,marginLeft:8}}>{hint}</span>}
      </div>
    </div>
  );

  return (
    <div style={{display:'grid',gap:20}}>

      {/* Pipeline Stats */}
      <div>
        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:10}}>Pipeline Stats</div>
        <div style={{background:C.g50,border:`1px solid ${C.g200}`,borderRadius:8,padding:'0 14px'}}>
          {statRow('Sitemap source',    diag.sitemapSource || 'none',    '')}
          {statRow('Discovered URLs',   diag.discoveredURLs,              'total URLs found in sitemap')}
          {statRow('Manual sitemap URLs', diag.manualSitemapURLs || 0,   'user-supplied sitemap URLs merged')}
          {statRow('Selected candidates', diag.selectedCandidates,       'after domain filter + cap')}
          {statRow('Pages fetched',     diag.fetchedPages,               'successfully downloaded')}
          {statRow('Pages skipped',     diag.skippedPages,               'fetch error or noindex/canonical')}
          {statRow('Thin-content pages', diag.thinContentPages || 0,     'used pseudo-paragraph fallback')}
          {statRow('Scored pairs',      diag.scoredPairs,                'source pages scored against target')}
          {statRow('Opps (strict)',      diag.oppsBeforeFilter,           'verbatim anchor found, above minScore')}
          {statRow('Opps (semantic)',    diag.semanticOpps || 0,          'semantic fill-ins added')}
          {statRow('Total opportunities', diag.oppsAfterFilter,           'final merged result')}
          {statRow('Highest score',     diag.highestScore || 0,          '/10')}
          {statRow('Average score',     diag.averageScore || 0,          '/10')}
        </div>
      </div>

      {/* Zero-opp reason */}
      {diag.zeroOppReason && (
        <div style={{padding:'12px 16px',background:C.orangeL,border:`1px solid ${C.orange}`,borderRadius:8,fontSize:12,color:C.orange}}>
          <strong>⚠ Why no opportunities were found:</strong><br/>
          <span style={{color:C.g700,marginTop:4,display:'block'}}>{diag.zeroOppReason}</span>
        </div>
      )}

      {/* Child sitemaps */}
      {diag.sitemapChildDetails?.length > 0 && (
        <div>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:10}}>
            Child Sitemaps ({diag.sitemapChildDetails.length})
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {diag.sitemapChildDetails.map((sm,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',background:C.g50,border:`1px solid ${C.g200}`,borderRadius:7,fontSize:11,gap:10}}>
                <span style={{color:C.brand,fontFamily:'monospace',wordBreak:'break-all',flex:1}}>{sm.url}</span>
                <span style={badge(sm.count > 0 ? C.greenL : C.g100, sm.count > 0 ? C.green : C.g500)}>{sm.count ?? 0} URLs</span>
                {sm.error && <span style={badge(C.redL,C.red)}>error</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Failed sitemap fetches */}
      {diag.sitemapFailedFetches?.length > 0 && (
        <div>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:10}}>
            Failed Sitemap Fetches ({diag.sitemapFailedFetches.length})
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:5}}>
            {diag.sitemapFailedFetches.map((f,i)=>(
              <div key={i} style={{padding:'7px 12px',background:C.redL,border:`1px solid #fca5a5`,borderRadius:6,fontSize:11,color:C.red}}>
                {f.url || f} {f.error ? `— ${f.error}` : ''}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top-20 semantic scores */}
      {diag.top20Scores?.length > 0 && (
        <div>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:10}}>
            Top 20 Closest Pages (semantic ranking)
          </div>
          <div style={{overflowX:'auto',border:`1px solid ${C.g200}`,borderRadius:8}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
              <thead>
                <tr style={{background:C.g50}}>
                  {['#','URL','Score','Shared KWs','Cos Sim','Anchor Found','Already Links'].map(h=>(
                    <th key={h} style={{padding:'8px 10px',textAlign:'left',fontSize:9,fontWeight:700,textTransform:'uppercase',letterSpacing:'.5px',color:C.g500,borderBottom:`1px solid ${C.g200}`,whiteSpace:'nowrap'}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {diag.top20Scores.map((s,i)=>(
                  <tr key={i} style={{borderBottom:`1px solid ${C.g100}`,background:i%2===0?'#fff':C.g50}}>
                    <td style={{padding:'7px 10px',fontWeight:700,color:C.g400,width:28}}>{i+1}</td>
                    <td style={{padding:'7px 10px',maxWidth:260}}>
                      <a href={s.url} target="_blank" rel="noreferrer" style={{color:C.brand,fontWeight:600,display:'block',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{pathOf(s.url)}</a>
                      <div style={{fontSize:10,color:C.g400,marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.title}</div>
                    </td>
                    <td style={{padding:'7px 10px'}}>
                      <span style={{fontWeight:800,fontSize:13,color:scoreColor(s.score)}}>{s.score}</span>
                      <span style={{fontSize:9,color:C.g400}}>/10</span>
                    </td>
                    <td style={{padding:'7px 10px',fontWeight:700,color:C.g700}}>{s.sharedKws}</td>
                    <td style={{padding:'7px 10px',fontFamily:'monospace',color:C.g600}}>{(s.cosSim*100).toFixed(1)}%</td>
                    <td style={{padding:'7px 10px'}}>
                      {s.hasAnchor
                        ? <span style={badge(C.greenL,C.green)}>✓ {s.anchor ? `"${s.anchor.slice(0,20)}"` : 'yes'}</span>
                        : <span style={badge(C.g100,C.g400)}>none</span>}
                    </td>
                    <td style={{padding:'7px 10px'}}>
                      {s.alreadyLinks
                        ? <span style={badge(C.tealL,C.teal)}>linked</span>
                        : <span style={badge(C.brandL,C.brand)}>opportunity</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sitemap discovery log */}
      {diag.sitemapLog?.length > 0 && (
        <div>
          <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400,marginBottom:10}}>Sitemap Discovery Log</div>
          <div style={{background:C.g900,borderRadius:8,padding:'11px 15px',fontFamily:'monospace',fontSize:10,lineHeight:1.9,maxHeight:200,overflowY:'auto'}}>
            {diag.sitemapLog.map((line,i)=><div key={i} style={{color:'#a3e635'}}>{line}</div>)}
          </div>
        </div>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  FETCH LOG
// ─────────────────────────────────────────────────────────────────────────────
function FetchLog({ log }) {
  if (!log?.length) return null;
  return (
    <div style={{background:C.g900,borderRadius:8,padding:'11px 15px',fontFamily:'monospace',fontSize:11,lineHeight:1.8,maxHeight:170,overflowY:'auto'}}>
      {log.map((e,i)=><div key={i} style={{color:e.success?'#34d399':'#f87171'}}>{e.message}</div>)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function Home() {
  // ── Mode ──────────────────────────────────────────────────────────────────
  const [mode,      setMode]      = useState('multi');  // 'multi' | 'target'

  // ── Multi-URL mode state ──────────────────────────────────────────────────
  const [urlText,   setUrlText]   = useState('');

  // ── Target Page mode state ────────────────────────────────────────────────
  const [targetURL,          setTargetURL]          = useState('');
  const [candidateURLs,      setCandidateURLs]      = useState('');  // newline-separated
  const [manualSitemapURLs,  setManualSitemapURLs]  = useState('');  // v3.1: manual sitemap URLs
  const [autoDiscover,       setAutoDiscover]       = useState(true); // v3.1: auto-discover checkbox
  const [sitemapLoading,     setSitemapLoading]     = useState(false);
  const [sitemapMsg,         setSitemapMsg]         = useState('');
  const [targetPage,         setTargetPage]         = useState(null);
  const [diagnostics,        setDiagnostics]        = useState(null); // v3.1: API diagnostics

  // ── Shared state ──────────────────────────────────────────────────────────
  const [settings,  setSettings]  = useState(DEFAULT_SETTINGS);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [fetchLog,  setFetchLog]  = useState([]);
  const [pages,     setPages]     = useState([]);
  const [opps,      setOpps]      = useState([]);
  const [skipped,   setSkipped]   = useState([]);
  const [summary,   setSummary]   = useState(null);
  const [tab,       setTab]       = useState('opps');

  // Filters
  const [fSearch,     setFSearch]     = useState('');
  const [fType,       setFType]       = useState('');
  const [fScore,      setFScore]      = useState('');
  const [fPriority,   setFPriority]   = useState('');
  const [fSource,     setFSource]     = useState('');
  const [fTarget,     setFTarget]     = useState('');
  const [fPos,        setFPos]        = useState('');
  const [fAnchorType, setFAnchorType] = useState('');  // v3: anchor type filter
  const [fOrphanOnly, setFOrphanOnly] = useState(false); // v3: orphan target only

  const updateSetting = useCallback((k, v) => setSettings(s => ({...s,[k]:v})), []);

  const clearResults = () => { setFetchLog([]); setPages([]); setOpps([]); setSkipped([]); setSummary(null); setTargetPage(null); setDiagnostics(null); setError(''); };

  // ── Sitemap auto-discovery (Target Page Mode) ─────────────────────────────
  const discoverFromSitemap = async () => {
    if (!targetURL.startsWith('http')) { setSitemapMsg('Enter a valid target URL first.'); return; }
    setSitemapLoading(true); setSitemapMsg('');
    const manualSmaps = manualSitemapURLs.split('\n').map(s=>s.trim()).filter(s=>s.startsWith('http'));
    try {
      const res  = await fetch('/api/crawl-sitemap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetURL, maxUrls: settings.maxSitemapURLs || 300, manualSitemapURLs: manualSmaps }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setSitemapMsg(`Sitemap error: ${data.error || 'Unknown error'}`);
      } else {
        setCandidateURLs(data.urls.join('\n'));
        const childInfo = data.childCount > 1 ? ` from ${data.childCount} child sitemaps` : data.sitemapSource ? ` from ${data.sitemapSource}` : '';
        setSitemapMsg(`✓ Found ${data.count} candidate page${data.count !== 1 ? 's' : ''}${childInfo}`);
      }
    } catch(e) {
      setSitemapMsg(`Network error: ${e.message}`);
    }
    setSitemapLoading(false);
  };

  // ── Run Multi-URL Analysis ─────────────────────────────────────────────────
  const analyzeMulti = async () => {
    let urls = urlText.split('\n').map(s=>s.trim()).filter(s=>s.startsWith('http'));
    if (urls.length === 0) { setError('Please enter at least one URL.'); return; }

    if (settings.excludePatterns) {
      const excPats = settings.excludePatterns.split('\n').map(p=>p.trim()).filter(Boolean);
      urls = urls.filter(u => !excPats.some(p => u.includes(p)));
    }
    if (settings.includePatterns) {
      const incPats = settings.includePatterns.split('\n').map(p=>p.trim()).filter(Boolean);
      if (incPats.length) urls = urls.filter(u => incPats.some(p => u.includes(p)));
    }

    if (urls.length < 2) {
      setError('After applying filters, fewer than 2 URLs remain. Adjust URL patterns in Settings.');
      return;
    }

    setLoading(true); setError(''); clearResults(); setTab('opps');
    const apiSettings = {
      ...settings,
      customTopics: settings.customTopics ? settings.customTopics.split('\n').map(t=>t.trim()).filter(Boolean) : [],
    };
    try {
      const res = await fetch('/api/analyze-links', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ urls: urls.slice(0, settings.maxPages), settings: apiSettings }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Server error.'); setLoading(false); return; }
      setFetchLog(data.fetchLog || []); setPages(data.pages || []);
      setOpps(data.opportunities || []); setSkipped(data.skipped || []);
      setSummary(data.summary || null); setTab('opps');
    } catch(e) { setError('Network error: ' + e.message); }
    setLoading(false);
  };

  // ── Run Target Page Analysis ───────────────────────────────────────────────
  const analyzeTarget = async () => {
    if (!targetURL.startsWith('http')) { setError('Enter a valid target URL.'); return; }
    const cands        = candidateURLs.split('\n').map(s=>s.trim()).filter(s=>s.startsWith('http'));
    const manualSmaps  = manualSitemapURLs.split('\n').map(s=>s.trim()).filter(s=>s.startsWith('http'));

    setLoading(true); setError(''); clearResults(); setTab('opps');
    const apiSettings = {
      ...settings,
      customTopics: settings.customTopics ? settings.customTopics.split('\n').map(t=>t.trim()).filter(Boolean) : [],
    };
    try {
      const res = await fetch('/api/target-page', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          targetURL,
          candidateURLs:    cands,
          manualSitemapURLs: manualSmaps,
          settings:         apiSettings,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Server error.');
        if (data.diagnostics) setDiagnostics(data.diagnostics);
        setLoading(false); return;
      }
      setTargetPage(data.targetPage || null);
      setFetchLog(data.sourceFetchLog || []); setPages(data.pages || []);
      setOpps(data.opportunities || []); setSkipped(data.skipped || []);
      setSummary(data.summary || null); setDiagnostics(data.diagnostics || null);
      setTab('opps');
    } catch(e) { setError('Network error: ' + e.message); }
    setLoading(false);
  };

  const analyze = mode === 'target' ? analyzeTarget : analyzeMulti;

  // ── Filter Opportunities ──────────────────────────────────────────────────
  const filteredOpps = useMemo(() => opps.filter(o => {
    if (fType       && o.linkType          !== fType)       return false;
    if (fPriority   && o.priority          !== fPriority)   return false;
    if (fSource     && o.sourceURL         !== fSource)     return false;
    if (fTarget     && o.targetURL         !== fTarget)     return false;
    if (fPos        && o.paraPositionLabel !== fPos)        return false;
    if (fAnchorType && o.anchorType        !== fAnchorType) return false;
    if (fOrphanOnly) {
      // Find target page in pages list
      const tgt = pages.find(p => p.url === o.targetURL);
      if (!tgt || !tgt.isOrphan) return false;
    }
    if (fScore === 'high'   && o.score < 8)              return false;  // v3: ≥8
    if (fScore === 'medium' && (o.score < 6 || o.score >= 8)) return false; // v3: 6–7.9
    if (fScore === 'low'    && o.score >= 6)             return false;  // v3: <6
    if (fSearch) {
      const q = fSearch.toLowerCase();
      return o.sourceURL.toLowerCase().includes(q) ||
             o.targetURL.toLowerCase().includes(q) ||
             o.suggestedAnchor.toLowerCase().includes(q) ||
             (o.anchorContext||'').toLowerCase().includes(q) ||
             o.sharedKeywords.some(k=>k.includes(q));
    }
    return true;
  }), [opps, pages, fType, fPriority, fSource, fTarget, fScore, fSearch, fPos, fAnchorType, fOrphanOnly]);

  // ── Export CSV ────────────────────────────────────────────────────────────
  const exportCSV = () => {
    const cols = [
      'Source URL','Target URL','Anchor Text','Anchor Type','Anchor Context',
      'Paragraph Position','Existing Paragraph','Updated Paragraph',
      'Score','Priority','Reason','Body Content Proof',
      'Shared Keywords','Page Type','Link Type','Confidence',
      'Target Inbound Links','Is Orphan Target',
    ];
    const rows = opps.map(o => {
      const tgt = pages.find(p => p.url === o.targetURL);
      return [
        o.sourceURL, o.targetURL, o.suggestedAnchor,
        o.anchorType || '',
        o.anchorContext || '',
        o.paraPositionLabel || '',
        o.existingParagraph,
        o.updatedParagraph.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1'),
        `${o.score}/10`, o.priority, o.reason, o.bodyContentReason,
        o.sharedKeywords.join('; '), o.sourcePageType, o.linkType, `${o.confidence}%`,
        tgt?.inboundCount ?? '',
        tgt?.isOrphan ? 'Yes' : 'No',
      ];
    });
    const csv = [cols,...rows].map(r=>r.map(c=>`"${String(c||'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download = 'internal-linking-opportunities.csv';
    a.click();
  };

  const hasResults     = pages.length > 0 || fetchLog.length > 0;
  const allLinkTypes   = [...new Set(opps.map(o=>o.linkType))];
  const allSources     = [...new Set(opps.map(o=>o.sourceURL))];
  const allTargets     = [...new Set(opps.map(o=>o.targetURL))];
  const allAnchorTypes = [...new Set(opps.map(o=>o.anchorType).filter(Boolean))];
  const failures       = fetchLog.filter(l => !l.success);
  const urlCount       = urlText.split('\n').filter(s=>s.trim().startsWith('http')).length;
  const hasFilters     = fType||fPriority||fSource||fTarget||fScore||fSearch||fPos||fAnchorType||fOrphanOnly;

  const TABS = [
    { id:'opps',     label:'Opportunities',     count: opps.length },
    { id:'pages',    label:'Pages Analyzed',    count: pages.length },
    { id:'orphan',   label:'Orphan Pages',       count: summary?.orphanPages?.length||0 },
    { id:'failures', label:'Failures & Skipped', count: failures.length + skipped.length },
    { id:'summary',  label:'Summary Report' },
    ...(mode === 'target' ? [{ id:'diag', label:'🔬 Diagnostics' }] : []),
    { id:'settings', label:'⚙ Settings' },
  ];

  const selStyle = { ...input, cursor:'pointer' };

  return (
    <>
      <Head>
        <title>Internal Linking Opportunity Finder</title>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
        <style>{`body{margin:0;} *{box-sizing:border-box;} a{text-decoration:none;}`}</style>
      </Head>
      <div style={{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',background:C.g50,minHeight:'100vh',color:C.g800}}>

        {/* HEADER */}
        <header style={{background:'#fff',borderBottom:`1px solid ${C.g200}`,padding:'0 2rem',display:'flex',alignItems:'center',height:56,gap:12,position:'sticky',top:0,zIndex:100,boxShadow:'0 1px 4px rgba(0,0,0,.06)'}}>
          <div style={{width:28,height:28,borderRadius:7,background:C.brand,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontWeight:800,fontSize:12}}>IL</div>
          <span style={{fontSize:14,fontWeight:700,color:C.g900}}>Internal Linking Opportunity Finder</span>
          <span style={{fontSize:11,color:C.g400,marginLeft:2}}>v3 · Any website · Body content only</span>
        </header>

        <main style={{maxWidth:1160,margin:'0 auto',padding:'1.6rem 1.5rem'}}>

          {/* MODE SELECTOR */}
          <div style={{...card,padding:'0.9rem 1.2rem'}}>
            <div style={{display:'flex',gap:4,background:C.g100,borderRadius:8,padding:4,width:'fit-content'}}>
              {[
                { id:'multi',  label:'🔀 Multi-URL Mode',    hint:'Analyze a set of pages — find all linking opportunities between them' },
                { id:'target', label:'🎯 Target Page Mode',  hint:'Find source pages that should link TO one specific target page' },
              ].map(m => (
                <button key={m.id}
                  onClick={() => { setMode(m.id); clearResults(); setError(''); }}
                  title={m.hint}
                  style={{padding:'6px 18px',borderRadius:6,fontSize:12,fontWeight:700,border:'none',cursor:'pointer',background:mode===m.id?'#fff':C.g100,color:mode===m.id?C.brand:C.g500,boxShadow:mode===m.id?'0 1px 3px rgba(0,0,0,.1)':'none',transition:'all .15s'}}
                >{m.label}</button>
              ))}
            </div>
            <div style={{fontSize:11,color:C.g400,marginTop:8}}>
              {mode==='multi'
                ? 'Enter URLs from the same domain — the tool finds all contextual linking opportunities between them.'
                : 'Enter one target URL — the tool discovers candidate source pages via sitemap, then finds which pages should link TO your target.'}
            </div>
          </div>

          {/* INPUT CARD */}
          <div style={card}>
            {mode === 'multi' ? (
              <>
                <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.7px',color:C.g400,marginBottom:10}}>Enter Page URLs to Analyze (same domain, one per line)</div>
                <textarea
                  value={urlText}
                  onChange={e=>setUrlText(e.target.value)}
                  placeholder={"Paste URLs — any website, one per line:\n\nhttps://example.com/blog/topic-a/\nhttps://example.com/blog/topic-b/\nhttps://example.com/services/\nhttps://example.com/product/"}
                  style={{width:'100%',minHeight:120,padding:12,border:`1.5px solid ${C.g300}`,borderRadius:8,fontSize:12,fontFamily:'"SF Mono","Fira Code",monospace',resize:'vertical',outline:'none',lineHeight:1.6,color:C.g700}}
                  onFocus={e=>e.target.style.borderColor=C.brand}
                  onBlur={e=>e.target.style.borderColor=C.g300}
                />
              </>
            ) : (
              <>
                {/* Target URL */}
                <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.7px',color:C.g400,marginBottom:8}}>Target Page URL — find pages that should link to this</div>
                <input
                  type="url"
                  value={targetURL}
                  onChange={e=>setTargetURL(e.target.value)}
                  placeholder="https://example.com/your-target-page/"
                  style={{...input,width:'100%',fontSize:12,padding:'9px 12px',marginBottom:14}}
                  onFocus={e=>e.target.style.borderColor=C.brand}
                  onBlur={e=>e.target.style.borderColor=C.g300}
                />

                {/* Sitemap Sources (v3.1) */}
                <div style={{border:`1.5px solid ${C.g200}`,borderRadius:9,padding:'12px 14px',marginBottom:12,background:C.g50}}>
                  <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.7px',color:C.g400,marginBottom:10}}>🗺 Sitemap Sources</div>
                  <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10,flexWrap:'wrap'}}>
                    <label style={{display:'flex',alignItems:'center',gap:6,fontSize:12,fontWeight:600,color:C.g700,cursor:'pointer'}}>
                      <input type="checkbox" checked={autoDiscover} onChange={e=>setAutoDiscover(e.target.checked)}/>
                      Auto-discover sitemap from robots.txt
                    </label>
                    {autoDiscover && (
                      <button
                        style={{...btn(false,true),opacity:sitemapLoading?0.7:1}}
                        onClick={discoverFromSitemap}
                        disabled={sitemapLoading}
                      >
                        {sitemapLoading ? '⏳ Discovering…' : '▶ Discover Now'}
                      </button>
                    )}
                    {sitemapMsg && <span style={{fontSize:11,color:sitemapMsg.startsWith('✓')?C.green:C.red}}>{sitemapMsg}</span>}
                  </div>
                  <div style={{fontSize:10,fontWeight:600,color:C.g500,marginBottom:5}}>
                    Manual sitemap URLs (optional) — paste .xml sitemap URLs, one per line, merged with auto-discovered:
                  </div>
                  <textarea
                    value={manualSitemapURLs}
                    onChange={e=>setManualSitemapURLs(e.target.value)}
                    placeholder={"https://example.com/sitemap.xml\nhttps://example.com/post-sitemap.xml\nhttps://example.com/page-sitemap.xml"}
                    style={{width:'100%',minHeight:60,padding:10,border:`1.5px solid ${C.g300}`,borderRadius:7,fontSize:11,fontFamily:'"SF Mono","Fira Code",monospace',resize:'vertical',outline:'none',lineHeight:1.5,color:C.g700,background:'#fff'}}
                    onFocus={e=>e.target.style.borderColor=C.brand}
                    onBlur={e=>e.target.style.borderColor=C.g300}
                  />
                </div>

                {/* Candidate source pages */}
                <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.7px',color:C.g400,marginBottom:6}}>
                  Candidate Source Pages — auto-populated by sitemap discovery, or paste manually (one per line)
                </div>
                <textarea
                  value={candidateURLs}
                  onChange={e=>setCandidateURLs(e.target.value)}
                  placeholder={"Leave empty to use sitemap auto-discovery, or paste candidate source URLs:\n\nhttps://example.com/blog/related-topic/\nhttps://example.com/blog/another-article/"}
                  style={{width:'100%',minHeight:90,padding:12,border:`1.5px solid ${C.g300}`,borderRadius:8,fontSize:12,fontFamily:'"SF Mono","Fira Code",monospace',resize:'vertical',outline:'none',lineHeight:1.6,color:C.g700}}
                  onFocus={e=>e.target.style.borderColor=C.brand}
                  onBlur={e=>e.target.style.borderColor=C.g300}
                />
                {/* Candidate count + Vercel free-tier warning */}
                {(() => {
                  const count = candidateURLs.split('\n').filter(s=>s.trim().startsWith('http')).length;
                  if (count === 0) return null;
                  const isOver = count > 60;
                  return (
                    <div style={{marginTop:7,padding:'8px 12px',background:isOver?C.orangeL:C.greenL,border:`1px solid ${isOver?C.orange:C.green}`,borderRadius:7,fontSize:12,color:C.g700,display:'flex',alignItems:'flex-start',gap:8}}>
                      <span>{isOver ? '⚠' : '✓'}</span>
                      <span>
                        <strong>{count} candidate page{count!==1?'s':''}</strong>
                        {isOver
                          ? <> — <span style={{color:C.orange,fontWeight:700}}>above the 60-page safe limit for Vercel free tier.</span> Analyses this large may timeout (10s limit). Either reduce to ≤60, or upgrade to <a href="https://vercel.com/pricing" target="_blank" rel="noreferrer" style={{color:C.brand}}>Vercel Pro</a> for a 60s limit.</>
                          : <> ready to analyze — within the Vercel free-tier safe limit (≤60).</>}
                      </span>
                    </div>
                  );
                })()}

                {targetPage && (
                  <div style={{marginTop:8,padding:'8px 12px',background:C.greenL,border:`1px solid ${C.green}`,borderRadius:7,fontSize:12,color:C.g700}}>
                    🎯 Target: <strong>{targetPage.title}</strong> · {targetPage.pageType} · {targetPage.paragraphCount} paragraphs
                  </div>
                )}
              </>
            )}

            <div style={{display:'flex',alignItems:'center',gap:10,marginTop:11,flexWrap:'wrap'}}>
              <button
                style={{...btn(true),opacity:loading?0.7:1,cursor:loading?'not-allowed':'pointer'}}
                onClick={analyze}
                disabled={loading}
              >
                {loading ? '⏳  Analyzing pages…' : mode==='target' ? '🎯  Find Inbound Opportunities' : '🔍  Find Linking Opportunities'}
              </button>
              <button style={btn(false)} onClick={()=>{setUrlText('');setCandidateURLs('');setManualSitemapURLs('');setSitemapMsg('');clearResults();}}>Clear</button>
              {mode === 'multi' && (
                <span style={{background:C.g100,color:C.g500,fontSize:11,padding:'4px 11px',borderRadius:20}}>{urlCount} URL{urlCount!==1?'s':''}</span>
              )}
            </div>
            {error && (
              <div style={{marginTop:11,background:C.redL,border:`1px solid #fca5a5`,borderRadius:7,padding:'9px 13px',color:C.red,fontSize:12,fontWeight:600}}>✗ {error}</div>
            )}
          </div>

          {/* FETCH LOG + DISCOVERY STATS */}
          {fetchLog.length > 0 && (
            <div style={{...card,padding:'1rem 1.4rem'}}>
              <div style={{fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:'.7px',color:C.g400,marginBottom:6}}>
                Fetch Log — {fetchLog.filter(l=>l.success).length}/{fetchLog.length} pages fetched successfully
              </div>
              {/* v3.1: Discovery stats for target mode */}
              {mode==='target' && diagnostics && (
                <div style={{display:'flex',gap:12,flexWrap:'wrap',marginBottom:9}}>
                  {diagnostics.discoveredURLs > 0 && (
                    <span style={{...badge(C.brandL,C.brand),fontSize:11,padding:'4px 10px'}}>
                      🗺 {diagnostics.discoveredURLs} URLs discovered from {diagnostics.sitemapChildDetails?.length || 1} sitemap{diagnostics.sitemapChildDetails?.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {diagnostics.selectedCandidates > 0 && (
                    <span style={{...badge(C.greenL,C.green),fontSize:11,padding:'4px 10px'}}>
                      ✓ Analyzing {diagnostics.selectedCandidates} of {diagnostics.discoveredURLs || diagnostics.selectedCandidates} candidate pages
                    </span>
                  )}
                  {diagnostics.thinContentPages > 0 && (
                    <span style={{...badge(C.orangeL,C.orange),fontSize:11,padding:'4px 10px'}}>
                      ⚠ {diagnostics.thinContentPages} thin-content page{diagnostics.thinContentPages !== 1 ? 's' : ''} (scored from title/meta/headings)
                    </span>
                  )}
                </div>
              )}
              <FetchLog log={fetchLog}/>
            </div>
          )}

          {/* RESULTS */}
          {hasResults && (
            <>
              {/* STAT CARDS */}
              <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(145px,1fr))',gap:'0.8rem',marginBottom:'1.1rem'}}>
                {[
                  ['Total Opportunities', opps.length,                          'linking suggestions',   C.brand],
                  ['High Priority',       opps.filter(o=>o.score>=8).length,    'score ≥ 8/10',          C.green],
                  ['Pages Analyzed',      pages.length,                         'successfully fetched',  C.orange],
                  ['Fetch Failures',      failures.length,                      'check failures tab',    C.red],
                  ['Orphan Pages',        summary?.orphanPages?.length||0,      'no inbound links',      C.purple],
                ].map(([label,val,sub,col])=>(
                  <div key={label} style={{background:'#fff',border:`1px solid ${C.g200}`,borderRadius:10,padding:'1rem',borderTop:`3px solid ${col}`}}>
                    <div style={{fontSize:9,fontWeight:700,textTransform:'uppercase',letterSpacing:'.6px',color:C.g400}}>{label}</div>
                    <div style={{fontSize:26,fontWeight:800,color:C.g900,margin:'3px 0'}}>{val}</div>
                    <div style={{fontSize:10,color:C.g500}}>{sub}</div>
                  </div>
                ))}
              </div>

              {/* MAIN CARD */}
              <div style={{...card,padding:'1.2rem'}}>
                {/* Tab bar + export */}
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'1rem',flexWrap:'wrap',gap:10}}>
                  <div style={{display:'flex',borderBottom:`1px solid ${C.g200}`,gap:2,flexWrap:'wrap'}}>
                    {TABS.map(t=>(
                      <button key={t.id} style={tabBtn(tab===t.id)} onClick={()=>setTab(t.id)}>
                        {t.label}
                        {t.count!=null && <span style={{...badge(tab===t.id?C.brandL:C.g100, tab===t.id?C.brand:C.g600),marginLeft:4}}>{t.count}</span>}
                      </button>
                    ))}
                  </div>
                  {tab!=='settings' && <button style={{...btn(false,true)}} onClick={exportCSV}>⬇ Export CSV</button>}
                </div>

                {/* ── OPPORTUNITIES TAB ── */}
                {tab==='opps' && (
                  <>
                    {/* Zero-opp warning (v3.1) */}
                    {opps.length === 0 && diagnostics?.zeroOppReason && (
                      <div style={{marginBottom:14,padding:'14px 18px',background:C.orangeL,border:`1.5px solid ${C.orange}`,borderRadius:9,fontSize:12}}>
                        <div style={{fontWeight:800,color:C.orange,marginBottom:4}}>⚠ No opportunities found — here's why:</div>
                        <div style={{color:C.g700,lineHeight:1.6}}>{diagnostics.zeroOppReason}</div>
                        {diagnostics.top20Scores?.length > 0 && (
                          <div style={{marginTop:8,color:C.g600}}>
                            Highest composite score: <strong>{Math.max(...diagnostics.top20Scores.map(s=>s.score)).toFixed(1)}/10</strong> ·
                            {' '}Switch to the <strong>🔬 Diagnostics</strong> tab to see the top-20 closest pages ranked by semantic similarity.
                          </div>
                        )}
                      </div>
                    )}
                    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:'1rem',alignItems:'center'}}>
                      <input
                        value={fSearch}
                        onChange={e=>setFSearch(e.target.value)}
                        placeholder="🔍  Search URLs, anchors, context, keywords…"
                        style={{...input,minWidth:220}}
                      />
                      <select value={fType}       onChange={e=>setFType(e.target.value)}       style={selStyle}><option value="">All Types</option>{allLinkTypes.map(t=><option key={t}>{t}</option>)}</select>
                      <select value={fPriority}   onChange={e=>setFPriority(e.target.value)}   style={selStyle}><option value="">All Priorities</option><option>High</option><option>Medium</option><option>Low</option></select>
                      <select value={fScore}      onChange={e=>setFScore(e.target.value)}      style={selStyle}><option value="">All Scores</option><option value="high">High (8-10)</option><option value="medium">Medium (6-7)</option><option value="low">Low (&lt;6)</option></select>
                      <select value={fAnchorType} onChange={e=>setFAnchorType(e.target.value)} style={selStyle}><option value="">All Anchor Types</option>{allAnchorTypes.map(t=><option key={t}>{t}</option>)}</select>
                      <select value={fPos}        onChange={e=>setFPos(e.target.value)}        style={selStyle}><option value="">All Positions</option><option>Early</option><option>Middle</option><option>Late</option></select>
                      <select value={fSource}     onChange={e=>setFSource(e.target.value)}     style={selStyle}><option value="">All Sources</option>{allSources.map(u=><option key={u} value={u}>{pathOf(u)}</option>)}</select>
                      <select value={fTarget}     onChange={e=>setFTarget(e.target.value)}     style={selStyle}><option value="">All Targets</option>{allTargets.map(u=><option key={u} value={u}>{pathOf(u)}</option>)}</select>
                      <label style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:C.g600,cursor:'pointer',whiteSpace:'nowrap'}}>
                        <input type="checkbox" checked={fOrphanOnly} onChange={e=>setFOrphanOnly(e.target.checked)}/> Orphan targets only
                      </label>
                      {hasFilters && <button style={{...btn(false,true)}} onClick={()=>{setFType('');setFPriority('');setFSource('');setFTarget('');setFScore('');setFSearch('');setFPos('');setFAnchorType('');setFOrphanOnly(false);}}>✕ Clear</button>}
                    </div>
                    {filteredOpps.length === 0
                      ? <div style={{textAlign:'center',padding:'2.5rem',color:C.g400,fontSize:13}}>
                          {opps.length===0
                            ? 'No opportunities found. Check the Fetch Log for errors, or try adding more pages with overlapping content.'
                            : 'No opportunities match the current filters.'}
                        </div>
                      : filteredOpps.map((o,i)=><OppCard key={i} opp={o} idx={i}/>)
                    }
                  </>
                )}

                {tab==='pages'    && <PagesTable    pages={pages}/>}
                {tab==='orphan'   && <OrphanTab     summary={summary}/>}
                {tab==='failures' && <FailuresTab   fetchLog={fetchLog} skipped={skipped}/>}
                {tab==='summary'  && <SummaryTab    summary={summary} opps={opps}/>}
                {tab==='diag'     && <DiagnosticsTab diag={diagnostics}/>}
                {tab==='settings' && <SettingsTab   settings={settings} onChange={updateSetting}/>}
              </div>
            </>
          )}

          {!hasResults && !loading && (
            <div style={{textAlign:'center',padding:'3.5rem',color:C.g400}}>
              <div style={{fontSize:40,marginBottom:12}}>🔗</div>
              <div style={{fontSize:14,fontWeight:600,color:C.g600,marginBottom:6}}>Find contextual internal linking opportunities</div>
              <div style={{fontSize:12}}>
                {mode==='target'
                  ? 'Enter a target URL above — the tool will discover which pages should link to it.'
                  : 'Enter URLs from any website — suggestions come from main body content only, never from author bios, footers, or sidebars.'}
              </div>
            </div>
          )}

        </main>
      </div>
    </>
  );
}
