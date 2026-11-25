// Kiln - waveset processes, after CDP's DISTORT family. A waveset runs from one upward zero-crossing to the
// next. Working on wavesets rather than fixed time slices gives CDP its typical gritty, granular, pitched-noise sounds.
(function (g) { (g.KilnDSPModules = g.KilnDSPModules || []).push(function waveset(D) {
  const { P, C } = D;
  const GROUP = (def) => P('group', 'Wavesets per group', 1, 64, def || 1, 'int', { curve: 'log', step: 1 });

  // walk wavesets in groups; fn(x, a, b, t, out, groupIndex) appends to out
  function groups(I, P_, fn, sizeKey) {
    return D.perCh(I, (x, c) => {
      const ws = D.wavesets(x), out = D.Out(x.length * 1.2);
      let gi = 0;
      for (let i = 0; i < ws.length;) {
        const t = ws[i][0] / I.sr;
        const G = Math.max(1, P_.i(sizeKey || 'group', t));
        const j = Math.min(ws.length, i + G);
        fn(x, ws[i][0], ws[j - 1][1], t, out, gi++, ws.slice(i, j), c);
        i = j;
      }
      return out.result();
    });
  }

  D.def({
    id: 'ws.repeat', family: 'waveset', name: 'Waveset repeat',
    desc: 'Repeats every waveset (or group of wavesets) several times. The sound gets longer and turns into buzzing, stuttering pitched grit.',
    params: [P('repeats', 'Repeats', 1, 32, 3, 'int', { step: 1 }), GROUP(1)],
    run(I, P_) { return groups(I, P_, (x, a, b, t, out) => { const n = Math.max(1, P_.i('repeats', t)); for (let r = 0; r < n; r++) out.pushArr(x, a, b); }); }
  });

  D.def({
    id: 'ws.omit', family: 'waveset', name: 'Waveset omit',
    desc: 'Silences some wavesets in every block (say 3 in every 5), so the sound breaks up into a crackling, gated ghost of itself.',
    params: [P('omit', 'Omit', 1, 63, 2, 'int', { step: 1 }), P('of', 'Out of every', 2, 64, 4, 'int', { step: 1 }), D.SEED()],
    choices: [C('pick', 'Which ones', ['In order', 'Random'], 'In order'), C('gap', 'Gaps', ['Silence', 'Remove (shorter)'], 'Silence')],
    run(I, P_, U) {
      const rnd = P_.c('pick') === 'Random', remove = P_.c('gap').startsWith('Remove');
      return D.perCh(I, (x, c) => {
        const ws = D.wavesets(x), out = D.Out(x.length), r = D.rng(P_.i('seed') + c);
        let mask = [];
        for (let i = 0; i < ws.length; i++) {
          const t = ws[i][0] / I.sr, of = Math.max(2, P_.i('of', t)), om = Math.min(of - 1, Math.max(0, P_.i('omit', t)));
          const k = i % of;
          if (k === 0) { mask = new Array(of).fill(false); if (rnd) { const idx = r.shuffle([...Array(of).keys()]); for (let q = 0; q < om; q++) mask[idx[q]] = true; } else for (let q = 0; q < om; q++) mask[of - 1 - q] = true; }
          const [a, b] = ws[i];
          if (!mask[k]) out.pushArr(x, a, b); else if (!remove) out.silence(b - a);
        }
        return out.result();
      });
    }
  });

  D.def({
    id: 'ws.reverse', family: 'waveset', name: 'Waveset reverse',
    desc: 'Reverses each group of wavesets in place. Small groups add a rasp; big groups give a choppy backwards-forwards texture.',
    params: [GROUP(4)],
    run(I, P_) { return groups(I, P_, (x, a, b, t, out) => { for (let i = b - 1; i >= a; i--) out.push(x[i]); }); }
  });

  D.def({
    id: 'ws.shuffle', family: 'waveset', name: 'Waveset shuffle',
    desc: 'Cuts the sound into units of a few wavesets and shuffles them within a moving window. Small windows blur, large ones scramble.',
    params: [P('unit', 'Wavesets per unit', 1, 32, 2, 'int', { curve: 'log', step: 1, env: false }), P('window', 'Units per shuffle', 2, 64, 8, 'int', { curve: 'log', step: 1, env: false }), D.SEED()],
    run(I, P_) {
      return D.perCh(I, (x, c) => {
        const ws = D.wavesets(x), U_ = Math.max(1, P_.i('unit')), W = Math.max(2, P_.i('window')), r = D.rng(P_.i('seed') + c);
        const units = []; for (let i = 0; i < ws.length; i += U_) units.push([ws[i][0], ws[Math.min(ws.length, i + U_) - 1][1]]);
        const out = D.Out(x.length);
        for (let i = 0; i < units.length; i += W) { const blk = units.slice(i, i + W); r.shuffle(blk); for (const [a, b] of blk) out.pushArr(x, a, b); }
        return out.result();
      });
    }
  });

  D.def({
    id: 'ws.interleave', family: 'waveset', name: 'Waveset interleave',
    desc: 'Alternates wavesets from sound A and sound B, weaving the two into one hybrid that flickers between both.',
    inputs: 2,
    params: [P('na', 'From A', 1, 16, 1, 'int', { step: 1 }), P('nb', 'From B', 1, 16, 1, 'int', { step: 1 })],
    choices: [C('end', 'Length', ['Until A ends', 'Until either ends', 'Until both end'], 'Until A ends')],
    run(I, P_) {
      const end = P_.c('end');
      return I[0].ch.map((x, c) => {
        const y = I[1].ch[Math.min(c, I[1].ch.length - 1)];
        const wa = D.wavesets(x), wb = D.wavesets(y), out = D.Out(x.length + y.length);
        let i = 0, j = 0;
        while (true) {
          const aDone = i >= wa.length, bDone = j >= wb.length;
          if (end === 'Until A ends' && aDone) break;
          if (end === 'Until either ends' && (aDone || bDone)) break;
          if (aDone && bDone) break;
          const t = (aDone ? x.length : wa[i][0]) / I[0].sr;
          for (let k = 0, n = P_.i('na', t); k < n && i < wa.length; k++, i++) out.pushArr(x, wa[i][0], wa[i][1]);
          for (let k = 0, n = P_.i('nb', t); k < n; k++, j++) { if (j >= wb.length) { if (end === 'Until A ends') j = 0; else break; } out.pushArr(y, wb[j][0], wb[j][1]); }
        }
        return out.result();
      });
    }
  });

  D.def({
    id: 'ws.average', family: 'waveset', name: 'Waveset average',
    desc: 'Replaces each group of wavesets with their average shape. Noisy sounds become hollow, reedy tones that follow the original\'s rough pitch.',
    params: [GROUP(6)],
    run(I, P_) {
      return groups(I, P_, (x, a, b, t, out, gi, ws) => {
        const L = Math.max(2, Math.round((b - a) / ws.length)), avg = new Float32Array(L), tmp = new Float32Array(L);
        for (const [p, q] of ws) { D.stretchSlice(x, p, q, L, tmp); for (let i = 0; i < L; i++) avg[i] += tmp[i] / ws.length; }
        for (const [p, q] of ws) out.pushArr(D.stretchSlice(avg, 0, L, q - p));
      });
    }
  });

  D.def({
    id: 'ws.multiply', family: 'waveset', name: 'Waveset multiply',
    desc: 'Squeezes each waveset and repeats it to fill the same time, pushing the pitch up by whole harmonics while keeping the length.',
    params: [P('factor', 'Multiply by', 2, 16, 2, 'int', { step: 1 })],
    run(I, P_) {
      return groups(I, P_, (x, a, b, t, out) => {
        const m = Math.max(1, P_.i('factor', t)), L = b - a, n = Math.max(1, Math.round(L / m));
        const seg = D.stretchSlice(x, a, b, n);
        let left = L; while (left > 0) { const k = Math.min(n, left); out.pushArr(seg, 0, k); left -= k; }
      });
    }
  });

  D.def({
    id: 'ws.divide', family: 'waveset', name: 'Waveset divide',
    desc: 'Stretches every waveset and skips the ones that follow it, dropping the pitch into a growling sub-octave while keeping the length.',
    params: [P('factor', 'Divide by', 2, 16, 2, 'int', { step: 1 })],
    run(I, P_) {
      return D.perCh(I, (x) => {
        const ws = D.wavesets(x), out = D.Out(x.length);
        for (let i = 0; i < ws.length;) {
          const t = ws[i][0] / I.sr, d = Math.max(1, P_.i('factor', t)), [a, b] = ws[i];
          const j = Math.min(ws.length, i + d), span = ws[j - 1][1] - a;
          out.pushArr(D.stretchSlice(x, a, b, span));
          i = j;
        }
        return out.result();
      });
    }
  });

  D.def({
    id: 'ws.replace', family: 'waveset', name: 'Waveset replace',
    desc: 'In each group, the loudest waveset takes over the whole group. Gives a stepped, sample-and-hold kind of distortion.',
    params: [GROUP(5)],
    run(I, P_) {
      return groups(I, P_, (x, a, b, t, out, gi, ws) => {
        let best = ws[0], bm = -1; for (const w of ws) { const m = D.wsPeak(x, w[0], w[1]); if (m > bm) { bm = m; best = w; } }
        for (const [p, q] of ws) out.pushArr(D.stretchSlice(x, best[0], best[1], q - p));
      });
    }
  });

  D.def({
    id: 'ws.envelope', family: 'waveset', name: 'Waveset envelope',
    desc: 'Imposes a tiny loudness shape on every group of wavesets, from soft tremolo to sharp, ticking pulses.',
    params: [GROUP(12), P('depth', 'Depth', 0, 1, 1, 'pct'), P('power', 'Steepness', 0.25, 8, 1.5, 'num', { curve: 'log' })],
    choices: [C('shape', 'Shape', ['Rise', 'Fall', 'Rise and fall', 'Spike'], 'Fall')],
    run(I, P_) {
      const sh = P_.c('shape');
      return groups(I, P_, (x, a, b, t, out) => {
        const dp = P_.v('depth', t), pw = P_.v('power', t), L = b - a;
        for (let i = 0; i < L; i++) {
          const ph = i / Math.max(1, L - 1);
          let e = sh === 'Rise' ? ph : sh === 'Fall' ? 1 - ph : sh === 'Spike' ? Math.exp(-ph * 8) : 1 - Math.abs(ph * 2 - 1);
          e = Math.pow(e, pw);
          out.push(x[a + i] * (1 - dp + dp * e));
        }
      });
    }
  });

  D.def({
    id: 'ws.filter', family: 'waveset', name: 'Waveset filter',
    desc: 'Keeps only the wavesets whose implied pitch falls inside (or outside) a range. A strange, ragged filter that tears holes in the sound.',
    params: [P('lo', 'From', 20, 10000, 200, 'hz', { curve: 'log' }), P('hi', 'To', 40, 20000, 2000, 'hz', { curve: 'log' })],
    choices: [C('keep', 'Keep', ['Inside the range', 'Outside the range'], 'Inside the range'), C('gap', 'Gaps', ['Silence', 'Remove (shorter)'], 'Silence')],
    run(I, P_) {
      const inside = P_.c('keep').startsWith('Inside'), remove = P_.c('gap').startsWith('Remove');
      return D.perCh(I, (x) => {
        const ws = D.wavesets(x, 2), out = D.Out(x.length);
        for (const [a, b] of ws) {
          const t = a / I.sr, f = I.sr / (b - a), ok = f >= P_.v('lo', t) && f <= P_.v('hi', t);
          if (ok === inside) out.pushArr(x, a, b); else if (!remove) out.silence(b - a);
        }
        return out.result();
      });
    }
  });

  D.def({
    id: 'ws.warp', family: 'waveset', name: 'Waveset pitch warp',
    desc: 'Gives every group of wavesets its own random speed, so the pitch wobbles and crackles. Can keep or change the overall length.',
    params: [P('range', 'Range', 0, 24, 5, 'st'), GROUP(3), D.SEED()],
    choices: [C('len', 'Length', ['Follows the speed', 'Kept the same'], 'Follows the speed')],
    run(I, P_) {
      const keep = P_.c('len') === 'Kept the same';
      return D.perCh(I, (x, c) => {
        const r = D.rng(P_.i('seed')), ws = D.wavesets(x), out = D.Out(x.length * 1.5);
        for (let i = 0; i < ws.length;) {
          const t = ws[i][0] / I.sr, G = Math.max(1, P_.i('group', t)), j = Math.min(ws.length, i + G);
          const ratio = D.st(r.bi() * P_.v('range', t));
          for (let q = i; q < j; q++) {
            const [a, b] = ws[q], L = b - a, n = Math.max(2, Math.round(L / ratio));
            if (!keep) out.pushArr(D.stretchSlice(x, a, b, n));
            else { const seg = D.stretchSlice(x, a, b, n); let left = L, o = 0; while (left > 0) { const k = Math.min(n, left); out.pushArr(seg, 0, k); left -= k; o++; if (o > 64) { out.silence(left); break; } } }
          }
          i = j;
        }
        return out.result();
      });
    }
  });

  D.def({
    id: 'ws.harmonic', family: 'waveset', name: 'Waveset harmonics',
    desc: 'Adds copies of every waveset squeezed to 2, 3, 4… times its rate, building a bright, organ-like stack of harmonics on any sound.',
    params: [P('count', 'Harmonics', 1, 12, 4, 'int', { step: 1 }), P('rolloff', 'Rolloff', 0.05, 1, 0.6, 'pct'), P('dry', 'Original', 0, 1, 0.6, 'pct')],
    run(I, P_) {
      return groups(I, P_, (x, a, b, t, out) => {
        const H = Math.max(1, P_.i('count', t)), ro = P_.v('rolloff', t), dry = P_.v('dry', t), L = b - a;
        const acc = new Float32Array(L);
        for (let i = 0; i < L; i++) acc[i] = x[a + i] * dry;
        let norm = dry;
        for (let h = 2; h <= H + 1; h++) {
          const n = Math.max(1, Math.round(L / h)), seg = D.stretchSlice(x, a, b, n), gn = Math.pow(ro, h - 1);
          for (let i = 0; i < L; i++) acc[i] += seg[i % n] * gn;
          norm += gn;
        }
        for (let i = 0; i < L; i++) out.push(acc[i] / Math.max(1, norm * 0.7));
      });
    }
  });
}); })(typeof self !== 'undefined' ? self : this);
