// Runs every process on synthetic sounds and checks the output is sane.
const D = require('./load.js')();
const sr = 44100;
function tone(dur, stereo) {
  const n = Math.round(dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  let s = 1;
  for (let i = 0; i < n; i++) {
    const t = i / sr, beat = t % 0.25, env = Math.exp(-beat * 14);
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const nz = s / 2147483648 - 1;
    let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * 220 * h * t * (1 + 0.002 * Math.sin(t * 3))) / h;
    L[i] = (v * 0.3 + nz * 0.05) * env; R[i] = (v * 0.28 + nz * 0.06) * env;
  }
  return { ch: stereo ? [L, R] : [L], sr };
}
const A1 = tone(2, false), A2 = tone(2, true), B = tone(1.3, true);
const ids = D.order;
let fails = 0;
const rows = [];
for (const id of ids) {
  const def = D.procs[id];
  for (const A of [A1, A2]) {
    const inputs = def.inputs === 2 ? [A, B] : [A];
    const t0 = Date.now();
    try {
      const vals = {};
      // keep the long-output processes short for the test
      for (const p of def.params) if (['dur', 'hold'].includes(p.key)) vals[p.key] = Math.min(p.def, 3);
      const res = D.run(id, inputs, vals);
      const ms = Date.now() - t0;
      const len = res.ch[0].length, pk = D.peakAll(res.ch);
      let bad = res.ch.some(c => c.some(v => !isFinite(v)));
      const ok = !bad && len > 100 && pk > 1e-4 && pk < 50;
      if (!ok) fails++;
      rows.push(`${ok ? 'ok ' : 'BAD'} ${id.padEnd(16)} ch${A.ch.length}->${res.ch.length} ${(len / sr).toFixed(2).padStart(6)}s peak ${pk.toFixed(3).padStart(7)} ${String(ms).padStart(5)}ms`);
    } catch (e) { fails++; rows.push(`ERR ${id} ch${A.ch.length}: ${e.stack.split('\n').slice(0,3).join(' | ')}`); }
  }
}
console.log(rows.join('\n'));
console.log(`\n${ids.length} processes, ${fails} problems`);
process.exit(fails ? 1 : 0);
