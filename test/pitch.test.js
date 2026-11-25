// Checks that pitch and time processes land where they should
const D = require('./load.js')();
const sr = 44100, n = sr * 2, x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / sr);
const A = { ch: [x], sr };
function f0(y) { // strongest FFT peak in the middle of the signal, with parabolic refinement
  const N = 16384, a = Math.max(0, Math.floor(y.length / 2 - N / 2)), re = new Float64Array(N), im = new Float64Array(N), w = D.hann(N);
  for (let i = 0; i < N; i++) re[i] = (y[a + i] || 0) * w[i];
  D.fft(re, im, false);
  let bk = 1, bm = 0; const m = (k) => Math.log(Math.hypot(re[k], im[k]) + 1e-12);
  for (let k = 2; k < N / 2 - 1; k++) { const v = Math.hypot(re[k], im[k]); if (v > bm) { bm = v; bk = k; } }
  const d = 0.5 * (m(bk - 1) - m(bk + 1)) / (m(bk - 1) - 2 * m(bk) + m(bk + 1));
  return (bk + d) * sr / N;
}
const cases = [
  ['spec.pitch', { shift: 7 }, 220 * Math.pow(2, 7 / 12), 2],
  ['spec.pitch', { shift: -12, formants: 'Move with pitch' }, 110, 2],
  ['tp.pitch', { shift: 5 }, 220 * Math.pow(2, 5 / 12), 2],
  ['tp.varispeed', { speed: 12 }, 440, 1],
  ['ws.multiply', { factor: 3 }, 660, 2],
  ['ws.divide', { factor: 2 }, 110, 2],
  ['spec.stretch', { factor: 3 }, 220, 6],
  ['tp.stretch', { factor: 0.5 }, 220, 1],
  ['spec.shift', { hz: 100 }, 320, 2],
];
let bad = 0;
for (const [id, v, want, wantDur] of cases) {
  const r = D.run(id, [A], v), y = r.ch[0], f = f0(y), dur = y.length / sr;
  const ok = Math.abs(1200 * Math.log2(f / want)) < 25 && Math.abs(dur - wantDur) < 0.15;
  if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'BAD'} ${id.padEnd(13)} ${JSON.stringify(v).padEnd(40)} pitch ${f.toFixed(1)} (want ${want.toFixed(1)})  length ${dur.toFixed(2)}s (want ${wantDur})`);
}
process.exit(bad ? 1 : 0);
