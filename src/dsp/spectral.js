// Kiln - spectral (phase vocoder) processes, after CDP's PVOC / spec / blur / combine families.
(function (g) { (g.KilnDSPModules = g.KilnDSPModules || []).push(function spectral(D) {
  const { P, C } = D;
  const FFT = D.FFT_CHOICE;

  // analyse each channel, let fn build a new list of frames, resynthesise
  function pv(I, P_, U, fn, keepLen) {
    const N = parseInt(P_.c('fftsize') || '2048', 10);
    return D.perCh(I, (x, c) => {
      const prog = (a) => U.progress((c + a) / I.ch.length);
      const an = D.pvAnalyse(x, I.sr, N, 8, f => prog(f * 0.4));
      const frames = fn(an, c, f => prog(0.4 + f * 0.2));
      return D.pvSynth(an, frames, keepLen ? x.length : null, f => prog(0.6 + f * 0.4));
    });
  }
  // analyse input B to match input A's settings
  function pvB(I, P_, c) {
    const N = parseInt(P_.c('fftsize') || '2048', 10);
    const B = I[1]; const x = B.ch[Math.min(c, B.ch.length - 1)];
    return D.pvAnalyse(x, I[0].sr, N, 8);
  }
  const bFrame = (P_, anA, anB, f) => {
    const nB = anB.frames.length;
    const k = P_.c('btime') === 'Stretch to fit A' ? Math.round(f * (nB - 1) / Math.max(1, anA.frames.length - 1)) : Math.min(f, nB - 1);
    return anB.frames[k];
  };
  const BTIME = () => C('btime', 'Timing of B', ['Stretch to fit A', 'As it is'], 'Stretch to fit A');

  // move partials by a frequency ratio (used for transposition)
  function transpose(fr, ratio, binHz) {
    const n = fr.amp.length, out = D.blankFrame(n);
    for (let k = 0; k < n; k++) {
      const a = fr.amp[k]; if (a <= 1e-9) continue;
      const nf = fr.freq[k] * ratio, nk = Math.round(nf / binHz);
      if (nk <= 0 || nk >= n) continue;
      if (a > out.amp[nk]) out.freq[nk] = nf;
      out.amp[nk] += a;
    }
    return out;
  }
  const lerp = (a, b, t) => a + (b - a) * t;
  function mixFrames(a, b, t) {
    const n = a.amp.length, o = D.blankFrame(n);
    for (let k = 0; k < n; k++) { o.amp[k] = lerp(a.amp[k], b.amp[k], t); o.freq[k] = lerp(a.freq[k], b.freq[k], t); }
    return o;
  }

  D.def({
    id: 'spec.blur', family: 'spectral', name: 'Blur',
    desc: 'Averages the spectrum over a number of analysis windows, so detail and attack melt into a soft, smeared version of the sound.',
    params: [P('windows', 'Blur', 1, 200, 24, 'int', { curve: 'log', step: 1 })],
    choices: [FFT()],
    run(I, P_, U) {
      return pv(I, P_, U, (an, c, prog) => {
        const F = an.frames, nF = F.length, bins = an.bins;
        // prefix sums per bin for amp and amp-weighted frequency
        const SA = new Float64Array((nF + 1) * bins), SF = new Float64Array((nF + 1) * bins);
        for (let f = 0; f < nF; f++) for (let k = 0; k < bins; k++) { const a = F[f].amp[k]; SA[(f + 1) * bins + k] = SA[f * bins + k] + a; SF[(f + 1) * bins + k] = SF[f * bins + k] + a * F[f].freq[k]; }
        const out = new Array(nF);
        for (let f = 0; f < nF; f++) {
          const W = Math.max(1, P_.i('windows', D.pvTime(an, f)));
          const a = Math.max(0, f - (W >> 1)), b = Math.min(nF, a + W), n = b - a;
          const fr = D.blankFrame(bins);
          for (let k = 0; k < bins; k++) { const sa = SA[b * bins + k] - SA[a * bins + k]; fr.amp[k] = sa / n; fr.freq[k] = sa > 1e-12 ? (SF[b * bins + k] - SF[a * bins + k]) / sa : F[f].freq[k]; }
          out[f] = fr; if ((f & 63) === 0) prog(f / nF);
        }
        return out;
      }, true);
    }
  });

  D.def({
    id: 'spec.smear', family: 'spectral', name: 'Smear',
    desc: 'Each moment of the spectrum lingers and fades into the next, like a spectral sustain pedal. Draw a curve to smear only some passages.',
    params: [P('amount', 'Smear', 0, 0.999, 0.9, 'pct', { curve: 'pow', pow: 0.35 }), P('decay', 'Bright decay', 0, 1, 0.3, 'pct')],
    choices: [FFT()],
    run(I, P_, U) {
      return D.spectral(I, P_, U, (fr, t, f, an, st) => {
        if (!st.h) { st.h = D.copyFrame(fr); return fr; }
        const a = P_.v('amount', t), dk = P_.v('decay', t), h = st.h, n = fr.amp.length;
        for (let k = 0; k < n; k++) {
          const ak = Math.min(0.9995, a * (1 - dk * 0.5 * k / n));
          if (fr.amp[k] > h.amp[k]) { h.amp[k] = fr.amp[k]; h.freq[k] = fr.freq[k]; }
          else { h.amp[k] = h.amp[k] * ak + fr.amp[k] * (1 - ak); h.freq[k] = fr.amp[k] > h.amp[k] * 0.5 ? fr.freq[k] : h.freq[k]; }
        }
        return D.copyFrame(h);
      });
    }
  });

  D.def({
    id: 'spec.hold', family: 'spectral', name: 'Freeze & hold',
    desc: 'Freezes the spectrum at one moment and holds it as a steady drone, with optional shimmer, then carries on with the rest of the sound or stops.',
    params: [
      P('at', 'Freeze at', 0, 60, 0.5, 'sec', { env: false }), P('hold', 'Hold for', 0.1, 60, 4, 'sec', { curve: 'log', env: false }),
      P('fade', 'Crossfade', 0, 2, 0.15, 'sec', { env: false }), P('drift', 'Shimmer', 0, 1, 0.2, 'pct', { env: false }), D.SEED()
    ],
    choices: [C('after', 'Afterwards', ['Carry on', 'Stop after the hold', 'Hold only'], 'Carry on'), FFT()],
    run(I, P_, U) {
      return pv(I, P_, U, (an, c) => {
        const F = an.frames, nF = F.length, hopS = an.hop / an.sr;
        const fAt = D.clamp(Math.round((P_.v('at') * an.sr + an.N / 2) / an.hop), 0, nF - 1);
        const nHold = Math.max(1, Math.round(P_.v('hold') / hopS)), nFade = Math.max(1, Math.round(P_.v('fade') / hopS));
        const drift = P_.v('drift'), r = D.rng(P_.i('seed') + c * 101);
        const base = D.copyFrame(F[fAt]);
        const lfo = new Float32Array(an.bins), rate = new Float32Array(an.bins);
        for (let k = 0; k < an.bins; k++) { lfo[k] = r() * Math.PI * 2; rate[k] = 0.02 + r() * 0.12; }
        const out = [];
        const mode = P_.c('after');
        if (mode !== 'Hold only') for (let f = 0; f < fAt; f++) out.push(F[f]);
        for (let h = 0; h < nHold; h++) {
          const fr = D.blankFrame(an.bins);
          for (let k = 0; k < an.bins; k++) {
            const m = 1 + drift * 0.8 * Math.sin(lfo[k] + h * rate[k]);
            fr.amp[k] = base.amp[k] * m; fr.freq[k] = base.freq[k] * (1 + drift * 0.002 * Math.sin(lfo[k] * 1.7 + h * rate[k] * 0.6));
          }
          // crossfade into the hold from the live sound
          const live = F[Math.min(nF - 1, fAt + h)];
          if (mode !== 'Hold only' && h < nFade) out.push(mixFrames(live, fr, h / nFade)); else out.push(fr);
        }
        if (mode === 'Carry on') {
          for (let f = fAt, j = 0; f < nF; f++, j++) out.push(j < nFade ? mixFrames(out[out.length - 1], F[f], j / nFade) : F[f]);
        } else {
          const lastF = out[out.length - 1];
          for (let j = 1; j <= nFade * 2; j++) { const fr = D.copyFrame(lastF); const gn = 1 - j / (nFade * 2); for (let k = 0; k < an.bins; k++) fr.amp[k] *= gn; out.push(fr); }
        }
        return out;
      }, false);
    }
  });

  D.def({
    id: 'spec.stretch', family: 'spectral', name: 'Time stretch (spectral)',
    desc: 'Slows down or speeds up without changing pitch. Huge stretches turn a sound into a slowly evolving landscape. Draw a curve to vary the speed.',
    params: [P('factor', 'Stretch', 0.1, 64, 4, 'x', { curve: 'log' })],
    choices: [FFT(), C('phase', 'Character', ['Clean', 'Diffuse'], 'Clean')],
    run(I, P_, U) {
      return pv(I, P_, U, (an, c) => {
        const F = an.frames, nF = F.length, out = [];
        const diffuse = P_.c('phase') === 'Diffuse', r = D.rng(7 + c);
        let pos = 0;
        while (pos < nF - 1 && out.length < 200000) {
          const t = D.pvTime(an, pos);
          const i = Math.floor(pos), fr = mixFrames(F[i], F[Math.min(nF - 1, i + 1)], pos - i);
          if (diffuse) for (let k = 0; k < an.bins; k++) fr.freq[k] += (r() - 0.5) * (an.sr / an.N) * 0.6;
          out.push(fr);
          pos += 1 / Math.max(0.01, P_.v('factor', t));
        }
        return out;
      }, false);
    }
  });

  D.def({
    id: 'spec.pitch', family: 'spectral', name: 'Transpose (spectral)',
    desc: 'Shifts pitch without changing length. Keep formants to stop voices and instruments turning into chipmunks or giants.',
    params: [P('shift', 'Transpose', -36, 36, 7, 'st'), P('fine', 'Fine', -100, 100, 0, 'cents')],
    choices: [C('formants', 'Formants', ['Keep', 'Move with pitch'], 'Keep'), FFT()],
    run(I, P_, U) {
      const keep = P_.c('formants') === 'Keep';
      return D.spectral(I, P_, U, (fr, t, f, an) => {
        const ratio = D.st(P_.v('shift', t) + P_.v('fine', t) / 100), binHz = an.sr / an.N;
        if (!keep) return transpose(fr, ratio, binHz);
        const env = D.specEnvelope(fr.amp, 12);
        const flat = { amp: new Float32Array(fr.amp.length), freq: fr.freq };
        for (let k = 0; k < fr.amp.length; k++) flat.amp[k] = fr.amp[k] / env[k];
        const o = transpose(flat, ratio, binHz);
        for (let k = 0; k < o.amp.length; k++) o.amp[k] *= env[k];
        return o;
      });
    }
  });

  D.def({
    id: 'spec.formant', family: 'spectral', name: 'Formant shift',
    desc: 'Moves the resonances (the vowel, the body of the instrument) up or down while the pitch stays put.',
    params: [P('shift', 'Formants', -24, 24, -5, 'st'), P('detail', 'Envelope detail', 2, 60, 12, 'int', { step: 1, env: false })],
    choices: [FFT()],
    run(I, P_, U) {
      return D.spectral(I, P_, U, (fr, t) => {
        const ratio = D.st(P_.v('shift', t)), n = fr.amp.length;
        const env = D.specEnvelope(fr.amp, P_.v('detail'));
        const o = { amp: new Float32Array(n), freq: fr.freq };
        for (let k = 0; k < n; k++) { const src = k / ratio, j = Math.floor(src), fj = src - j; const e2 = j + 1 < n ? env[j] + (env[j + 1] - env[j]) * fj : env[n - 1] * 0.2; o.amp[k] = fr.amp[k] / env[k] * e2; }
        return o;
      });
    }
  });

  D.def({
    id: 'spec.trace', family: 'spectral', name: 'Trace partials',
    desc: 'Keeps only the loudest few partials in each moment and throws the rest away: a sound boiled down to its skeleton, often glassy or whistling.',
    params: [P('count', 'Partials kept', 1, 512, 12, 'int', { curve: 'log', step: 1 })],
    choices: [FFT()],
    run(I, P_, U) {
      return D.spectral(I, P_, U, (fr, t) => {
        const n = Math.max(1, P_.i('count', t)), s = Float32Array.from(fr.amp).sort();
        const th = s[Math.max(0, s.length - n)];
        const o = { amp: new Float32Array(fr.amp.length), freq: fr.freq };
        for (let k = 0; k < fr.amp.length; k++) if (fr.amp[k] >= th && fr.amp[k] > 0) o.amp[k] = fr.amp[k];
        return o;
      });
    }
  });

  D.def({
    id: 'spec.gate', family: 'spectral', name: 'Spectral clean / residue',
    desc: 'Splits each moment into its strong partials and its quiet noisy residue. Keep the partials to clean a sound up, or keep only the residue for breath and hiss.',
    params: [P('thresh', 'Threshold', -90, 0, -40, 'db'), P('soft', 'Softness', 0, 24, 6, 'db', { env: false })],
    choices: [C('keep', 'Keep', ['Above threshold (clean)', 'Below threshold (residue)'], 'Above threshold (clean)'), FFT()],
    run(I, P_, U) {
      const above = P_.c('keep').startsWith('Above');
      return D.spectral(I, P_, U, (fr, t) => {
        let m = 0; for (let k = 0; k < fr.amp.length; k++) if (fr.amp[k] > m) m = fr.amp[k];
        const th = m * D.dbToGain(P_.v('thresh', t)), soft = Math.max(1.0001, D.dbToGain(P_.v('soft')));
        const o = { amp: new Float32Array(fr.amp.length), freq: fr.freq };
        for (let k = 0; k < fr.amp.length; k++) {
          const a = fr.amp[k];
          let gk = a >= th * soft ? 1 : a <= th / soft ? 0 : Math.log(a / (th / soft)) / Math.log(soft * soft);
          if (!above) gk = 1 - gk;
          o.amp[k] = a * gk;
        }
        return o;
      });
    }
  });

  D.def({
    id: 'spec.morph', family: 'spectral', name: 'Morph',
    desc: 'Glides from the spectrum of sound A into the spectrum of sound B. The curve sets how far through the morph you are at each moment.',
    inputs: 2,
    params: [P('morph', 'A → B', 0, 1, 0, 'pct', { defEnv: [[0, 0], [1, 1]] })],
    choices: [BTIME(), C('freqs', 'Pitch', ['Glide between both', 'Keep A', 'Take from B'], 'Glide between both'), FFT()],
    run(I, P_, U) {
      return pv(I, P_, U, (an, c) => {
        const anB = pvB(I, P_, c), fm = P_.c('freqs');
        return an.frames.map((fa, f) => {
          const fb = bFrame(P_, an, anB, f), m = D.clamp(P_.v('morph', D.pvTime(an, f)), 0, 1), n = fa.amp.length;
          const o = D.blankFrame(n);
          for (let k = 0; k < n; k++) {
            o.amp[k] = fa.amp[k] * (1 - m) + fb.amp[k] * m;
            const a = Math.max(1, fa.freq[k]), b = Math.max(1, fb.freq[k]);
            o.freq[k] = fm === 'Keep A' ? fa.freq[k] : fm === 'Take from B' ? fb.freq[k] : a * Math.pow(b / a, m);
          }
          return o;
        });
      }, true);
    }
  });

  D.def({
    id: 'spec.cross', family: 'spectral', name: 'Cross-synthesis',
    desc: 'Makes A take on the tone of B. Vocode shapes A with B\'s spectral envelope (talking strings, singing noise). Swap keeps A\'s pitches but plays them with B\'s loudness in every band.',
    inputs: 2,
    params: [P('amount', 'Amount', 0, 1, 1, 'pct'), P('detail', 'Envelope detail', 2, 60, 10, 'int', { step: 1, env: false }), P('gain', 'Output', -24, 24, 0, 'db', { env: false })],
    choices: [C('mode', 'Mode', ['Vocode', 'Swap amplitudes'], 'Vocode'), BTIME(), FFT()],
    run(I, P_, U) {
      const vocode = P_.c('mode') === 'Vocode', gain = D.dbToGain(P_.v('gain'));
      return pv(I, P_, U, (an, c) => {
        const anB = pvB(I, P_, c);
        return an.frames.map((fa, f) => {
          const fb = bFrame(P_, an, anB, f), k_ = D.clamp(P_.v('amount', D.pvTime(an, f)), 0, 1), n = fa.amp.length;
          const o = { amp: new Float32Array(n), freq: fa.freq };
          if (vocode) {
            const eA = D.specEnvelope(fa.amp, P_.v('detail')), eB = D.specEnvelope(fb.amp, P_.v('detail'));
            for (let k = 0; k < n; k++) o.amp[k] = fa.amp[k] / eA[k] * Math.pow(eB[k], k_) * Math.pow(eA[k], 1 - k_) * gain;
          } else for (let k = 0; k < n; k++) o.amp[k] = (fa.amp[k] * (1 - k_) + fb.amp[k] * k_) * gain;
          return o;
        });
      }, true);
    }
  });

  D.def({
    id: 'spec.shift', family: 'spectral', name: 'Shift & stretch partials',
    desc: 'Shifts every partial by a fixed number of Hz, or spreads the partials apart, so harmonic sounds turn bell-like, metallic or out of tune with themselves.',
    params: [P('hz', 'Shift', -2000, 2000, 120, 'hz'), P('stretch', 'Spread', 0.5, 2, 1, 'x', { curve: 'log' }), P('base', 'Spread above', 20, 2000, 100, 'hz', { curve: 'log', env: false })],
    choices: [FFT()],
    run(I, P_, U) {
      return D.spectral(I, P_, U, (fr, t, f, an) => {
        const sh = P_.v('hz', t), s = P_.v('stretch', t), base = P_.v('base'), binHz = an.sr / an.N, n = fr.amp.length;
        const o = D.blankFrame(n);
        for (let k = 0; k < n; k++) {
          const a = fr.amp[k]; if (a <= 1e-9) continue;
          let nf = fr.freq[k];
          if (nf > base) nf = base * Math.pow(nf / base, s);
          nf += sh;
          const nk = Math.round(nf / binHz);
          if (nk <= 0 || nk >= n) continue;
          if (a > o.amp[nk]) o.freq[nk] = nf;
          o.amp[nk] += a;
        }
        return o;
      });
    }
  });

  const SCALES = {
    'Chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'Major': [0, 2, 4, 5, 7, 9, 11], 'Minor': [0, 2, 3, 5, 7, 8, 10],
    'Pentatonic': [0, 3, 5, 7, 10], 'Whole tone': [0, 2, 4, 6, 8, 10], 'Fifths': [0, 7], 'Root only': [0]
  };
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  D.SCALES = SCALES; D.NOTES = NOTES;

  D.def({
    id: 'spec.tune', family: 'spectral', name: 'Tune to scale',
    desc: 'Pulls every partial towards the nearest note of a scale or of one harmonic series, so noise and speech start to ring with pitch.',
    params: [P('strength', 'Pull', 0, 1, 0.85, 'pct'), P('focus', 'Focus', 0, 1, 0.3, 'pct')],
    choices: [C('root', 'Root', NOTES, 'C'), C('scale', 'Notes', Object.keys(SCALES).concat(['Harmonic series']), 'Pentatonic'), FFT()],
    run(I, P_, U) {
      const root = NOTES.indexOf(P_.c('root')), scName = P_.c('scale');
      const targets = [];
      if (scName === 'Harmonic series') { const f0 = 440 * Math.pow(2, (root + 36 - 69) / 12); for (let h = 1; h * f0 < 20000; h++) targets.push(f0 * h); }
      else { const sc = SCALES[scName] || SCALES.Chromatic; for (let o = 0; o < 10; o++) for (const s of sc) { const m = 12 + o * 12 + root + s; const f = 440 * Math.pow(2, (m - 69) / 12); if (f > 20 && f < 20000) targets.push(f); } }
      targets.sort((a, b) => a - b);
      const nearest = (f) => { let lo = 0, hi = targets.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (targets[m] < f) lo = m; else hi = m; } return Math.abs(Math.log(targets[lo] / f)) < Math.abs(Math.log(targets[hi] / f)) ? targets[lo] : targets[hi]; };
      return D.spectral(I, P_, U, (fr, t, f, an) => {
        const s = D.clamp(P_.v('strength', t), 0, 1), foc = P_.v('focus', t), binHz = an.sr / an.N, n = fr.amp.length;
        const o = D.blankFrame(n);
        for (let k = 1; k < n; k++) {
          const a = fr.amp[k]; if (a <= 1e-9) continue;
          const f0 = Math.max(10, fr.freq[k]), tg = nearest(f0);
          const nf = f0 * Math.pow(tg / f0, s);
          const nk = Math.round(nf / binHz); if (nk <= 0 || nk >= n) continue;
          const dist = Math.abs(Math.log2(tg / f0)) * 12; // semitones off the target
          const keep = 1 - foc + foc * Math.exp(-dist * dist * 4);
          if (a > o.amp[nk]) o.freq[nk] = nf;
          o.amp[nk] += a * keep;
        }
        return o;
      });
    }
  });

  D.def({
    id: 'spec.sweep', family: 'spectral', name: 'Spectral sweep',
    desc: 'A narrow band of emphasis sweeps up and down through the spectrum and the rest is turned down, picking out partials one after another like an arpeggio.',
    params: [P('rate', 'Rate', 0.05, 20, 1.5, 'hzLfo', { curve: 'log' }), P('lo', 'Lowest', 40, 8000, 150, 'hz', { curve: 'log' }), P('hi', 'Highest', 200, 18000, 5000, 'hz', { curve: 'log' }), P('width', 'Band width', 0.05, 3, 0.4, 'oct', { curve: 'log' }), P('depth', 'Depth', 0, 1, 0.92, 'pct'), P('boost', 'Boost', 0, 24, 6, 'db', { env: false }), D.SEED()],
    choices: [C('shape', 'Shape', ['Up and down', 'Up', 'Down', 'Random'], 'Up and down'), FFT()],
    run(I, P_, U) {
      const shape = P_.c('shape'), boost = D.dbToGain(P_.v('boost'));
      return D.spectral(I, P_, U, (fr, t, f, an, st) => {
        st.ph = (st.ph || 0) + P_.v('rate', t) * an.hop / an.sr;
        if (!st.r) { st.r = D.rng(P_.i('seed')); st.cur = st.r(); st.next = st.r(); st.cyc = 0; }
        let x;
        const ph = st.ph % 1;
        if (shape === 'Up') x = ph; else if (shape === 'Down') x = 1 - ph; else if (shape === 'Up and down') x = 1 - Math.abs(ph * 2 - 1);
        else { const cyc = Math.floor(st.ph); while (st.cyc < cyc) { st.cur = st.next; st.next = st.r(); st.cyc++; } x = st.cur + (st.next - st.cur) * (0.5 - 0.5 * Math.cos(Math.PI * ph)); }
        const lo = P_.v('lo', t), hi = Math.max(lo * 1.01, P_.v('hi', t)), centre = lo * Math.pow(hi / lo, x);
        const w = P_.v('width', t), dp = P_.v('depth', t), n = fr.amp.length, o = { amp: new Float32Array(n), freq: fr.freq };
        for (let k = 0; k < n; k++) { const d = Math.log2(Math.max(1, fr.freq[k]) / centre) / w; const gk = Math.exp(-d * d * 2); o.amp[k] = fr.amp[k] * ((1 - dp) + dp * gk * boost); }
        return o;
      });
    }
  });

  D.def({
    id: 'spec.scatter', family: 'spectral', name: 'Spectral scatter',
    desc: 'Keeps a random handful of frequency bands in each moment and drops the others, so the sound sparkles and flickers.',
    params: [P('density', 'Kept', 0.01, 1, 0.2, 'pct', { curve: 'log' }), P('bands', 'Band size', 1, 64, 4, 'int', { curve: 'log', step: 1 }), P('hold', 'Change every', 1, 32, 2, 'int', { step: 1, env: false }), D.SEED()],
    choices: [FFT()],
    run(I, P_, U) {
      return D.spectral(I, P_, U, (fr, t, f, an, st) => {
        const n = fr.amp.length, bs = Math.max(1, P_.i('bands', t));
        if (!st.r) st.r = D.rng(P_.i('seed') + st.channel * 31);
        if (!st.mask || f % Math.max(1, P_.i('hold')) === 0) { const d = P_.v('density', t); st.mask = new Uint8Array(Math.ceil(n / bs)); for (let i = 0; i < st.mask.length; i++) st.mask[i] = st.r() < d ? 1 : 0; }
        const d = Math.max(0.01, P_.v('density', t));
        const o = { amp: new Float32Array(n), freq: fr.freq };
        for (let k = 0; k < n; k++) if (st.mask[Math.floor(k / bs)]) o.amp[k] = fr.amp[k] / Math.sqrt(d);
        return o;
      });
    }
  });

  D.def({
    id: 'spec.shuffle', family: 'spectral', name: 'Spectral shuffle',
    desc: 'Cuts the sound into groups of analysis windows and reorders them. Because it works on the spectrum, the joins stay smooth.',
    params: [P('group', 'Windows per group', 1, 128, 8, 'int', { curve: 'log', step: 1, env: false }), D.SEED()],
    choices: [C('mode', 'Order', ['Random', 'Reverse each group', 'Back and forth', 'Swap neighbours'], 'Random'), FFT()],
    run(I, P_, U) {
      return pv(I, P_, U, (an) => {
        const F = an.frames, G = Math.max(1, P_.i('group')), mode = P_.c('mode'), r = D.rng(P_.i('seed'));
        const groups = []; for (let i = 0; i < F.length; i += G) groups.push(F.slice(i, i + G));
        let order = groups.map((_, i) => i);
        if (mode === 'Random') r.shuffle(order);
        if (mode === 'Swap neighbours') for (let i = 0; i + 1 < order.length; i += 2) { const t = order[i]; order[i] = order[i + 1]; order[i + 1] = t; }
        const out = [];
        order.forEach((gi, j) => { let gr = groups[gi]; if (mode === 'Reverse each group' || (mode === 'Back and forth' && j % 2)) gr = gr.slice().reverse(); out.push(...gr); });
        return out;
      }, true);
    }
  });

  D.def({
    id: 'spec.reverse', family: 'spectral', name: 'Spectral reverse',
    desc: 'Plays the spectrum backwards. Unlike tape reverse, each partial keeps its natural phase, so it comes out smoother and more ghostly.',
    params: [],
    choices: [FFT()],
    run(I, P_, U) { return pv(I, P_, U, (an) => an.frames.slice().reverse(), true); }
  });
}); })(typeof self !== 'undefined' ? self : this);
