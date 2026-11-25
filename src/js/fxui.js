// Kiln - effect cards for the Effects process: the same editors as Spiders, Orbit and Reel Studio
// (fxCard, EQ curve and trance-gate step editor are copied from Spiders' panels.js).
(function () {
  const SP = window.Kiln;
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  function select(options, value, onChange) {
    const s = el('select');
    for (const o of options) { const [v, l] = Array.isArray(o) ? o : [o, o]; const op = el('option', '', l); op.value = v; if (String(v) === String(value)) op.selected = true; s.appendChild(op); }
    s.onchange = () => onChange(s.value);
    return s;
  }
  function knobFor(def, get, set, commit) { return new SP.Knob({ def, get, set, commit }).el; }

  function fxCard(list, fx, idx, rerender) {
    const app = SP.app, T = SP.FX.TYPES[fx.type];
    const card = el('div', 'fxcard' + (fx.on ? '' : ' off'));
    const head = el('div', 'fxhead');
    const sw = el('button', 'switch' + (fx.on ? ' on' : '')); sw.title = fx.on ? 'Switch off' : 'Switch on';
    sw.onclick = () => { fx.on = !fx.on; app.commit(fx.on ? 'Effect on' : 'Effect off'); rerender(); };
    const up = el('button', 'ghost', '↑'); up.title = 'Earlier'; up.disabled = idx === 0;
    up.onclick = () => { list.splice(idx - 1, 0, list.splice(idx, 1)[0]); app.commit('Reorder effects'); rerender(); };
    const dn = el('button', 'ghost', '↓'); dn.title = 'Later'; dn.disabled = idx === list.length - 1;
    dn.onclick = () => { list.splice(idx + 1, 0, list.splice(idx, 1)[0]); app.commit('Reorder effects'); rerender(); };
    const rm = el('button', 'ghost', '×'); rm.title = 'Remove';
    rm.onclick = () => { list.splice(idx, 1); app.commit('Remove effect'); rerender(); };
    head.append(sw, el('b', '', T.name), up, dn, rm);
    card.appendChild(head);
    const body = el('div', 'fxbody');
    if (T.choices.length) {
      const ch = el('div', 'choices');
      for (const c of T.choices) {
        const f = el('div', 'field'); f.appendChild(el('label', '', c.label));
        f.appendChild(select(c.options, fx.p[c.key], v => { fx.p[c.key] = v; app.commit(c.label); rerender(); }));
        ch.appendChild(f);
      }
      body.appendChild(ch);
    }
    let knobs = T.params;
    let redraw = null;
    if (fx.type === 'eq') { const r = eqEditor(fx); body.appendChild(r.canvas); redraw = r.draw; knobs = T.params.filter(q => ['q3', 'q4', 'out'].includes(q.key)); }
    if (fx.type === 'gate') body.appendChild(gateEditor(fx));
    if (fx.type === 'echo' && fx.p.time !== 'Free (ms)') knobs = knobs.filter(q => q.key !== 'ms');
    if ((fx.type === 'filter' || fx.type === 'mod') && fx.p.sync !== 'Free (Hz)') knobs = knobs.filter(q => q.key !== 'rate');
    if (fx.type === 'mod' && fx.p.mode !== 'Phaser') { /* stages only used by the phaser */ }
    const k = el('div', 'knobs');
    for (const d of knobs) k.appendChild(knobFor(d, () => fx.p[d.key], v => { fx.p[d.key] = v; app.touch(); if (redraw) redraw(); }, () => app.commit(d.label)));
    body.appendChild(k);
    card.appendChild(body);
    return card;
  }

  // EQ curve editor
  let eqCtx = null;
  function eqEditor(fx) {
    const cv = el('canvas', 'eqcanvas');
    const p = fx.p;
    const fMin = 20, fMax = 20000, gMax = 18;
    const N = 200;
    const freqs = new Float32Array(N); for (let i = 0; i < N; i++) freqs[i] = fMin * Math.pow(fMax / fMin, i / (N - 1));
    const xOf = (f, W) => Math.log(f / fMin) / Math.log(fMax / fMin) * W;
    const fOf = (x, W) => fMin * Math.pow(fMax / fMin, Math.min(1, Math.max(0, x / W)));
    const yOf = (g, H) => H / 2 - g / (gMax * 1.15) * H / 2;
    const gOf = (y, H) => Math.max(-gMax, Math.min(gMax, (H / 2 - y) / (H / 2) * gMax * 1.15));
    const bands = [{ f: 'f1' }, { f: 'f2', g: 'g2' }, { f: 'f3', g: 'g3', q: 'q3' }, { f: 'f4', g: 'g4', q: 'q4' }, { f: 'f5', g: 'g5' }, { f: 'f6' }];
    const defs = Object.fromEntries(SP.FX.TYPES.eq.params.map(d => [d.key, d]));
    function response() {
      eqCtx = eqCtx || new OfflineAudioContext(1, 128, 44100);
      const mk = (type, f, g, q) => { const b = eqCtx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (g != null) b.gain.value = g; if (q != null) b.Q.value = q; return b; };
      const lc = p.f1 <= 20.5 ? 5 : p.f1, hc = p.f6 >= 19900 ? 22000 : p.f6;
      const twice = p.slope === '24 dB/oct';
      const list = [mk('highpass', lc, null, 0.707), mk('lowshelf', p.f2, p.g2), mk('peaking', p.f3, p.g3, p.q3), mk('peaking', p.f4, p.g4, p.q4), mk('highshelf', p.f5, p.g5), mk('lowpass', Math.min(22000, hc), null, 0.707)];
      const tot = new Float32Array(N).fill(0), mag = new Float32Array(N), ph = new Float32Array(N);
      list.forEach((b, i) => { b.getFrequencyResponse(freqs, mag, ph); for (let q = 0; q < N; q++) tot[q] += 20 * Math.log10(Math.max(1e-6, mag[q])) * (twice && (i === 0 || i === 5) ? 2 : 1); });
      return tot;
    }
    function draw() {
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, H = cv.clientHeight || 130;
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d'); g.scale(dpr, dpr);
      g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
      g.strokeStyle = '#1a1f2b'; g.lineWidth = 1; g.beginPath();
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(xOf(f, W)) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
      for (const db of [-12, -6, 0, 6, 12]) { const y = Math.round(yOf(db, H)) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
      const tot = response();
      g.beginPath();
      for (let i = 0; i < N; i++) { const x = xOf(freqs[i], W), y = yOf(Math.max(-30, tot[i] + p.out), H); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.strokeStyle = '#ff5c8a'; g.lineWidth = 2; g.stroke();
      g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fillStyle = 'rgba(255,92,138,0.08)'; g.fill();
      g.font = '9px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      bands.forEach((b, i) => {
        const x = xOf(p[b.f], W), y = b.g ? yOf(p[b.g], H) : yOf(0, H);
        g.fillStyle = drag === i ? '#fff' : '#dfe7f2'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#0a0c10'; g.fillText(String(i + 1), x, y + 0.5);
      });
      g.fillStyle = '#586178'; g.textAlign = 'left'; g.fillText(drag >= 0 ? `${SP.fmt.hz(p[bands[drag].f])}${bands[drag].g ? ' · ' + SP.fmt.db(p[bands[drag].g]) : ''}` : 'drag points · scroll on 3/4 = width · double-click = reset', 6, H - 8);
    }
    let drag = -1;
    const hitBand = (e) => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = -1, bd = 14 * 14;
      bands.forEach((b, i) => { const bx = xOf(p[b.f], r.width), by = b.g ? yOf(p[b.g], r.height) : yOf(0, r.height); const d = (bx - x) ** 2 + (by - y) ** 2; if (d < bd) { bd = d; best = i; } });
      return { best, x, y, r };
    };
    cv.addEventListener('pointerdown', e => { const h = hitBand(e); if (h.best < 0) return; drag = h.best; cv.setPointerCapture(e.pointerId); draw(); });
    cv.addEventListener('pointermove', e => {
      if (drag < 0) return;
      const r = cv.getBoundingClientRect(), b = bands[drag];
      const df = defs[b.f]; p[b.f] = Math.min(df.max, Math.max(df.min, fOf(e.clientX - r.left, r.width)));
      if (b.g) p[b.g] = Math.round(gOf(e.clientY - r.top, r.height) * 10) / 10;
      SP.app.touch(); draw();
    });
    const up = () => { if (drag >= 0) { drag = -1; SP.app.commit('EQ'); draw(); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('dblclick', e => { const h = hitBand(e); if (h.best < 0) return; const b = bands[h.best]; for (const k of [b.f, b.g, b.q]) if (k) p[k] = defs[k].def; SP.app.commit('Reset EQ band'); draw(); });
    cv.addEventListener('wheel', e => {
      const h = hitBand(e); if (h.best < 0 || !bands[h.best].q) return;
      e.preventDefault(); const k = bands[h.best].q, d = defs[k];
      p[k] = Math.min(d.max, Math.max(d.min, p[k] * Math.exp(-e.deltaY * 0.004)));
      SP.app.touch(); draw(); clearTimeout(cv._wt); cv._wt = setTimeout(() => SP.app.commit('EQ width'), 300);
    }, { passive: false });
    requestAnimationFrame(draw);
    return { canvas: cv, draw };
  }

  function gateEditor(fx) {
    const cv = el('canvas', 'gatecanvas');
    const p = fx.p;
    const n = () => parseInt(p.steps, 10) || 16;
    function draw() {
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, H = cv.clientHeight || 70;
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d'); g.scale(dpr, dpr);
      g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
      const N = n(), w = W / N;
      for (let i = 0; i < N; i++) {
        const v = p.pattern[i] || 0;
        g.fillStyle = i % 4 === 0 ? '#1d2330' : '#151a24'; g.fillRect(i * w + 1, 2, w - 2, H - 4);
        if (v > 0) { g.fillStyle = `rgba(255,92,138,${0.35 + 0.65 * v})`; g.fillRect(i * w + 1, 2 + (H - 4) * (1 - v), w - 2, (H - 4) * v); }
      }
    }
    let painting = null;
    const stepAt = (e) => { const r = cv.getBoundingClientRect(); return { i: Math.floor((e.clientX - r.left) / r.width * n()), v: Math.max(0.1, Math.min(1, 1 - (e.clientY - r.top) / r.height)) }; };
    cv.addEventListener('pointerdown', e => {
      const s = stepAt(e); if (s.i < 0 || s.i >= n()) return;
      cv.setPointerCapture(e.pointerId);
      const on = (p.pattern[s.i] || 0) <= 0;
      painting = { on, startY: e.clientY, i0: s.i, moved: false };
      p.pattern[s.i] = on ? 1 : 0;
      SP.app.touch(); draw();
    });
    cv.addEventListener('pointermove', e => {
      if (!painting) return;
      const s = stepAt(e); if (s.i < 0 || s.i >= n()) return;
      if (Math.abs(e.clientY - painting.startY) > 4) painting.moved = true;
      if (painting.moved && painting.on) p.pattern[s.i] = s.v; // drag to set levels
      else if (s.i !== painting.i0) p.pattern[s.i] = painting.on ? 1 : 0;
      SP.app.touch(); draw();
    });
    const up = () => { if (painting) { painting = null; SP.app.commit('Gate steps'); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    requestAnimationFrame(draw);
    return cv;
  }

  SP.FxUI = { fxCard, select };
})();
