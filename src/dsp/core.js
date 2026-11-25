// Kiln - DSP core. Each DSP file pushes a module function onto KilnDSPModules. The same functions run
// in the window (for process definitions) and inside the render worker (built from their source),
// so a module may only use its argument D and plain JavaScript globals.
(function (g) { (g.KilnDSPModules = g.KilnDSPModules || []).push(function core(D) {
  D.procs = D.procs || {};
  D.order = D.order || [];
  D.FAMILIES = [
    ['spectral', 'Spectral'], ['waveset', 'Waveset'], ['granular', 'Granular & texture'],
    ['time', 'Time & pitch'], ['edit', 'Edit & mix'], ['fx', 'Effects']
  ];

  // ---------- registry ----------
  // def: { id, family, name, desc, inputs (1|2), params:[{key,label,min,max,def,fmt,curve,step,env}], choices:[{key,label,options,def}], run(I,P,U) }
  D.def = function (def) {
    def.inputs = def.inputs || 1;
    def.params = def.params || [];
    def.choices = def.choices || [];
    D.procs[def.id] = def;
    D.order.push(def.id);
    return def;
  };
  D.P = (key, label, min, max, def, fmt, opt) => Object.assign({ key, label, min, max, def, fmt: fmt || 'num', curve: 'lin', env: true }, opt || {});
  D.C = (key, label, options, def) => ({ key, label, options, def: def == null ? options[0] : def });
  D.SEED = () => D.P('seed', 'Seed', 1, 999, 1, 'int', { step: 1, env: false });

  // ---------- parameter access ----------
  // A value is a number, or { bp: [[t, v], ...] } with t in seconds from the start of input A.
  // default values for a process; parameters with defEnv ([[0..1 time, value]]) start as curves over `dur` seconds
  D.defaults = function (def, dur) {
    const v = {};
    for (const p of def.params) v[p.key] = p.defEnv && dur ? { bp: p.defEnv.map(([t, x]) => [t * dur, x]) } : p.def;
    for (const c of def.choices) v[c.key] = c.def;
    return v;
  };
  D.params = function (def, values, dur) {
    const vals = Object.assign(D.defaults(def, dur), values || {});
    const pd = {}; for (const p of def.params) pd[p.key] = p;
    const cache = {};
    function lookup(key, t) {
      const d = pd[key];
      let v = vals[key];
      if (v == null) v = d ? d.def : 0;
      if (typeof v === 'number') return v;
      const bp = v.bp;
      if (!bp || !bp.length) return d ? d.def : 0;
      if (bp.length === 1 || t <= bp[0][0]) return bp[0][1];
      const last = bp[bp.length - 1];
      if (t >= last[0]) return last[1];
      let c = cache[key] || 0;
      if (c >= bp.length - 1 || bp[c][0] > t) c = 0;
      while (c < bp.length - 2 && bp[c + 1][0] <= t) c++;
      cache[key] = c;
      const [t0, v0] = bp[c], [t1, v1] = bp[c + 1];
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      if (d && d.curve === 'log' && v0 > 0 && v1 > 0) return v0 * Math.pow(v1 / v0, f);
      return v0 + (v1 - v0) * f;
    }
    return {
      v: (key, t) => lookup(key, t || 0),
      i: (key, t) => Math.round(lookup(key, t || 0)),
      c: (key) => { const v = vals[key]; if (v != null) return v; const c = def.choices.find(q => q.key === key); return c ? c.def : null; },
      isEnv: (key) => vals[key] != null && typeof vals[key] === 'object',
      raw: vals
    };
  };

  // ---------- random ----------
  D.rng = function (seed) {
    let a = (seed * 2654435761) >>> 0 || 1;
    const r = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.range = (lo, hi) => lo + (hi - lo) * r();
    r.int = (n) => Math.floor(r() * n);
    r.bi = () => r() * 2 - 1;
    r.gauss = () => { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    r.shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; };
    return r;
  };

  // ---------- small helpers ----------
  D.clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  D.dbToGain = (db) => Math.pow(10, db / 20);
  D.st = (semis) => Math.pow(2, semis / 12);
  D.mono = function (I) {
    if (I.ch.length === 1) return I.ch[0];
    const n = I.ch[0].length, out = new Float32Array(n), k = 1 / I.ch.length;
    for (const c of I.ch) for (let i = 0; i < n; i++) out[i] += c[i] * k;
    return out;
  };
  D.peak = (x) => { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; };
  D.peakAll = (chs) => chs.reduce((m, c) => Math.max(m, D.peak(c)), 0);
  D.rms = (x, a, b) => { a = a || 0; b = b == null ? x.length : b; let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
  // linear interpolated read with zero outside
  D.read = (x, pos) => { const i = Math.floor(pos); if (i < 0 || i >= x.length - 1) return i === x.length - 1 ? x[i] : 0; const f = pos - i; return x[i] + (x[i + 1] - x[i]) * f; };
  // 4-point cubic read
  D.readCubic = (x, pos) => {
    const i = Math.floor(pos), f = pos - i, n = x.length;
    const xm = i - 1 >= 0 && i - 1 < n ? x[i - 1] : 0, x0 = i >= 0 && i < n ? x[i] : 0, x1 = i + 1 >= 0 && i + 1 < n ? x[i + 1] : 0, x2 = i + 2 >= 0 && i + 2 < n ? x[i + 2] : 0;
    const c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  };
  // resample a slice x[a..b) to length n
  D.stretchSlice = (x, a, b, n, out, off) => {
    const L = b - a; out = out || new Float32Array(n); off = off || 0;
    if (n <= 0 || L <= 0) return out;
    const k = n > 1 ? (L - 1) / (n - 1) : 0;
    for (let i = 0; i < n; i++) { const p = a + i * k, j = Math.floor(p), f = p - j; const v0 = x[j] || 0, v1 = j + 1 < b ? x[j + 1] : v0; out[off + i] = v0 + (v1 - v0) * f; }
    return out;
  };
  D.hann = (n) => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };
  // raised-cosine grain/window value for phase 0..1
  D.win = (ph, shape) => {
    if (ph <= 0 || ph >= 1) return 0;
    if (shape === 'perc') return ph < 0.05 ? ph / 0.05 : Math.pow(1 - (ph - 0.05) / 0.95, 2);
    if (shape === 'rect') return ph < 0.02 ? ph / 0.02 : ph > 0.98 ? (1 - ph) / 0.02 : 1;
    if (shape === 'tri') return 1 - Math.abs(ph * 2 - 1);
    return 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
  };
  // growable output buffer
  D.Out = function (initial) {
    let buf = new Float32Array(Math.max(1024, initial | 0)), len = 0;
    const ensure = (n) => { if (n <= buf.length) return; let m = buf.length; while (m < n) m *= 2; const nb = new Float32Array(m); nb.set(buf.subarray(0, len)); buf = nb; };
    return {
      push(v) { ensure(len + 1); buf[len++] = v; },
      pushArr(a, s, e) { s = s || 0; e = e == null ? a.length : e; const n = e - s; if (n <= 0) return; ensure(len + n); buf.set(a.subarray(s, e), len); len += n; },
      add(i, v) { ensure(i + 1); buf[i] += v; if (i + 1 > len) len = i + 1; },
      addArr(i, a, gain) { ensure(i + a.length); const g = gain == null ? 1 : gain; for (let k = 0; k < a.length; k++) buf[i + k] += a[k] * g; if (i + a.length > len) len = i + a.length; },
      silence(n) { ensure(len + n); len += n; },
      get length() { return len; },
      set length(v) { ensure(v); len = v; },
      result() { return buf.slice(0, len); }
    };
  };
  // short fades at both ends to stop clicks
  D.declick = (x, n) => { n = Math.min(n || 64, x.length >> 1); for (let i = 0; i < n; i++) { const g = i / n; x[i] *= g; x[x.length - 1 - i] *= g; } return x; };
  // make every output channel the same length
  D.equalise = (chs) => { const n = Math.max(...chs.map(c => c.length)); return chs.map(c => { if (c.length === n) return c; const o = new Float32Array(n); o.set(c); return o; }); };
  // run fn(x, channelIndex) on each channel
  D.perCh = (I, fn) => D.equalise(I.ch.map((x, c) => fn(x, c)));

  // ---------- FFT (in place, radix 2) ----------
  const fftCache = {};
  function tables(n) {
    if (fftCache[n]) return fftCache[n];
    const rev = new Uint32Array(n), bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    return (fftCache[n] = { rev, cos, sin });
  }
  D.fft = function (re, im, inverse) {
    const n = re.length, T = tables(n);
    for (let i = 0; i < n; i++) { const j = T.rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const sgn = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = T.cos[k], wi = T.sin[k] * sgn;
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };

  // ---------- phase vocoder ----------
  // analysis -> { N, hop, sr, bins, frames: [{amp: Float32Array(bins), freq: Float32Array(bins)}] }
  D.pvAnalyse = function (x, sr, N, overlap, onProgress) {
    N = N || 2048; const hop = N / (overlap || 8), bins = N / 2 + 1;
    const w = D.hann(N), re = new Float64Array(N), im = new Float64Array(N);
    const last = new Float64Array(bins);
    const nFrames = Math.max(1, Math.ceil((x.length + N) / hop));
    const frames = new Array(nFrames);
    const binHz = sr / N, expect = 2 * Math.PI * hop / N;
    let wsum = 0; for (let i = 0; i < N; i++) wsum += w[i];
    const norm = 2 / wsum;
    for (let f = 0; f < nFrames; f++) {
      const start = f * hop - N;
      for (let i = 0; i < N; i++) { const j = start + i; re[i] = (j >= 0 && j < x.length ? x[j] : 0) * w[i]; im[i] = 0; }
      // rotate so the window centre is at 0 (zero-phase)
      for (let i = 0; i < N / 2; i++) { const t = re[i]; re[i] = re[i + N / 2]; re[i + N / 2] = t; }
      D.fft(re, im, false);
      const amp = new Float32Array(bins), freq = new Float32Array(bins);
      for (let k = 0; k < bins; k++) {
        const a = Math.hypot(re[k], im[k]), ph = Math.atan2(im[k], re[k]);
        let d = ph - last[k] - k * expect; last[k] = ph;
        d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
        amp[k] = a * norm;
        freq[k] = (k + d / expect) * binHz;
      }
      frames[f] = { amp, freq };
      if (onProgress && (f & 63) === 0) onProgress(f / nFrames);
    }
    return { N, hop, sr, bins, frames, srcLen: x.length };
  };
  // resynthesis by phase accumulation; returns Float32Array of nFrames*hop samples (trimmed to `len` if given)
  D.pvSynth = function (an, frames, len, onProgress) {
    frames = frames || an.frames;
    const { N, hop, sr, bins } = an;
    const w = D.hann(N), re = new Float64Array(N), im = new Float64Array(N);
    const phase = new Float64Array(bins);
    const total = frames.length * hop + N;
    const out = new Float32Array(total);
    let wsum = 0; for (let i = 0; i < N; i++) wsum += w[i];
    // overlap-add normalisation for hann^2 at this hop
    let olaNorm = 0; for (let i = 0; i < N; i++) olaNorm += w[i] * w[i];
    olaNorm = olaNorm / hop;
    const twoPiHop = 2 * Math.PI * hop / sr;
    const ampScale = wsum / 2;
    for (let f = 0; f < frames.length; f++) {
      const { amp, freq } = frames[f];
      for (let k = 0; k < bins; k++) {
        phase[k] += freq[k] * twoPiHop;
        const a = amp[k] * ampScale;
        re[k] = a * Math.cos(phase[k]); im[k] = a * Math.sin(phase[k]);
      }
      for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
      im[0] = 0; im[N / 2] = 0;
      D.fft(re, im, true);
      for (let i = 0; i < N / 2; i++) { const t = re[i]; re[i] = re[i + N / 2]; re[i + N / 2] = t; }
      const start = f * hop;
      for (let i = 0; i < N; i++) out[start + i] += re[i] * w[i] / olaNorm;
      if (onProgress && (f & 63) === 0) onProgress(f / frames.length);
    }
    // analysis frame f covers input samples f*hop - N .. f*hop, so output is delayed by N
    const res = out.subarray(N, N + (len == null ? frames.length * hop - N : len));
    const o = new Float32Array(len == null ? Math.max(0, frames.length * hop - N) : len); o.set(res.subarray(0, o.length));
    return o;
  };
  D.pvTime = (an, f) => (f * an.hop - an.N / 2) / an.sr; // centre time of a frame in seconds
  D.blankFrame = (bins) => ({ amp: new Float32Array(bins), freq: new Float32Array(bins) });
  D.copyFrame = (fr) => ({ amp: fr.amp.slice(), freq: fr.freq.slice() });
  // spectral envelope by smoothing amplitudes (moving average over `w` bins in a log-ish way)
  D.specEnvelope = function (amp, width) {
    const n = amp.length, env = new Float32Array(n);
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + amp[i];
    for (let i = 0; i < n; i++) { const h = Math.max(1, Math.round(width * (0.5 + i / n))); const a = Math.max(0, i - h), b = Math.min(n, i + h + 1); env[i] = (cs[b] - cs[a]) / (b - a) + 1e-9; }
    return env;
  };
  // run a per-frame spectral process over each channel; fn(frame, t, frameIndex, an, state) -> frame (may be new)
  D.spectral = function (I, P, U, fn, opt) {
    opt = opt || {};
    const N = parseInt(P.c('fftsize') || opt.N || 2048, 10);
    return D.perCh(I, (x, c) => {
      const an = D.pvAnalyse(x, I.sr, N, 8, f => U.progress((c + f * 0.5) / I.ch.length));
      const state = { channel: c };
      const out = [];
      for (let f = 0; f < an.frames.length; f++) {
        const t = Math.max(0, D.pvTime(an, f));
        const r = fn(an.frames[f], t, f, an, state);
        if (r) out.push(r); else out.push(an.frames[f]);
      }
      const len = opt.keepLength === false ? null : x.length;
      return D.pvSynth(an, out, len, f => U.progress((c + 0.5 + f * 0.5) / I.ch.length));
    });
  };
  D.FFT_CHOICE = () => D.C('fftsize', 'Analysis size', ['1024', '2048', '4096'], '2048');

  // ---------- envelope follower ----------
  D.envelope = function (x, sr, winSec) {
    const hop = Math.max(1, Math.round(sr * (winSec || 0.01)));
    const n = Math.ceil(x.length / hop), e = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; const a = i * hop, b = Math.min(x.length, a + hop); for (let j = a; j < b; j++) { const v = Math.abs(x[j]); if (v > m) m = v; } e[i] = m; }
    return { e, hop };
  };
  // onset times (samples) using spectral flux on a mono signal
  D.onsets = function (x, sr, sensitivity, minGapSec) {
    const N = 1024, hop = 256, bins = N / 2;
    const w = D.hann(N), re = new Float64Array(N), im = new Float64Array(N);
    const nF = Math.max(1, Math.floor((x.length - N) / hop) + 1);
    const flux = new Float32Array(nF), prev = new Float32Array(bins);
    for (let f = 0; f < nF; f++) {
      const s = f * hop;
      for (let i = 0; i < N; i++) { re[i] = (x[s + i] || 0) * w[i]; im[i] = 0; }
      D.fft(re, im, false);
      let fl = 0;
      for (let k = 1; k < bins; k++) { const m = Math.log1p(Math.hypot(re[k], im[k]) * 10); const d = m - prev[k]; if (d > 0) fl += d; prev[k] = m; }
      flux[f] = fl;
    }
    // adaptive threshold
    const out = [0], W = 8, gap = Math.round((minGapSec || 0.05) * sr / hop);
    const sens = sensitivity == null ? 0.5 : sensitivity;
    let mean = 0; for (let f = 0; f < nF; f++) mean += flux[f]; mean /= nF;
    let last = -gap;
    for (let f = 1; f < nF - 1; f++) {
      let loc = 0, cnt = 0; for (let j = Math.max(0, f - W); j < Math.min(nF, f + W + 1); j++) { loc += flux[j]; cnt++; } loc /= cnt;
      const th = loc * (1.1 + (1 - sens) * 1.4) + mean * (0.15 + (1 - sens) * 0.6);
      if (flux[f] > th && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1] && f - last >= gap) { out.push(f * hop); last = f; }
    }
    return out;
  };
  // segments [a,b) between onsets, or a fixed grid when there are too few
  D.segments = function (x, sr, sens, minGap, fallbackSec) {
    let on = D.onsets(x, sr, sens, minGap);
    if (on.length < 2) { on = []; const step = Math.round(sr * (fallbackSec || 0.12)); for (let i = 0; i < x.length; i += step) on.push(i); }
    const seg = [];
    for (let i = 0; i < on.length; i++) { const a = on[i], b = i + 1 < on.length ? on[i + 1] : x.length; if (b - a > 32) seg.push([a, b]); }
    return seg;
  };

  // ---------- wavesets ----------
  // A waveset is the stretch between two successive upward zero-crossings (CDP's definition: a pair of half-cycles).
  D.wavesets = function (x, minLen) {
    minLen = minLen || 4;
    const zc = [0];
    for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0 && i - zc[zc.length - 1] >= minLen) zc.push(i);
    if (zc[zc.length - 1] !== x.length) zc.push(x.length);
    const ws = [];
    for (let i = 0; i + 1 < zc.length; i++) ws.push([zc[i], zc[i + 1]]);
    return ws;
  };
  D.wsPeak = (x, a, b) => { let m = 0; for (let i = a; i < b; i++) { const v = Math.abs(x[i]); if (v > m) m = v; } return m; };

  // ---------- spectrogram for the display ----------
  // returns {cols, rows, data:Uint8Array(cols*rows), dur}
  D.spectrogram = function (x, sr, cols, rows) {
    const N = 2048, w = D.hann(N), re = new Float64Array(N), im = new Float64Array(N);
    cols = Math.max(1, cols | 0); rows = rows || 160;
    const db = new Float32Array(cols * rows), data = new Uint8Array(cols * rows);
    const fMin = 30, fMax = Math.min(20000, sr / 2), binHz = sr / N;
    const rowBins = new Array(rows);
    for (let r = 0; r < rows; r++) { const f0 = fMin * Math.pow(fMax / fMin, r / rows), f1 = fMin * Math.pow(fMax / fMin, (r + 1) / rows); const a = Math.max(1, Math.floor(f0 / binHz)); rowBins[r] = [a, Math.max(a, Math.ceil(f1 / binHz) - 1)]; }
    let top = -200;
    for (let c = 0; c < cols; c++) {
      const centre = Math.floor((c + 0.5) / cols * x.length), s = centre - N / 2;
      for (let i = 0; i < N; i++) { const j = s + i; re[i] = (j >= 0 && j < x.length ? x[j] : 0) * w[i]; im[i] = 0; }
      D.fft(re, im, false);
      for (let r = 0; r < rows; r++) {
        let m = 0; const [a, b] = rowBins[r];
        for (let k = a; k <= Math.min(b, N / 2); k++) { const v = re[k] * re[k] + im[k] * im[k]; if (v > m) m = v; }
        const d = 10 * Math.log10(m / (N * N / 16) + 1e-14);
        db[c * rows + r] = d; if (d > top) top = d;
      }
    }
    // show the 80 dB below the loudest point in view, with a gentle curve so quiet detail stays visible
    const floor = top - 80;
    for (let i = 0; i < db.length; i++) { const t = Math.max(0, Math.min(1, (db[i] - floor) / 80)); data[i] = Math.round(Math.pow(t, 1.6) * 255); }
    return { cols, rows, data };
  };

  // ---------- running a process ----------
  // inputs: [{ch:[Float32Array], sr}] ; returns {ch, sr}
  D.run = function (id, inputs, values, progress) {
    const def = D.procs[id];
    if (!def) throw new Error('Unknown process ' + id);
    const I = inputs.map(inp => ({ ch: inp.ch, sr: inp.sr, len: inp.ch[0].length, dur: inp.ch[0].length / inp.sr }));
    // the list itself also stands for input A, so a process can say I.ch / I.sr or I[0].ch / I[0].sr
    Object.assign(I, { ch: I[0].ch, sr: I[0].sr, len: I[0].len, dur: I[0].dur });
    const P = D.params(def, values, I[0].dur);
    const U = { progress: progress || (() => { }), rng: D.rng(P.i('seed') || 1) };
    const res = def.run(I, P, U);
    let ch = Array.isArray(res) ? res : res.ch;
    ch = D.equalise(ch.map(c => c instanceof Float32Array ? c : Float32Array.from(c)));
    // safety: kill NaNs, keep at least a few samples
    for (const c of ch) for (let i = 0; i < c.length; i++) if (!isFinite(c[i])) c[i] = 0;
    if (!ch[0].length) ch = ch.map(() => new Float32Array(64));
    return { ch, sr: (res && res.sr) || I[0].sr };
  };
}); })(typeof self !== 'undefined' ? self : this);
