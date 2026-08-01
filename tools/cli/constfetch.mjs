/**
 * Find texture fetches whose COORDINATE cannot vary across a draw.
 *
 * A fetch whose argument is built only from uniforms and literals returns the
 * same texel on every fragment, so the shader is asking the texture unit for a
 * number the CPU could have put in a uniform. The sky dome was doing exactly
 * that four times per sky pixel -- 5.5 M fetches a frame -- and it read as
 * ordinary physics on the page, because the position it sampled was spelled
 * `vec3( 0.0, SK_GROUND_R + 0.0015, 0.0 )` rather than "a constant", and the
 * fetch itself was two calls down inside `skTransmittance`.
 *
 * That last part is why this does interprocedural work rather than pattern
 * matching. Three things have to compose before a fetch can be called constant:
 *
 *   LOCALS.    `vec3 pLow = vec3( 0.0, SK_GROUND_R + 0.0015, 0.0 );` is a local
 *              variable, and a local is only as constant as its initialiser.
 *              Resolved transitively, so a chain of locals still resolves.
 *   PARAMETERS. A fetch inside `skTransmittance( pos, dir )` is constant
 *              exactly when `pos` and `dir` are, WHICH DIFFERS PER CALL SITE:
 *              the dome called it six times, four constant and two not. So a
 *              function is summarised by WHICH PARAMETERS its fetch depends on,
 *              and every call site is then judged separately.
 *   BRANCHES.  A constant fetch behind a rarely-taken branch is worth nothing,
 *              so the enclosing conditions are reported and left to the reader.
 *
 * A CONSTANT FETCH IN A VERTEX SHADER IS THE FIX, NOT THE FINDING, and this
 * separates the two. Hoisting the coordinate-constant fetch into the three
 * vertices of a full-screen triangle is the cheapest way to act on a finding
 * here: it needs no CPU-side reproduction of the value at all, it is three
 * fetches per draw against one per pixel, and a `flat` varying makes the
 * fragment stage read the same bits it used to fetch. Six of this file's own
 * findings have been retired that way. Left unclassified they would come back
 * every run looking like work, so a fetch in a vertex source is listed under
 * `inVertexStage` instead of under `findings`.
 *
 * The stage test is the one unambiguous marker GLSL has: `gl_Position` is
 * writable in the vertex stage and nowhere else, so a template literal that
 * assigns it is a vertex shader. Fetches in a SHARED chunk -- one a vertex
 * source pulls in by interpolation, so the chunk itself never names
 * gl_Position -- stay in `findings`, which is the conservative direction: they
 * are reported and read rather than hidden.
 *
 * WHAT IT DOES NOT DO. It is a syntactic screen, not a proof. It reports
 * candidates to read. A candidate is only worth acting on if the value is also
 * reproducible on the CPU -- see `transmittanceLutSample` in atmosphere.js for
 * what that costs and why matching the LUT beat matching the physics. It also
 * cannot see a fetch that is constant only in practice, and it assumes a
 * function name is unique across the sources it is given.
 *
 *   node tools/cli/constfetch.mjs            # every source under src/
 *   node tools/cli/constfetch.mjs src/sky    # one subtree
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ?? 'src';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const FETCH = /\b(texture|texture2D|textureLod|texelFetch|textureGrad|textureCube)\s*\(/g;

const BUILTIN = new Set([
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'uvec2', 'uvec3', 'uvec4',
  'mat2', 'mat3', 'mat4', 'float', 'int', 'bool', 'uint', 'clamp', 'min', 'max',
  'abs', 'floor', 'ceil', 'fract', 'mod', 'mix', 'step', 'smoothstep', 'sqrt',
  'pow', 'exp', 'log', 'exp2', 'log2', 'sin', 'cos', 'tan', 'asin', 'acos',
  'atan', 'normalize', 'length', 'dot', 'cross', 'reflect', 'refract', 'sign',
  'inversesqrt', 'distance', 'faceforward', 'transpose', 'inverse', 'round',
  'true', 'false', 'return', 'if', 'else', 'for', 'while', 'discard', 'const',
  'in', 'out', 'inout', 'uniform', 'varying', 'void', 'struct', 'break',
  'continue', 'precision', 'highp', 'mediump', 'lowp', 'r', 'g', 'b', 'a',
  'x', 'y', 'z', 'w', 'rgb', 'rgba', 'xy', 'xyz', 'xyzw', 'rg', 'st',
]);

/** Balanced argument list starting at the '(' index. */
function readArgs(src, open) {
  let depth = 0;
  let start = open + 1;
  const args = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        if (i > start || args.length) args.push(src.slice(start, i));
        return { args, end: i + 1 };
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return { args, end: src.length };
}

