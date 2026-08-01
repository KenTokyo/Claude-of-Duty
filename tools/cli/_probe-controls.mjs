/**
 * _probe-controls — throwaway. Runs `ai-move` against every deliberately broken
 * build so the table in `scenarioMove` is measured against THIS shipping build
 * and not inherited. Each build is one textual revert in `src/ai/agent.js`,
 * applied to a copy, run, and restored; the file is restored from the backup at
 * the end whatever happens.
 *
 * Run with no args for all builds, or `node _probe-controls.mjs A C` for some.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/ai/agent.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BAK = '/tmp/_ctl-agent-backup.js';

const WATCHDOG = ['this.progress < Math.max(0.25, this.speed * 0.25)) {',
  'this.speed < Math.max(0.25, this.speed * 0.25)) { // CTL'];
const STANCE = ['if (shuffle > 0.12 && this.stanceTimer < 0.8) {', 'if (shuffle > 0.12) { // CTL'];
const SLOPE = ['slopeLimit: 48 * (Math.PI / 180),', 'slopeLimit: 48, // CTL'];
const SIDESTEP = ['if (this.stallTimer > 0.25 && wp && con?.touchingWall) {',
  'if (false && this.stallTimer > 0.25 && wp && con?.touchingWall) { // CTL'];
/** E: measure the shuffle in 3D again, the way it was before this shift. */
const SHUFFLE3D = ['const shuffle = this.cover ? Math.hypot(sdx, sdz) : 0;',
  'const shuffle = this.cover ? this.position.distanceTo(this.stancePos) : 0; // CTL'];

/** [key, label, [find, replace] ...] */
const BUILDS = [
  ['ship', 'shipping', []],
  ['A', 'watchdog back on `speed`', [WATCHDOG]],
  ['B', 'no stance deadline', [STANCE]],
  ['C', 'slopeLimit in degrees', [SLOPE]],
  ['D', 'no sidestep', [SIDESTEP]],
  ['E', 'shuffle measured in 3D', [SHUFFLE3D]],
  ['AB', 'A+B', [WATCHDOG, STANCE]],
  ['CD', 'C+D (no wall sense, no sidestep)', [SLOPE, SIDESTEP]],
  ['BE', 'B+E (no deadline, 3D shuffle)', [STANCE, SHUFFLE3D]],
  ['DE', 'D+E (no sidestep, 3D shuffle)', [SIDESTEP, SHUFFLE3D]],
];

const want = process.argv.slice(2);
copyFileSync(SRC, BAK);
const rows = [];
try {
  for (const [key, label, edits] of BUILDS) {
    if (want.length && !want.includes(key)) continue;
    let s = readFileSync(BAK, 'utf8');
    for (const [find, repl] of edits) {
      if (!s.includes(find)) throw new Error(`build ${key}: anchor missing -> ${find}`);
      s = s.replace(find, repl);
    }
    writeFileSync(SRC, s);
    // A control build is SUPPOSED to fail the gate, and a failing gate exits 1,
    // so a non-zero exit is the expected path and not an error.
    let out;
    try {
      out = execFileSync('node', ['tools/cli/cod.mjs', 'play', '--scenario=aimove', '--json'], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26,
      });
    } catch (err) {
      out = err.stdout;
      if (!out) throw err;
    }
    const j = JSON.parse(out.slice(out.indexOf('{')));
    const r = j.results[0];
    rows.push({
      build: key, label, pass: r.pass,
      stallPct: r.travelStallPct, travelStall: r.longestTravelStallS,
      shuffleStall: r.longestShuffleStallS, wall: r.wallContactFrames,
      side: r.sidestepFrames, pinned: r.pinnedShuffleFrames ?? null,
      worstGround: r.groundCoveredM[0].m,
      totalGround: +r.groundCoveredM.reduce((t, g) => t + g.m, 0).toFixed(1),
      worstPerAgent: r.worstTravelPerAgent.map((w) => w.s),
    });
    console.error(`done ${key} pass=${r.pass}`);
  }
} finally {
  copyFileSync(BAK, SRC);
  const back = readFileSync(SRC, 'utf8');
  console.error('restored, residue:', back.includes('// CTL'));
}
console.log('@@' + JSON.stringify(rows, null, 1));
