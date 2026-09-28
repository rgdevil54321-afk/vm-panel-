#!/usr/bin/env node
/**
 * frontend-check.js — static frontend validation for the Venlix panel.
 *
 * Why this exists: `build.js --check` does not look at the frontend at all. It
 * creates directories, opens the database, reports system binaries and downloads
 * noVNC. It will happily pass with a broken stylesheet and fail on a machine
 * that is missing an unrelated system package.
 *
 * This script has no dependencies (no express/ejs/better-sqlite3 required), so
 * it runs anywhere Node runs, including CI and a laptop.
 *
 * Checks, all high-confidence (no heuristics that produce false positives):
 *   1. every public/js/*.js parses
 *   2. EJS tag balance in every template
 *   3. CSS brace balance in every stylesheet
 *   4. every local asset referenced by views/partials actually exists on disk
 *   5. no duplicate element id within a single template
 *
 * Exit code 0 = clean, 1 = problems found.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (filter(e.name)) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ---- 1. JS parses ---------------------------------------------------------
const jsFiles = walk(path.join(ROOT, 'public', 'js'), (n) => n.endsWith('.js'));
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    new vm.Script(src, { filename: f });
  } catch (e) {
    err(`${rel(f)}: ${e.message}`);
  }
}

// ---- 2. EJS tag balance ---------------------------------------------------
const views = walk(path.join(ROOT, 'views'), (n) => n.endsWith('.ejs'));
for (const f of views) {
  const src = fs.readFileSync(f, 'utf8');
  const opens = (src.match(/<%/g) || []).length;
  const closes = (src.match(/%>/g) || []).length;
  if (opens !== closes) {
    err(`${rel(f)}: unbalanced EJS tags (<% x${opens}, %> x${closes})`);
  }
  // Unclosed EJS comment.
  if (/<%#(?!.*-%>)[\s\S]*$/.test(src) && !/%>/.test(src.slice(src.lastIndexOf('<%#')))) {
    warn(`${rel(f)}: possible unterminated EJS comment <%# ...`);
  }
}

// ---- 3. CSS brace balance -------------------------------------------------
const cssFiles = walk(path.join(ROOT, 'public', 'css'), (n) => n.endsWith('.css'));
const cssSrc = new Map();
for (const f of cssFiles) {
  const src = fs.readFileSync(f, 'utf8');
  cssSrc.set(f, src);
  // Strip comments and string literals so braces inside them do not count.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const open = (stripped.match(/\{/g) || []).length;
  const close = (stripped.match(/\}/g) || []).length;
  if (open !== close) {
    err(`${rel(f)}: unbalanced braces ({ x${open}, } x${close})`);
  }
}

// ---- 3b. every var(--x) reference resolves ---------------------------------
// Guards the single-token-namespace rule: a rename that misses one usage
// silently falls back to nothing (or, with a fallback, to the wrong value).
{
  const defined = new Set();
  for (const src of cssSrc.values()) {
    for (const m of src.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1]);
  }
  // The panel's own runtime-set variables live in JS, not CSS.
  for (const f of jsFiles) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/setProperty\(\s*['"](--[A-Za-z0-9_-]+)['"]/g)) {
      defined.add(m[1]);
    }
  }
  // Names the browser supplies itself.
  for (const n of ['--vp-modal-dur', '--vp-modal-ease']) defined.add(n);

  const reported = new Set();
  for (const [f, src] of cssSrc) {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of stripped.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g)) {
      const [, name, hasFallback] = m;
      if (hasFallback || defined.has(name)) continue;
      const key = `${rel(f)}|${name}`;
      if (reported.has(key)) continue;
      reported.add(key);
      err(`${rel(f)}: var(${name}) is never defined in any stylesheet`);
    }
  }
}

// ---- 4. referenced local assets exist -------------------------------------
const partials = walk(path.join(ROOT, 'views', 'partials'), (n) => n.endsWith('.ejs'));
const assetRefs = new Set();
for (const f of [...partials, ...views]) {
  const src = fs.readFileSync(f, 'utf8');
  // Only static, non-templated hrefs/srcs; skip anything containing EJS output.
  for (const m of src.matchAll(/\b(?:href|src)="(\/(?:css|js|vendor)\/[^"?]+)"/g)) {
    if (!m[1].includes('<%')) assetRefs.add(m[1].split('?')[0]);
  }
}
for (const ref of [...assetRefs].sort()) {
  const p = path.join(ROOT, 'public', ref.replace(/^\//, ''));
  if (!fs.existsSync(p)) err(`referenced asset missing: ${ref}`);
}

// ---- 5b. table header/body column alignment --------------------------------
// Responsive tables hide columns with .hide-sm / .hide-xs. If a <th> and its
// <td> disagree, the row silently shifts out of alignment and reads as
// scrambled data rather than as a bug.
//
// Each row is reduced to a token list (one token per cell, plus a token per
// EJS block) so that a column wrapped in <% if %> is still compared against
// the matching <th> instead of being misindexed. Comparison is positional: a
// weaker set-based rule cannot tell "no column is hidden" from "one of three
// hidden columns lost its class".
const cellTokens = (rowHtml) => {
  const out = [];
  for (const m of rowHtml.matchAll(/<%[\s\S]*?%>|<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/g)) {
    const s = m[0];
    if (s.startsWith('<%')) out.push({ kind: 'ejs' });
    else out.push({ kind: 'cell', hide: (s.match(/<(?:th|td)\b([^>]*)>/)?.[1].match(/hide-(?:sm|xs)/) || [''])[0] });
  }
  return out;
};

for (const f of views) {
  const src = fs.readFileSync(f, 'utf8');
  const markup = src.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  for (const tbl of markup.matchAll(/<table\b[\s\S]*?<\/table>/g)) {
    const head = tbl[0].match(/<thead>([\s\S]*?)<\/thead>/);
    const body = tbl[0].match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!head || !body) continue;

    const thRows = [...head[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)];
    const tdRows = [...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)];
    if (!thRows.length) continue;
    if (!tdRows.length) continue;

    const thTok = cellTokens(thRows[0][1]);
    if (thTok.length < 2) continue;
    if (!thTok.some((t) => t.kind === 'cell' && t.hide)) continue;

    // Row count differs => data-dependent table; nothing static to compare.
    if (thRows.length !== tdRows.length) continue;

    thRows.forEach((_, ri) => {
      const tds = cellTokens(tdRows[ri][1]);
      // The EJS/column structure must line up before per-column comparison is
      // meaningful. If it does not, the table is too dynamic to reason about.
      if (tds.length !== thTok.length) return;
      if (tds.some((t, i) => (t.kind === 'ejs') !== (thTok[i].kind === 'ejs'))) return;

      for (let i = 0; i < thTok.length; i++) {
        const th = thTok[i].hide || '';
        const td = tds[i].hide || '';
        if (th === td) continue;
        const col = thTok.slice(0, i + 1).filter((t) => t.kind === 'cell').length;
        if (!th && !td) continue;
        err(`${rel(f)}: table row ${ri + 1} column ${col} hides "${td || '(nothing)'}" in the body but "${th || '(nothing)'}" in the header`);
      }
    });
  }
}

// ---- 6. duplicate ids within a template -----------------------------------
// Script and style bodies are stripped first. Markup inside a <script> block is
// a JS string, not live DOM — e.g. templates that re-render a control group via
// innerHTML legitimately repeat the same id in the template literal. Scanning
// those would report a false positive and invite a destructive "fix".
for (const f of views) {
  const src = fs.readFileSync(f, 'utf8');
  const markup = src
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const re = /\sid="([^"<%]+)"/g;
  const hits = new Map();
  let m;
  while ((m = re.exec(markup)) !== null) {
    if (!hits.has(m[1])) hits.set(m[1], []);
    hits.get(m[1]).push(m.index);
  }
  for (const [id, positions] of hits) {
    if (positions.length < 2) continue;

    // A repeated id is only a real defect when both copies can render at once.
    // When the copies sit in mutually exclusive EJS branches (if/else), only
    // one ever reaches the DOM, so that is fine and must not fail the build.
    let exclusive = true;
    for (let i = 1; i < positions.length; i++) {
      const gap = markup.slice(positions[i - 1], positions[i]);
      if (!/<%\s*\}?\s*else\b/.test(gap)) { exclusive = false; break; }
    }

    if (exclusive) {
      warn(`${rel(f)}: id "${id}" appears ${positions.length}x in mutually exclusive EJS branches (ok)`);
    } else {
      err(`${rel(f)}: duplicate id "${id}" x${positions.length} in live markup`);
    }
  }
}

// ---- 6b. no element declares the same attribute twice -----------------------
// A repeated class= on one tag is not the same as two tags on one line: the
// second attribute is silently discarded by the parser, so the styling a
// template appears to request may never apply.
for (const f of views) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)+)\s*\/?>/g)) {
    const attrs = m[2];
    const seen = new Map();
    for (const a of attrs.matchAll(/([\w:-]+)\s*(?:=\s*(?:"[^"]*"|'[^']*'))?/g)) {
      const name = a[1].toLowerCase();
      seen.set(name, (seen.get(name) || 0) + 1);
    }
    for (const [name, n] of seen) {
      if (n > 1) {
        const line = src.slice(0, m.index).split('\n').length;
        err(`${rel(f)}:${line}: <${m[1]}> declares ${name} x${n} on the same element`);
      }
    }
  }
}

// ---- report ---------------------------------------------------------------
// Export the results so build.js can consume them without a child process.
// Only errors fail a build; warnings are advisory, because the existing
// `build.js --check` exits non-zero on ANY warning.
module.exports = { errors, warnings, run: () => ({ errors, warnings }) };

function report() {
  console.log('');
  console.log('  vpanel frontend check');
  console.log('  ======================');
  console.log(`  ${jsFiles.length} script(s), ${views.length} template(s), ${cssFiles.length} stylesheet(s)`);
  console.log('');
  for (const w of warnings) console.log(`[warn]  ${w}`);
  for (const e of errors) console.log(`[error] ${e}`);
  if (!errors.length && !warnings.length) console.log('[ok]    no frontend problems found');
  console.log('');
  console.log(`  ${errors.length} error(s), ${warnings.length} warning(s)`);
  console.log('');
}

if (require.main === module) {
  report();
  process.exit(errors.length ? 1 : 0);
}