/** Matching '}' for the '{' at `open`. */
function matchBrace(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  return src.length;
}

const ids = (expr) => [...new Set(expr.match(/[A-Za-z_]\w*/g) ?? [])]
  .filter((n) => !BUILTIN.has(n));

/**
 * Roots an expression depends on, with locals resolved transitively.
 * `decls` maps a local name to its initialiser expression.
 */
function roots(expr, decls, seen = new Set()) {
  const out = new Set();
  for (const n of ids(expr)) {
    if (decls.has(n)) {
      if (seen.has(n)) { out.add(n); continue; }
      seen.add(n);
      for (const r of roots(decls.get(n), decls, seen)) out.add(r);
    } else {
      out.add(n);
    }
  }
  return out;
}

/**
 * Every template-literal range in a JS source, innermost first.
 *
 * Backticks cannot simply be toggled: `${ ... }` re-enters JS, and this project
 * nests templates inside those holes (dof.js builds its depth reads that way).
 * So this tracks the mode properly -- template, interpolation hole, string,
 * comment -- and a nested template ends up as its own, narrower range.
 */
function templateRanges(src) {
  const out = [];
  const stack = [];          // open templates; `hole` > 0 means we are back in JS
  const inTemplate = () => stack.length > 0 && stack[stack.length - 1].hole === 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (inTemplate()) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { out.push({ start: stack.pop().start, end: i + 1 }); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { stack[stack.length - 1].hole++; i += 2; continue; }
      i++; continue;
    }
    // Plain JS: at the top level or inside a `${ ... }` hole. Comments and
    // quoted strings are skipped whole, because a backtick in a JSDoc line
    // would otherwise open a template that runs to the end of the file --
    // and this codebase writes `identifiers` in prose constantly.
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i += 2; continue; }
    if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++; continue;
    }
    if (c === '`') { stack.push({ start: i, hole: 0 }); i++; continue; }
    if (stack.length) {
      const top = stack[stack.length - 1];
      if (c === '{') { top.hole++; i++; continue; }
      if (c === '}') { top.hole--; i++; continue; }
    }
    i++;
  }
  return out.sort((a, b) => (b.start - a.start) || (a.end - b.end));
}

/** 'vertex' when the innermost template around `at` assigns gl_Position. */
function stageAt(ranges, src, at) {
  for (const r of ranges) {
    if (at >= r.start && at < r.end) {
      return /\bgl_Position\s*=/.test(src.slice(r.start, r.end)) ? 'vertex' : 'fragment';
    }
  }
  return 'fragment';
}

