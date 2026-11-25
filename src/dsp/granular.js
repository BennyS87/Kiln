// Kiln - granular, texture and segment processes, after CDP's MODIFY BRASSAGE, TEXTURE, GRAIN and EXTEND families.
(function (g) { (g.KilnDSPModules = g.KilnDSPModules || []).push(function granular(D) {
  const { P, C } = D;
  const WINDOW = () => C('window', 'Grain shape', ['Smooth', 'Triangle', 'Percussive', 'Square'], 'Smooth');
  const winKey = (c) => ({ Smooth: 'hann', Triangle: 'tri', Percussive: 'perc', Square: 'rect' }[c] || 'hann');
  const panGains = (p) => { const a = (D.clamp(p, -1, 1) + 1) * Math.PI / 4; return [Math.cos(a), Math.sin(a)]; };

  // add a resampled, windowed, panned grain from src channels into stereo out arrays
  function grain(src, sr, out, startOut, startIn, lenOut, ratio, reverse, gain, pan, shape) {
    const [gl, gr] = panGains(pan), L = out[0], R = out[1], n = src[0].length;
    const s0 = src[0], s1 = src.length > 1 ? src[1] : src[0];
    const stereoIn = src.length > 1;
    for (let i = 0; i < lenOut; i++) {
      const o = startOut + i; if (o >= L.length) break;
      const w = D.win(i / lenOut, shape) * gain;
      if (w === 0) continue;
      const p = reverse ? startIn + (lenOut - 1 - i) * ratio : startIn + i * ratio;
      if (p < 0 || p >= n - 1) continue;
      const a = D.read(s0, p) * w, b = stereoIn ? D.read(s1, p) * w : a;
      if (stereoIn) { L[o] += a * Math.min(1, gl * 1.414); R[o] += b * Math.min(1, gr * 1.414); }
      else { L[o] += a * gl; R[o] += a * gr; }
    }
  }

  D.def({
    id: 'gr.brassage', family: 'granular', name: 'Brassage (granulator)',
    desc: 'Rebuilds the sound from thousands of tiny overlapping grains. Slow the read speed to stretch it, scatter the grains in time, pitch and space, or freeze on one spot.',
    params: [
      P('size', 'Grain size', 0.004, 0.6, 0.06, 'ms', { curve: 'log' }), P('density', 'Density', 0.5, 24, 4, 'x', { curve: 'log' }),
      P('speed', 'Read speed', -4, 4, 0.5, 'x'), P('pitch', 'Pitch', -24, 24, 0, 'st'), P('pscat', 'Pitch scatter', 0, 24, 0.3, 'st'),
      P('tscat', 'Time scatter', 0, 2, 0.05, 'sec', { curve: 'pow', pow: 2 }), P('ascat', 'Level scatter', 0, 1, 0.2, 'pct'), P('spread', 'Stereo spread', 0, 1, 0.6, 'pct'),
      P('rev', 'Reversed grains', 0, 1, 0, 'pct'), P('length', 'Output length', 0.1, 32, 2, 'x', { curve: 'log', env: false }), D.SEED()
    ],
    choices: [WINDOW(), C('edge', 'At the ends', ['Wrap around', 'Bounce', 'Stop'], 'Wrap around')],
    run(I, P_, U) {
      const A = I[0], sr = A.sr, r = U.rng, shape = winKey(P_.c('window')), edge = P_.c('edge');
      const outLen = Math.max(64, Math.round(A.len * P_.v('length')));
      const out = [new Float32Array(outLen), new Float32Array(outLen)];
      let pos = 0, dir = 1, t = 0, nextProg = 0;
      const envT = (o) => o / outLen * A.dur; // curves are drawn against the source, stretched over the result
      let stopped = false;
      while (t < outLen && !stopped) {
        const te = envT(t), size = Math.max(16, P_.v('size', te) * sr), dens = Math.max(0.1, P_.v('density', te));
        const hop = Math.max(4, size / dens);
        const ratio = D.st(P_.v('pitch', te) + r.bi() * P_.v('pscat', te));
        const inPos = pos * sr + r.bi() * P_.v('tscat', te) * sr;
        const lvl = 1 - r() * P_.v('ascat', te);
        grain(A.ch, sr, out, Math.round(t + r() * hop * 0.3), inPos, Math.round(size), ratio, r() < P_.v('rev', te), lvl / Math.sqrt(dens) * 1.2, r.bi() * P_.v('spread', te), shape);
        t += hop;
        pos += dir * P_.v('speed', te) * hop / sr;
        if (pos >= A.dur || pos < 0) {
          if (edge === 'Stop') stopped = true;
          else if (edge === 'Bounce') { dir = -dir; pos = D.clamp(pos, 0, A.dur - 1e-3); }
          else pos = ((pos % A.dur) + A.dur) % A.dur;
        }
        if (t > nextProg) { U.progress(t / outLen); nextProg += outLen / 50; }
      }
      if (stopped) { const n = Math.min(outLen, Math.round(t + 0.6 * sr)); return [out[0].slice(0, n), out[1].slice(0, n)]; }
      return out;
    }
  });

  D.def({
    id: 'gr.texture', family: 'granular', name: 'Texture cloud',
    desc: 'Scatters many pitched copies of the sound (or short slices of it) across time and space, quantised to a scale if you like: from sparse droplets to dense swarms.',
    params: [
      P('dur', 'Length', 1, 120, 12, 'sec', { curve: 'log', env: false }), P('density', 'Events per second', 0.2, 200, 6, 'num', { curve: 'log' }),
      P('lo', 'Lowest pitch', -36, 36, -5, 'st'), P('hi', 'Highest pitch', -36, 36, 7, 'st'),
      P('evlen', 'Event length', 0, 4, 0, 'sec', { curve: 'pow', pow: 2 }), P('ascat', 'Level scatter', 0, 30, 8, 'db'), P('spread', 'Stereo spread', 0, 1, 0.8, 'pct'),
      P('attack', 'Attack', 0.001, 1, 0.005, 'ms', { curve: 'log', env: false }), D.SEED()
    ],
    choices: [C('scale', 'Pitches', ['Any', 'Chromatic', 'Major', 'Minor', 'Pentatonic', 'Whole tone', 'Fifths', 'Root only'], 'Pentatonic'), C('src', 'Each event plays', ['Whole sound', 'A random slice'], 'Whole sound')],
    run(I, P_, U) {
      const A = I[0], sr = A.sr, r = U.rng, outLen = Math.round(P_.v('dur') * sr);
      const out = [new Float32Array(outLen), new Float32Array(outLen)];
      const sc = P_.c('scale') === 'Any' ? null : D.SCALES[P_.c('scale')] || D.SCALES.Chromatic;
      const slice = P_.c('src') === 'A random slice';
      const att = P_.v('attack');
      let t = 0, events = 0;
      while (t < outLen && events < 20000) {
        const te = t / outLen * A.dur;
        const lo = P_.v('lo', te), hi = Math.max(lo, P_.v('hi', te));
        let st = lo + r() * (hi - lo);
        if (sc) { const oct = Math.floor(st / 12), deg = st - oct * 12; let best = sc[0], bd = 99; for (const s of sc.concat([12])) { const d = Math.abs(s - deg); if (d < bd) { bd = d; best = s; } } st = oct * 12 + best; if (st > hi + 0.5) st -= 12; if (st < lo - 0.5) st += 12; }
        const ratio = D.st(st);
        const el = P_.v('evlen', te);
        let inStart = 0, inLen = A.len;
        if (slice) { inLen = Math.max(256, Math.round((el > 0 ? el : 0.25) * sr * ratio)); inStart = r() * Math.max(1, A.len - inLen); }
        else if (el > 0) inLen = Math.min(A.len, Math.round(el * sr * ratio));
        const lenOut = Math.max(32, Math.floor(inLen / ratio));
        const gain = D.dbToGain(-r() * P_.v('ascat', te)) * 0.7;
        const [gl, gr] = panGains(r.bi() * P_.v('spread', te));
        const s0 = A.ch[0], s1 = A.ch[A.ch.length > 1 ? 1 : 0], aN = Math.max(1, att * sr), rN = Math.min(lenOut * 0.3, 0.02 * sr);
        const t0 = Math.round(t);
        for (let i = 0; i < lenOut; i++) {
          const o = t0 + i; if (o >= outLen) break;
          let e = i < aN ? i / aN : 1; if (i > lenOut - rN) e *= (lenOut - i) / rN;
          const p = inStart + i * ratio;
          out[0][o] += D.read(s0, p) * e * gain * gl; out[1][o] += D.read(s1, p) * e * gain * gr;
        }
        events++;
        const dens = Math.max(0.05, P_.v('density', te));
        t += (-Math.log(1 - r() * 0.999) / dens) * sr; // Poisson spacing
        U.progress(t / outLen);
      }
      return out;
    }
  });

  // crossfaded copy of x[a..b) into out (an Out), optionally reversed
  function pushSeg(out, x, a, b, rev, fade, gain) {
    const L = b - a, f = Math.min(fade, L >> 1), gn = gain == null ? 1 : gain;
    for (let i = 0; i < L; i++) { let e = gn; if (i < f) e *= i / f; else if (i > L - f) e *= (L - i) / f; out.push((rev ? x[b - 1 - i] : x[a + i]) * e); }
  }
  const SENS = () => P('sens', 'Sensitivity', 0, 1, 0.6, 'pct', { env: false });
  const GAP = () => P('gap', 'Shortest grain', 0.01, 1, 0.06, 'ms', { curve: 'log', env: false });

  D.def({
    id: 'gr.reverse', family: 'granular', name: 'Grain reverse',
    desc: 'Finds the separate hits and syllables in the sound, then reverses each one in place, reverses their order, or both.',
    params: [SENS(), GAP()],
    choices: [C('mode', 'Reverse', ['Each grain in place', 'Order of the grains', 'Both'], 'Each grain in place')],
    run(I, P_) {
      const segs = D.segments(D.mono(I[0]), I[0].sr, P_.v('sens'), P_.v('gap'));
      const mode = P_.c('mode'), inPlace = mode !== 'Order of the grains', order = mode !== 'Each grain in place';
      const list = order ? segs.slice().reverse() : segs;
      return D.perCh(I, (x) => { const out = D.Out(x.length); for (const [a, b] of list) pushSeg(out, x, a, b, inPlace, 48); return out.result(); });
    }
  });

  D.def({
    id: 'gr.repeat', family: 'granular', name: 'Grain repeat',
    desc: 'Finds the separate hits and syllables and repeats each one, with optional fading and random counts: an instant stutter edit.',
    params: [SENS(), GAP(), P('repeats', 'Repeats', 1, 16, 2, 'int', { step: 1 }), P('scatter', 'Random extra', 0, 8, 0, 'int', { step: 1 }), P('decay', 'Fade per repeat', 0, 12, 1.5, 'db'), P('trim', 'Repeat length', 0.05, 1, 1, 'pct'), D.SEED()],
    run(I, P_, U) {
      const segs = D.segments(D.mono(I[0]), I[0].sr, P_.v('sens'), P_.v('gap'));
      const counts = segs.map(([a]) => { const t = a / I[0].sr; return Math.max(1, P_.i('repeats', t) + U.rng.int(P_.i('scatter', t) + 1)); });
      return D.perCh(I, (x) => {
        const out = D.Out(x.length * 2);
        segs.forEach(([a, b], si) => {
          const t = a / I[0].sr, n = counts[si], dk = D.dbToGain(-P_.v('decay', t)), L = Math.max(64, Math.round((b - a) * P_.v('trim', t)));
          for (let k = 0; k < n; k++) pushSeg(out, x, a, k === n - 1 ? b : Math.min(b, a + L), false, 32, Math.pow(dk, k));
        });
        return out.result();
      });
    }
  });

  D.def({
    id: 'gr.shred', family: 'granular', name: 'Shred',
    desc: 'Cuts the sound at random points and shuffles the pieces, again and again. The length stays the same but the order dissolves.',
    params: [P('pieces', 'Pieces', 2, 400, 24, 'int', { curve: 'log', step: 1, env: false }), P('passes', 'Passes', 1, 16, 2, 'int', { step: 1, env: false }), P('fade', 'Crossfade', 0.001, 0.05, 0.004, 'ms', { curve: 'log', env: false }), D.SEED()],
    run(I, P_, U) {
      const len = I[0].len, n = Math.max(2, P_.i('pieces')), fade = Math.round(P_.v('fade') * I[0].sr);
      let order = [[0, len]];
      for (let p = 0; p < P_.i('passes'); p++) {
        // flatten current mapping into a list of source spans, cut at random points, shuffle
        const cuts = new Set([0, len]); for (let i = 0; i < n - 1; i++) cuts.add(Math.floor(U.rng() * len));
        const cs = [...cuts].sort((a, b) => a - b);
        const pieces = []; for (let i = 0; i + 1 < cs.length; i++) if (cs[i + 1] - cs[i] > 8) pieces.push([cs[i], cs[i + 1]]);
        U.rng.shuffle(pieces);
        // map pieces of the current output back to source spans
        const next = [];
        for (const [a, b] of pieces) { let acc = 0; for (const [sa, sb] of order) { const L = sb - sa, o0 = acc, o1 = acc + L; const lo = Math.max(a, o0), hi = Math.min(b, o1); if (hi > lo) next.push([sa + lo - o0, sa + hi - o0]); acc = o1; } }
        order = next;
      }
      return D.perCh(I, (x) => { const out = D.Out(len); for (const [a, b] of order) pushSeg(out, x, a, b, false, fade); return out.result(); });
    }
  });

  D.def({
    id: 'gr.scramble', family: 'granular', name: 'Scramble',
    desc: 'Builds a new sound of any length out of random slices taken from anywhere in the original, or drifting slowly through it.',
    params: [P('dur', 'Length', 0.5, 120, 10, 'sec', { curve: 'log', env: false }), P('min', 'Shortest slice', 0.005, 2, 0.05, 'ms', { curve: 'log' }), P('max', 'Longest slice', 0.01, 4, 0.3, 'ms', { curve: 'log' }), P('drift', 'Drift range', 0, 1, 0.1, 'pct'), D.SEED()],
    choices: [C('mode', 'Taken from', ['Anywhere', 'Drifting through the sound'], 'Anywhere')],
    run(I, P_, U) {
      const A = I[0], sr = A.sr, outLen = Math.round(P_.v('dur') * sr), drift = P_.c('mode') !== 'Anywhere';
      const spans = []; let t = 0;
      while (t < outLen) {
        const te = t / outLen * A.dur, lo = P_.v('min', te), hi = Math.max(lo, P_.v('max', te));
        const L = Math.max(32, Math.round((lo + U.rng() * (hi - lo)) * sr));
        let a;
        if (drift) { const centre = t / outLen * A.len, w = P_.v('drift', te) * A.len; a = Math.round(D.clamp(centre + U.rng.bi() * w, 0, Math.max(0, A.len - L))); }
        else a = Math.round(U.rng() * Math.max(0, A.len - L));
        spans.push([a, Math.min(A.len, a + L)]); t += L;
      }
      return D.perCh(I, (x) => { const out = D.Out(outLen); for (const [a, b] of spans) pushSeg(out, x, a, b, false, 48); return out.result().subarray(0, outLen); });
    }
  });

  D.def({
    id: 'gr.iterate', family: 'granular', name: 'Iterate',
    desc: 'Plays the sound over and over with small random changes to timing, pitch and level each time, building a long, overlapping, evolving repetition.',
    params: [P('count', 'Repeats', 2, 200, 16, 'int', { curve: 'log', step: 1, env: false }), P('delay', 'Time between', 0.01, 10, 0.4, 'sec', { curve: 'log' }), P('tscat', 'Timing scatter', 0, 1, 0.3, 'pct'), P('pscat', 'Pitch scatter', 0, 12, 0.5, 'st'), P('drift', 'Pitch drift', -12, 12, 0, 'st', { env: false }), P('decay', 'Fade per repeat', 0, 6, 0.2, 'db', { env: false }), P('spread', 'Stereo spread', 0, 1, 0.4, 'pct'), D.SEED()],
    run(I, P_, U) {
      const A = I[0], sr = A.sr, n = P_.i('count'), r = U.rng;
      const starts = []; let t = 0;
      for (let k = 0; k < n; k++) { starts.push(t); const te = Math.min(A.dur, k / n * A.dur), d = P_.v('delay', te); t += Math.max(0.002, d * (1 + r.bi() * P_.v('tscat', te))) * sr; }
      const maxRatio = D.st(-Math.abs(P_.v('drift')) - 12);
      const total = Math.round(starts[starts.length - 1] + A.len / Math.max(0.25, maxRatio) + 16);
      const out = [new Float32Array(total), new Float32Array(total)];
      starts.forEach((s0, k) => {
        const te = k / n * A.dur, ratio = D.st(r.bi() * P_.v('pscat', te) + P_.v('drift') * k / Math.max(1, n - 1));
        const gain = Math.pow(D.dbToGain(-P_.v('decay')), k) * 0.6, [gl, gr] = panGains(r.bi() * P_.v('spread', te));
        const L = Math.floor(A.len / ratio), c0 = A.ch[0], c1 = A.ch[A.ch.length > 1 ? 1 : 0];
        for (let i = 0; i < L; i++) { const o = Math.round(s0) + i; if (o >= total) break; const p = i * ratio; out[0][o] += D.read(c0, p) * gain * gl * 1.414; out[1][o] += D.read(c1, p) * gain * gr * 1.414; }
        U.progress(k / n);
      });
      let end = total; while (end > 1 && Math.abs(out[0][end - 1]) < 1e-6 && Math.abs(out[1][end - 1]) < 1e-6) end--;
      return [out[0].slice(0, end), out[1].slice(0, end)];
    }
  });

  D.def({
    id: 'gr.stutter', family: 'granular', name: 'Stutter (vocal chop)',
    desc: 'Chops speech or singing at its syllables, then strings random syllables together with repeats and gaps: CDP Release 8\'s vocal chopping and repetition.',
    params: [SENS(), GAP(), P('dur', 'Length', 0.5, 120, 8, 'sec', { curve: 'log', env: false }), P('maxlen', 'Longest chop', 0.03, 2, 0.25, 'ms', { curve: 'log' }), P('repeats', 'Most repeats', 1, 12, 4, 'int', { step: 1 }), P('silence', 'Gaps', 0, 1, 0.15, 'pct'), P('order', 'Keep order', 0, 1, 0.4, 'pct'), D.SEED()],
    run(I, P_, U) {
      const A = I[0], sr = A.sr, r = U.rng, outLen = Math.round(P_.v('dur') * sr);
      const segs = D.segments(D.mono(A), sr, P_.v('sens'), P_.v('gap'));
      const plan = []; let t = 0, cur = 0;
      while (t < outLen && plan.length < 50000) {
        const te = t / outLen * A.dur;
        cur = r() < P_.v('order', te) ? (cur + 1) % segs.length : r.int(segs.length);
        const [a, b] = segs[cur], L = Math.min(b - a, Math.max(64, Math.round(P_.v('maxlen', te) * sr)));
        const reps = 1 + r.int(Math.max(1, P_.i('repeats', te)));
        for (let k = 0; k < reps; k++) { plan.push([a, a + L]); t += L; }
        if (r() < P_.v('silence', te)) { const gap = Math.round(L * (0.5 + r() * 1.5)); plan.push([-1, gap]); t += gap; }
      }
      return D.perCh(I, (x) => { const out = D.Out(outLen); for (const [a, b] of plan) { if (a < 0) out.silence(b); else pushSeg(out, x, a, b, false, 40); } return out.result().subarray(0, outLen); });
    }
  });
}); })(typeof self !== 'undefined' ? self : this);
