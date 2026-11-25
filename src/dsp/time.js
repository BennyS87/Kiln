// Kiln - time, pitch, envelope and editing processes, after CDP's MODIFY SPEED, EXTEND, ENVEL and EDIT families.
(function (g) { (g.KilnDSPModules = g.KilnDSPModules || []).push(function time(D) {
  const { P, C } = D;
  const BTIME = () => C('btime', 'Timing of B', ['Stretch to fit A', 'As it is'], 'Stretch to fit A');

  // ---------- WSOLA time stretch: factorAt(tSec) -> stretch factor. Returns {y, map} where map[k] = input time of output frame k ----------
  function wsola(x, sr, factorAt, winSec, tolSec, onProgress) {
    const N = Math.max(256, Math.round(sr * (winSec || 0.06)) & ~1), hop = N >> 1, tol = Math.round(sr * (tolSec || 0.012));
    const w = D.hann(N);
    const out = D.Out(x.length * 2);
    const map = [];
    let inPos = 0, prev = -1, k = 0, guard = 0;
    while (inPos < x.length && guard++ < 2e6) {
      let pos = Math.round(inPos);
      if (prev >= 0) {
        // best match for the natural continuation of the previous grain
        const nat = prev + hop; let best = 0, bv = -Infinity;
        const lo = Math.max(-tol, -pos), hi = Math.min(tol, x.length - pos - N);
        for (let d = lo; d <= hi; d += 2) {
          let s = 0; for (let i = 0; i < N; i += 4) s += (x[pos + d + i] || 0) * (x[nat + i] || 0);
          if (s > bv) { bv = s; best = d; }
        }
        pos += best;
      }
      const o = k * hop;
      for (let i = 0; i < N; i++) out.add(o + i, (x[pos + i] || 0) * w[i]);
      map.push(inPos / sr);
      prev = pos; k++;
      inPos += hop / Math.max(0.01, factorAt(inPos / sr));
      if (onProgress && (k & 31) === 0) onProgress(inPos / x.length);
    }
    return { y: out.result(), map, hop };
  }
  D.wsola = wsola;

  // tape-style speed change; ratioAt(tIn) -> playback ratio
  function varispeed(x, sr, ratioAt) {
    const out = D.Out(x.length);
    let pos = 0, guard = 0;
    while (pos < x.length - 1 && guard++ < 5e7) { out.push(D.readCubic(x, pos)); pos += Math.max(0.01, ratioAt(pos / sr)); }
    return out.result();
  }

  D.def({
    id: 'tp.varispeed', family: 'time', name: 'Varispeed',
    desc: 'Speeds the sound up or slows it down like tape: pitch and length change together. Draw a curve for tape-stop and wow effects.',
    params: [P('speed', 'Speed', -36, 36, -12, 'st')],
    run(I, P_) { return D.perCh(I, (x) => varispeed(x, I.sr, t => D.st(P_.v('speed', t)))); }
  });

  D.def({
    id: 'tp.stretch', family: 'time', name: 'Time stretch (wave)',
    desc: 'Changes length without changing pitch by overlapping matching slices of the waveform. Keeps drums and attacks crisper than the spectral stretch.',
    params: [P('factor', 'Stretch', 0.1, 16, 2, 'x', { curve: 'log' }), P('win', 'Slice size', 0.015, 0.25, 0.06, 'ms', { curve: 'log', env: false })],
    run(I, P_, U) {
      const sr = I[0].sr;
      return D.perCh(I, (x, c) => wsola(x, sr, t => P_.v('factor', t), P_.v('win'), 0.012, f => U.progress((c + f) / I[0].ch.length)).y);
    }
  });

  D.def({
    id: 'tp.pitch', family: 'time', name: 'Pitch shift (wave)',
    desc: 'Changes pitch without changing length, working on the waveform. Fast and punchy; for big shifts on voices try the spectral transpose.',
    params: [P('shift', 'Transpose', -24, 24, 5, 'st'), P('win', 'Slice size', 0.015, 0.25, 0.05, 'ms', { curve: 'log', env: false })],
    run(I, P_, U) {
      const sr = I[0].sr;
      return D.perCh(I, (x, c) => {
        const r = (t) => D.st(P_.v('shift', t));
        const { y, map, hop } = wsola(x, sr, r, P_.v('win'), 0.012, f => U.progress((c + f * 0.8) / I[0].ch.length));
        const out = D.Out(x.length);
        let pos = 0, guard = 0;
        while (pos < y.length - 1 && guard++ < 5e7) { out.push(D.readCubic(y, pos)); const ti = map[Math.min(map.length - 1, Math.floor(pos / hop))] || 0; pos += r(ti); }
        const res = out.result();
        return res.length > x.length ? res.subarray(0, x.length) : res;
      });
    }
  });

  D.def({
    id: 'tp.reverse', family: 'time', name: 'Reverse',
    desc: 'Plays the sound backwards.',
    run(I) { return I[0].ch.map(x => x.slice().reverse()); }
  });

  D.def({
    id: 'tp.loop', family: 'time', name: 'Loop & step',
    desc: 'Plays a short loop many times, moving the loop start on a little each time, so the sound crawls forward (or back) through itself.',
    params: [P('start', 'Start', 0, 60, 0, 'sec', { env: false }), P('len', 'Loop length', 0.005, 10, 0.25, 'ms', { curve: 'log' }), P('step', 'Step', -2, 2, 0.05, 'ms'), P('count', 'Loops', 1, 400, 32, 'int', { curve: 'log', step: 1, env: false }), P('fade', 'Crossfade', 0.001, 0.2, 0.01, 'ms', { curve: 'log', env: false }), P('jitter', 'Step jitter', 0, 1, 0, 'pct'), D.SEED()],
    run(I, P_, U) {
      const A = I[0], sr = A.sr, n = P_.i('count'), fade = Math.round(P_.v('fade') * sr);
      const plan = []; let s = P_.v('start') * sr;
      for (let k = 0; k < n; k++) {
        const t = D.clamp(s / sr, 0, A.dur), L = Math.max(32, Math.round(P_.v('len', t) * sr));
        const a = Math.round(D.clamp(s, 0, Math.max(0, A.len - L)));
        plan.push([a, Math.min(A.len, a + L)]);
        s += P_.v('step', t) * sr * (1 + U.rng.bi() * P_.v('jitter', t));
      }
      return D.perCh(I, (x) => {
        let total = 0; for (const [a, b] of plan) total += (b - a) - fade;
        const out = new Float32Array(Math.max(64, total + fade * 2)); let o = 0;
        for (const [a, b] of plan) { const L = b - a, f = Math.min(fade, L >> 1); for (let i = 0; i < L; i++) { let e = 1; if (i < f) e = i / f; else if (i > L - f) e = (L - i) / f; if (o + i < out.length) out[o + i] += x[a + i] * e; } o += L - f; }
        return out.subarray(0, Math.min(out.length, o + fade));
      });
    }
  });

  D.def({
    id: 'tp.zigzag', family: 'time', name: 'Zigzag',
    desc: 'Reads forwards and backwards through the sound between turning points, regular or random, like scrubbing a tape back and forth.',
    params: [P('count', 'Turns', 2, 200, 16, 'int', { curve: 'log', step: 1, env: false }), P('min', 'Shortest run', 0.01, 4, 0.08, 'ms', { curve: 'log', env: false }), P('max', 'Longest run', 0.02, 8, 0.5, 'ms', { curve: 'log', env: false }), D.SEED()],
    choices: [C('mode', 'Turning points', ['Random', 'Swing across the whole sound'], 'Random')],
    run(I, P_, U) {
      const A = I[0], sr = A.sr, n = P_.i('count'), r = U.rng, rnd = P_.c('mode') === 'Random';
      const pts = [0]; let cur = 0, dir = 1;
      for (let k = 0; k < n; k++) {
        const L = (P_.v('min') + r() * Math.max(0, P_.v('max') - P_.v('min'))) * sr;
        if (rnd) { let nx = cur + dir * L; if (nx > A.len - 1 || nx < 0) { dir = -dir; nx = cur + dir * L; } cur = D.clamp(nx, 0, A.len - 1); dir = -dir; }
        else cur = k % 2 === 0 ? A.len - 1 : 0;
        pts.push(cur);
      }
      return D.perCh(I, (x) => {
        const out = D.Out(A.len * 2);
        for (let k = 0; k + 1 < pts.length; k++) { const a = pts[k], b = pts[k + 1], step = b > a ? 1 : -1; for (let p = a; step > 0 ? p < b : p > b; p += step) out.push(D.read(x, p)); }
        return D.declick(out.result());
      });
    }
  });

  D.def({
    id: 'tp.drunk', family: 'time', name: 'Drunken walk',
    desc: 'Plays short slices of the sound while the read position staggers about at random, never far from where it was a moment ago.',
    params: [P('dur', 'Length', 0.5, 120, 10, 'sec', { curve: 'log', env: false }), P('clock', 'Slice length', 0.01, 2, 0.12, 'ms', { curve: 'log' }), P('stagger', 'Largest step', 0, 4, 0.2, 'sec', { curve: 'pow', pow: 2 }), P('pull', 'Pull to centre', 0, 1, 0.1, 'pct'), P('centre', 'Centre', 0, 1, 0.5, 'pct'), D.SEED()],
    run(I, P_, U) {
      const A = I[0], sr = A.sr, outLen = Math.round(P_.v('dur') * sr), r = U.rng;
      let pos = P_.v('centre', 0) * A.len, t = 0; const plan = [];
      while (t < outLen) {
        const te = t / outLen * A.dur, L = Math.max(64, Math.round(P_.v('clock', te) * sr));
        const centre = P_.v('centre', te) * A.len;
        pos += r.bi() * P_.v('stagger', te) * sr + (centre - pos) * P_.v('pull', te);
        pos = D.clamp(pos, 0, Math.max(0, A.len - L));
        plan.push([Math.round(pos), Math.round(pos) + L]); t += L * 0.75;
      }
      return D.perCh(I, (x) => {
        const out = new Float32Array(outLen + 4096); let o = 0;
        for (const [a, b] of plan) { const L = b - a; for (let i = 0; i < L && o + i < out.length; i++) out[o + i] += (x[a + i] || 0) * D.win(i / L, 'hann'); o += Math.round(L * 0.5); }
        return out.subarray(0, outLen);
      });
    }
  });

  D.def({
    id: 'tp.tremolo', family: 'time', name: 'Tremolo & pulse',
    desc: 'Rhythmic changes in loudness, from gentle wobble to hard chopping, with an optional offset between left and right.',
    params: [P('rate', 'Rate', 0.1, 60, 6, 'hzLfo', { curve: 'log' }), P('depth', 'Depth', 0, 1, 0.8, 'pct'), P('phase', 'Left/right offset', 0, 1, 0, 'pct', { env: false })],
    choices: [C('shape', 'Shape', ['Sine', 'Square', 'Triangle', 'Ramp down'], 'Sine')],
    run(I, P_) {
      const sh = P_.c('shape'), sr = I[0].sr, n = I[0].len;
      const ch = I[0].ch.length === 1 && P_.v('phase') > 0 ? [I[0].ch[0], I[0].ch[0]] : I[0].ch;
      return ch.map((x, c) => {
        const y = new Float32Array(n); let ph = c * P_.v('phase'), sm = 1; const k = Math.exp(-1 / (0.0015 * sr)); // smoothing stops square-wave clicks
        for (let i = 0; i < n; i++) {
          const t = i / sr; ph += P_.v('rate', t) / sr;
          const p = ph % 1; let l = sh === 'Square' ? (p < 0.5 ? 1 : 0) : sh === 'Triangle' ? 1 - Math.abs(p * 2 - 1) : sh === 'Ramp down' ? 1 - p : 0.5 + 0.5 * Math.sin(2 * Math.PI * p);
          const d = P_.v('depth', t); sm = k * sm + (1 - k) * (1 - d + d * l); y[i] = x[i] * sm;
        }
        return y;
      });
    }
  });

  D.def({
    id: 'tp.envelope', family: 'time', name: 'Draw envelope',
    desc: 'Shapes the loudness over time with a curve you draw: fades, swells, gates and accents.',
    params: [P('level', 'Level', -60, 12, 0, 'db', { defEnv: [[0, -60], [0.08, 0], [0.7, 0], [1, -60]] })],
    run(I, P_) { const sr = I[0].sr; return I[0].ch.map(x => { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { const db = P_.v('level', i / sr); y[i] = db <= -59.9 ? 0 : x[i] * D.dbToGain(db); } return y; }); }
  });

  D.def({
    id: 'tp.envtransfer', family: 'time', name: 'Envelope transfer',
    desc: 'Gives sound A the loudness contour of sound B: make a drone pulse with a drum loop\'s rhythm or a noise speak with a voice\'s phrasing.',
    inputs: 2,
    params: [P('amount', 'Amount', 0, 1, 1, 'pct'), P('flatten', 'Flatten A first', 0, 1, 0.7, 'pct', { env: false }), P('smooth', 'Smoothing', 0.002, 0.2, 0.015, 'ms', { curve: 'log', env: false }), P('gain', 'Output', -24, 24, 0, 'db', { env: false })],
    choices: [BTIME()],
    run(I, P_) {
      const A = I[0], B = I[1], sr = A.sr, sm = P_.v('smooth');
      const follow = (x) => { const y = new Float32Array(x.length), aA = Math.exp(-1 / (0.001 * sr)), aR = Math.exp(-1 / (sm * sr)); let e = 0; for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); e = v > e ? aA * e + (1 - aA) * v : aR * e + (1 - aR) * v; y[i] = e; } return y; };
      const eA = follow(D.mono(A)), eB = follow(D.mono(B));
      let pa = 0; for (let i = 0; i < eA.length; i++) pa = Math.max(pa, eA[i]);
      let pb = 0; for (let i = 0; i < eB.length; i++) pb = Math.max(pb, eB[i]);
      const stretch = P_.c('btime') === 'Stretch to fit A', fl = P_.v('flatten'), gain = D.dbToGain(P_.v('gain'));
      return A.ch.map(x => {
        const y = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) {
          const t = i / sr, am = P_.v('amount', t);
          const bi = stretch ? Math.floor(i * eB.length / x.length) : i;
          const eb = bi < eB.length ? eB[bi] / (pb || 1) : 0;
          const ea = eA[i] / (pa || 1);
          const flat = Math.pow(Math.max(ea, 1e-3), -fl);
          y[i] = x[i] * (1 - am + am * eb * flat);
        }
        const k = (D.peak(x) / (D.peak(y) || 1)) * gain;
        for (let i = 0; i < y.length; i++) y[i] *= k;
        return y;
      });
    }
  });

  D.def({
    id: 'tp.pan', family: 'time', name: 'Pan & spin',
    desc: 'Places the sound in the stereo field with a curve you draw, or spins it around, with optional Doppler-like pitch wobble.',
    params: [P('pan', 'Position', -1, 1, 0, 'pan'), P('rate', 'Spin rate', 0, 20, 0, 'hzLfo', { curve: 'pow', pow: 2 }), P('width', 'Spin width', 0, 1, 1, 'pct'), P('doppler', 'Doppler', 0, 1, 0, 'pct', { env: false })],
    run(I, P_) {
      const x = D.mono(I[0]), sr = I[0].sr, n = x.length, L = new Float32Array(n), R = new Float32Array(n);
      let ph = 0; const dop = P_.v('doppler') * 0.0015 * sr;
      for (let i = 0; i < n; i++) {
        const t = i / sr; ph += P_.v('rate', t) / sr;
        const s = Math.sin(2 * Math.PI * ph);
        const p = D.clamp(P_.v('pan', t) + s * P_.v('width', t) * (P_.v('rate', t) > 0 ? 1 : 0), -1, 1);
        const a = (p + 1) * Math.PI / 4;
        const v = dop > 0 ? D.read(x, i - dop * (1 + Math.cos(2 * Math.PI * ph))) : x[i];
        L[i] = v * Math.cos(a) * 1.2; R[i] = v * Math.sin(a) * 1.2;
      }
      return [L, R];
    }
  });

  // ================= edit & mix =================
  D.def({
    id: 'ed.normalise', family: 'edit', name: 'Normalise',
    desc: 'Raises or lowers the level so the loudest peak sits at the target.',
    params: [P('target', 'Peak', -24, 0, -1, 'db', { env: false })],
    run(I, P_) { const pk = D.peakAll(I[0].ch) || 1, gn = D.dbToGain(P_.v('target')) / pk; return I[0].ch.map(x => x.map(v => v * gn)); }
  });

  D.def({
    id: 'ed.gain', family: 'edit', name: 'Gain',
    desc: 'Turns the level up or down.',
    params: [P('gain', 'Gain', -48, 24, -6, 'db')],
    run(I, P_) { const sr = I[0].sr; return I[0].ch.map(x => { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * D.dbToGain(P_.v('gain', i / sr)); return y; }); }
  });

  D.def({
    id: 'ed.fade', family: 'edit', name: 'Fade in / out',
    desc: 'Fades the start and end.',
    params: [P('in', 'Fade in', 0, 20, 0.05, 'sec', { curve: 'pow', pow: 2, env: false }), P('out', 'Fade out', 0, 20, 0.5, 'sec', { curve: 'pow', pow: 2, env: false })],
    choices: [C('shape', 'Curve', ['Smooth', 'Linear', 'Exponential'], 'Smooth')],
    run(I, P_) {
      const sr = I[0].sr, fi = P_.v('in') * sr, fo = P_.v('out') * sr, sh = P_.c('shape');
      const cv = (p) => sh === 'Linear' ? p : sh === 'Exponential' ? p * p * p : 0.5 - 0.5 * Math.cos(Math.PI * p);
      return I[0].ch.map(x => { const y = x.slice(), n = y.length; for (let i = 0; i < n; i++) { let e = 1; if (i < fi) e *= cv(i / fi); if (i > n - fo) e *= cv((n - i) / fo); y[i] *= e; } return y; });
    }
  });

  D.def({
    id: 'ed.trim', family: 'edit', name: 'Trim silence',
    desc: 'Cuts away near-silence at the start and end.',
    params: [P('thresh', 'Threshold', -90, -10, -50, 'db', { env: false }), P('pad', 'Keep extra', 0, 0.5, 0.01, 'ms', { env: false })],
    run(I, P_) {
      const m = D.mono(I[0]), th = D.dbToGain(P_.v('thresh')) * (D.peak(m) || 1), pad = Math.round(P_.v('pad') * I[0].sr);
      let a = 0, b = m.length; while (a < b && Math.abs(m[a]) < th) a++; while (b > a && Math.abs(m[b - 1]) < th) b--;
      a = Math.max(0, a - pad); b = Math.min(m.length, b + pad);
      return I[0].ch.map(x => D.declick(x.slice(a, Math.max(a + 64, b)), 32));
    }
  });

  D.def({
    id: 'ed.join', family: 'edit', name: 'Join (A then B)',
    desc: 'Splices sound B onto the end of sound A, with a crossfade or a gap.',
    inputs: 2,
    params: [P('xfade', 'Crossfade', 0, 5, 0.02, 'sec', { curve: 'pow', pow: 2, env: false }), P('gap', 'Gap', 0, 10, 0, 'sec', { env: false })],
    run(I, P_) {
      const sr = I[0].sr, xf = Math.round(P_.v('xfade') * sr), gap = Math.round(P_.v('gap') * sr);
      const nCh = Math.max(I[0].ch.length, I[1].ch.length);
      const out = [];
      for (let c = 0; c < nCh; c++) {
        const a = I[0].ch[Math.min(c, I[0].ch.length - 1)], b = I[1].ch[Math.min(c, I[1].ch.length - 1)];
        const f = gap > 0 ? 0 : Math.min(xf, a.length, b.length);
        const y = new Float32Array(a.length + gap + b.length - f);
        for (let i = 0; i < a.length; i++) y[i] = a[i] * (i > a.length - f ? (a.length - i) / f : 1);
        const o = a.length + gap - f;
        for (let i = 0; i < b.length; i++) y[o + i] += b[i] * (i < f ? i / f : 1);
        out.push(y);
      }
      return out;
    }
  });

  D.def({
    id: 'ed.mix', family: 'edit', name: 'Mix (A with B)',
    desc: 'Layers sound B over sound A, starting at any point.',
    inputs: 2,
    params: [P('offset', 'B starts at', 0, 120, 0, 'sec', { env: false }), P('la', 'Level A', -48, 12, 0, 'db'), P('lb', 'Level B', -48, 12, -3, 'db')],
    run(I, P_) {
      const sr = I[0].sr, off = Math.round(P_.v('offset') * sr), nCh = Math.max(I[0].ch.length, I[1].ch.length);
      const out = [];
      for (let c = 0; c < nCh; c++) {
        const a = I[0].ch[Math.min(c, I[0].ch.length - 1)], b = I[1].ch[Math.min(c, I[1].ch.length - 1)];
        const y = new Float32Array(Math.max(a.length, off + b.length));
        for (let i = 0; i < a.length; i++) y[i] = a[i] * D.dbToGain(P_.v('la', i / sr));
        for (let i = 0; i < b.length; i++) y[off + i] += b[i] * D.dbToGain(P_.v('lb', (off + i) / sr));
        out.push(y);
      }
      return out;
    }
  });

  D.def({
    id: 'ed.channels', family: 'edit', name: 'Channels & width',
    desc: 'Makes the sound mono or stereo, swaps left and right, or narrows and widens the stereo image.',
    params: [P('width', 'Width', 0, 2, 1.4, 'pct')],
    choices: [C('mode', 'Do', ['Set stereo width', 'Make mono', 'Make stereo from mono', 'Swap left and right'], 'Set stereo width')],
    run(I, P_) {
      const mode = P_.c('mode'), ch = I[0].ch, sr = I[0].sr;
      if (mode === 'Make mono') return [D.mono(I[0])];
      if (mode === 'Swap left and right') return ch.length > 1 ? [ch[1], ch[0]] : [ch[0], ch[0].slice()];
      let L = ch[0], R = ch.length > 1 ? ch[1] : ch[0];
      if (mode === 'Make stereo from mono' || ch.length === 1) {
        // decorrelate with two short, different all-pass style delays
        const m = D.mono(I[0]), d1 = Math.round(0.011 * sr), d2 = Math.round(0.017 * sr);
        L = new Float32Array(m.length); R = new Float32Array(m.length);
        for (let i = 0; i < m.length; i++) { const a = m[i - d1] || 0, b = m[i - d2] || 0; L[i] = m[i] + 0.35 * a - 0.2 * b; R[i] = m[i] - 0.35 * a + 0.2 * b; }
        if (mode === 'Make stereo from mono') return [L, R];
      }
      const yL = new Float32Array(L.length), yR = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) { const w = P_.v('width', i / sr), m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5 * w; yL[i] = m + s; yR[i] = m - s; }
      return [yL, yR];
    }
  });
}); })(typeof self !== 'undefined' ? self : this);