function parseSource(src, label) {
  const uniforms = new Set();
  const globalConsts = new Map();
  const varyings = new Set();
  for (const m of src.matchAll(/^\s*uniform\s+\w+\s+([\w,\s[\]]+?)\s*;/gm)) {
    for (const n of m[1].split(',')) uniforms.add(n.trim().replace(/\[.*/, ''));
  }
  for (const m of src.matchAll(/^\s*const\s+\w+\s+(\w+)\s*=\s*([^;]+);/gm)) {
    globalConsts.set(m[1], m[2]);
  }
  for (const m of src.matchAll(/^\s*(?:(?:flat|smooth)\s+)?(?:in|out|varying|attribute)\s+\w+\s+(\w+)/gm)) {
    varyings.add(m[1]);
  }

  const fns = [];
  for (const m of src.matchAll(/^[ \t]*(\w+)[ \t]+(\w+)[ \t]*\(([^)]*)\)[ \t]*\{/gm)) {
    if (BUILTIN.has(m[2]) || BUILTIN.has(m[1]) === false && m[1] === 'else') continue;
    const open = src.indexOf('{', m.index);
    const close = matchBrace(src, open);
    fns.push({
      name: m[2],
      params: m[3].split(',').map((p) => p.trim().split(/\s+/).pop())
        .filter((p) => p && p !== 'void'),
      start: m.index, bodyStart: open, bodyEnd: close,
      body: src.slice(open, close),
    });
  }
  const ranges = templateRanges(src);
  return {
    label, src, uniforms, globalConsts, varyings, fns,
    lineAt: (i) => src.slice(0, i).split('\n').length,
    stageAt: (i) => stageAt(ranges, src, i),
  };
}

/** Local declarations visible inside a function body, name -> initialiser. */
function localsOf(fn, globalConsts) {
  const decls = new Map(globalConsts);
  for (const d of fn.body.matchAll(
    /(?:^|[;{}])\s*(?:const\s+)?(?:vec[234]|float|int|bool|mat[234]|ivec[234])\s+(\w+)\s*=\s*([^;]+);/g
  )) decls.set(d[1], d[2]);
  // A declaration with no initialiser, or one written through by an out
  // parameter, has no expression to resolve -- treat it as varying by leaving
  // it out of `decls` so it surfaces as an unresolved root.
  return decls;
}

/** Conditions of every `if` whose body encloses `at`, innermost last. */
function guardsAt(fn, at) {
  const g = [];
  for (const m of fn.body.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const { args, end } = readArgs(fn.body, open);
    let bodyEnd;
    const nb = fn.body.indexOf('{', end);
    const semi = fn.body.indexOf(';', end);
    if (nb >= 0 && (semi < 0 || nb < semi)) bodyEnd = matchBrace(fn.body, nb);
    else bodyEnd = semi;
    if (at > end && at < bodyEnd) g.push(args.join(',').replace(/\s+/g, ' ').trim());
  }
  return g;
}

const files = walk(ROOT).map((f) => [f, fs.readFileSync(f, 'utf8')])
  .filter(([, s]) => { FETCH.lastIndex = 0; return FETCH.test(s); })
  .map(([f, s]) => parseSource(s, f));

// ---- pass 1: summarise each function that contains a fetch -----------------
// A summary is: which of my parameters does this fetch's coordinate depend on,
// and does anything else in it vary.
const summaries = new Map();
const direct = [];
for (const u of files) {
  for (const fn of u.fns) {
    const decls = localsOf(fn, u.globalConsts);
    for (const m of [...fn.body.matchAll(FETCH)]) {
      const open = m.index + m[0].length - 1;
      const { args } = readArgs(fn.body, open);
      if (args.length < 2) continue;
      const r = [...roots(args[1], decls)];
      const varying = r.filter((n) => u.varyings.has(n) || n.startsWith('gl_'));
      const params = r.filter((n) => fn.params.includes(n));
      const known = r.filter((n) => u.uniforms.has(n) || u.globalConsts.has(n));
      const unknown = r.filter((n) => !varying.includes(n) && !params.includes(n)
        && !known.includes(n) && !/^\d/.test(n));
      const site = {
        file: u.label,
        line: u.lineAt(fn.start) + fn.body.slice(0, m.index).split('\n').length - 1,
        fn: fn.name,
        stage: u.stageAt(fn.bodyStart + m.index),
        call: `${m[1]}(${args[0].trim()}, ${args[1].trim()})`.replace(/\s+/g, ' ').slice(0, 100),
        guards: guardsAt(fn, m.index),
      };
      if (varying.length || unknown.length) continue;
      if (params.length === 0) direct.push({ ...site, verdict: 'CONSTANT', dependsOn: known });
      else {
        const s = summaries.get(fn.name) ?? { fn: fn.name, sites: [] };
        s.sites.push({ ...site, params });
        summaries.set(fn.name, s);
      }
    }
  }
}

// ---- pass 2: judge every call site of a summarised function ----------------
const propagated = [];
for (const u of files) {
  for (const caller of u.fns) {
    const decls = localsOf(caller, u.globalConsts);
    for (const [name, s] of summaries) {
      if (name === caller.name) continue;
      const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
      for (const m of [...caller.body.matchAll(re)]) {
        const open = m.index + m[0].length - 1;
        const { args } = readArgs(caller.body, open);
        // Which formal parameters the callee's fetch actually reads.
        const callee = s.sites[0];
        const idxs = callee.params.map((p) => {
          const f = u.fns.find((x) => x.name === name) ?? files
            .flatMap((z) => z.fns).find((x) => x.name === name);
          return f ? f.params.indexOf(p) : -1;
        }).filter((i) => i >= 0);
        if (!idxs.length) continue;
        let constant = true;
        const drivers = new Set();
        for (const i of idxs) {
          if (i >= args.length) { constant = false; break; }
          for (const r of roots(args[i], decls)) {
            if (u.varyings.has(r) || r.startsWith('gl_')
              || caller.params.includes(r)) { constant = false; }
            else if (u.uniforms.has(r) || u.globalConsts.has(r)) drivers.add(r);
            else if (!/^\d/.test(r)) constant = false;
          }
        }
        if (!constant) continue;
        propagated.push({
          file: u.label,
          line: u.lineAt(caller.start) + caller.body.slice(0, m.index).split('\n').length - 1,
          fn: caller.name,
          stage: u.stageAt(caller.bodyStart + m.index),
          call: `${name}(${idxs.map((i) => args[i].trim()).join(', ')})`
            .replace(/\s+/g, ' ').slice(0, 100),
          fetchAt: `${callee.file}:${callee.line} in ${callee.fn}`,
          guards: guardsAt(caller, m.index),
          dependsOn: [...drivers],
          verdict: 'CONSTANT AT THIS CALL SITE',
        });
      }
    }
  }
}

const all = [...direct, ...propagated];
const findings = all.filter((f) => f.stage !== 'vertex');
const hoisted = all.filter((f) => f.stage === 'vertex');
console.log(JSON.stringify({
  root: ROOT,
  note: 'A finding is a fetch whose coordinate resolves to uniforms, consts and '
    + 'literals only -- a candidate for a CPU-side uniform or a vertex-stage '
    + 'hoist, NOT a confirmed saving. Two things still have to hold. The value '
    + 'must be reproducible where you move it, which for the CPU is a real cost '
    + 'and sometimes a blocker (a GPU-baked LUT the mock cannot read is the '
    + 'usual one) and for the vertex stage is free. And `guards` must be empty '
    + 'or nearly always true: a constant fetch behind a branch that fires on '
    + 'the solar disc is worth nothing however constant it is.',
  functionsWithParameterisedFetches: [...summaries.keys()],
  count: findings.length,
  findings,
  inVertexStageNote: 'Already hoisted: these are constant fetches sitting in a '
    + 'shader that assigns gl_Position, which costs 3 per draw rather than one '
    + 'per pixel. They are the ACTED-ON form of a finding and are listed only so '
    + 'they are not rediscovered as work. Stage is decided by the innermost '
    + 'template literal around the fetch, so a fetch in a shared chunk a vertex '
    + 'shader interpolates stays in `findings` above.',
  inVertexStage: hoisted.map((f) => ({ file: f.file, line: f.line, call: f.call })),
}, null, 1));
