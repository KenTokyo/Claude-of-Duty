/**
 * Every texture fetch call site in one shader, named, with the function it sits
 * in and the source line it sits on.
 *
 * `fragcost` gives a per-function TOTAL, which is what you rank on -- but the
 * moment you want to remove one of them you need to know which sampler it reads
 * and under which branch, and a total cannot say. This prints exactly that,
 * after the same preprocessor fragcost uses, so what appears here is code the
 * driver would actually compile.
 *
 * The function split is fragcost's, not a fresh one, and deliberately so: a
 * line-oriented walk that looks for a definition at brace depth zero drops six
 * of this shader's twenty sites, because three's chunk soup contains at least
 * one unbalanced brace and multi-line signatures. Reproducing the totals
 * fragcost reports is the check that this listing is complete -- if the two
 * disagree, this file is lying about where the cost is.
 *
 * Usage: node tools/cli/sites.mjs <file.frag> [functionName]
 */
import fs from 'node:fs';
import { preprocessGlsl, fetchRegex } from './fragcost.mjs';

const [, , file, only] = process.argv;
if (!file) { console.error('usage: node tools/cli/sites.mjs <file.frag> [fn]'); process.exit(1); }

const src = fs.readFileSync(file, 'utf8');
const re = fetchRegex(src);
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, ''));
const { lines } = preprocessGlsl(stripped);
const text = lines.join('\n');

/** Byte offset -> 1-based line number in the PREPROCESSED text. */
const lineStarts = [0];
for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
const lineOf = (off) => {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= off) lo = m; else hi = m - 1; }
  return lo + 1;
};

// Same forward brace-match fragcost uses.
const fns = [];
const consumed = [];
const defRe = /(?:^|\n)\s*(?:highp\s+|mediump\s+|lowp\s+)?(?:void|float|int|uint|bool|vec[234]|ivec[234]|bvec[234]|mat[234](?:x[234])?)\s+(\w+)\s*\(/g;
for (const m of text.matchAll(defRe)) {
  if (consumed.some(([a, b]) => m.index >= a && m.index < b)) continue;
  let i = m.index + m[0].length, par = 1;
  while (i < text.length && par > 0) { const c = text[i]; if (c === '(') par++; else if (c === ')') par--; i++; }
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') continue;
  let d = 0; const start = i;
  for (; i < text.length; i++) {
    if (text[i] === '{') d++;
    else if (text[i] === '}') { d--; if (d === 0) { i++; break; } }
  }
  if (d !== 0) continue;
  consumed.push([start, i]);
  fns.push({ name: m[1], start, end: i });
}
consumed.sort((a, b) => a[0] - b[0]);

const owner = (off) => fns.find((f) => off >= f.start && off < f.end)?.name ?? '__top__';

const sites = [];
for (const m of text.matchAll(re)) {
  const off = m.index;
  sites.push({ fn: owner(off), line: lineOf(off), text: text.slice(lineStarts[lineOf(off) - 1], text.indexOf('\n', off) + 1 || undefined).trim() });
}

const byFn = {};
for (const s of sites) byFn[s.fn] = (byFn[s.fn] ?? 0) + 1;

if (only) {
  for (const s of sites.filter((s) => s.fn === only)) {
    console.log(`${String(s.line).padStart(5)}  ${s.text.slice(0, 160)}`);
  }
} else {
  console.log(JSON.stringify({ file, staticSitesByFunction: byFn, totalSites: sites.length }, null, 2));
}
