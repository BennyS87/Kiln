// Kiln - the sound view (waveform and/or spectrogram, with selection, cursor and zoom) and the breakpoint lanes.
(function () {
  const SP = window.Kiln;

  function sizeCanvas(cv) {
    const dpr = window.devicePixelRatio || 1, W = Math.max(10, cv.clientWidth), H = Math.max(10, cv.clientHeight);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, W, H };
  }
  SP.sizeCanvas = sizeCanvas;

  // min/max peaks per column for a time range
  function peaks(x, sr, t0, t1, cols) {
    const out = new Float32Array(cols * 2), a = t0 * sr, k = (t1 - t0) * sr / cols;
    for (let c = 0; c < cols; c++) {
      const s = Math.max(0, Math.floor(a + c * k)), e = Math.min(x.length, Math.max(s + 1, Math.floor(a + (c + 1) * k)));
      let lo = 0, hi = 0;
      if (k < 1.5) { const v = SP.DSP.read(x, a + c * k); lo = hi = v; }
      else for (let i = s; i < e; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out[c * 2] = lo; out[c * 2 + 1] = hi;
    }
    return out;
  }
  function drawWave(g, snd, t0, t1, x0, y0, W, H, color, fill) {
    const nCh = snd.ch.length, h = H / nCh, cols = Math.max(1, Math.floor(W));
    for (let c = 0; c < nCh; c++) {
      const pk = peaks(snd.ch[c], snd.sr, t0, t1, cols), mid = y0 + h * c + h / 2, amp = h * 0.46;
      if (fill) { g.fillStyle = fill; g.fillRect(x0, y0 + h * c, W, h); }
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.moveTo(x0, mid + 0.5); g.lineTo(x0 + W, mid + 0.5); g.stroke();
      g.fillStyle = color;
      for (let i = 0; i < cols; i++) { const lo = pk[i * 2], hi = pk[i * 2 + 1]; const yA = mid - hi * amp, yB = mid - lo * amp; g.fillRect(x0 + i, yA, 1, Math.max(1, yB - yA)); }
    }
  }
  SP.drawWave = drawWave;

  // colour map for the spectrogram: deep blue -> magenta -> amber -> white
  const LUT = (() => {
    const stops = [[0, [7, 8, 11]], [0.25, [24, 22, 70]], [0.5, [150, 40, 120]], [0.72, [255, 92, 138]], [0.88, [255, 181, 71]], [1, [255, 250, 230]]];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255; let k = 0; while (k < stops.length - 2 && stops[k + 1][0] < t) k++;
      const [ta, ca] = stops[k], [tb, cb] = stops[k + 1], f = (t - ta) / (tb - ta);
      for (let j = 0; j < 3; j++) lut[i * 3 + j] = ca[j] + (cb[j] - ca[j]) * f;
    }
    return lut;
  })();

  class WaveView {
    constructor(canvas, opts) {
      this.cv = canvas; this.o = opts || {};
      this.snd = null; this.v0 = 0; this.v1 = 1; this.sel = null; this.cursor = 0; this.playhead = null; this.mode = 'wave';
      this.spec = null; this.specKey = ''; this.specBusy = false;
      this.bind();
      new ResizeObserver(() => this.draw()).observe(canvas);
    }
    get dur() { return this.snd ? this.snd.ch[0].length / this.snd.sr : 1; }
    setSound(snd, keepView) {
      const same = this.snd === snd;
      this.snd = snd;
      if (!same || !keepView) { this.v0 = 0; this.v1 = this.dur; this.sel = snd && snd._sel ? snd._sel.slice() : null; this.cursor = snd && snd._cursor || 0; }
      this.spec = null; this.specKey = '';
      this.draw();
    }
    setMode(m) { this.mode = m; this.draw(); }
    tx(t, W) { return (t - this.v0) / (this.v1 - this.v0) * W; }
    xt(x, W) { return this.v0 + x / W * (this.v1 - this.v0); }
    zoom(factor, atT) {
      const d = this.dur, span = Math.min(d, Math.max(0.002, (this.v1 - this.v0) * factor));
      atT = atT == null ? (this.v0 + this.v1) / 2 : atT;
      const f = (atT - this.v0) / (this.v1 - this.v0);
      this.v0 = Math.max(0, Math.min(d - span, atT - span * f)); this.v1 = this.v0 + span;
      this.spec = null; this.draw(); this.o.onView && this.o.onView();
    }
    zoomToSel() { if (this.sel) { const pad = (this.sel[1] - this.sel[0]) * 0.05; this.v0 = Math.max(0, this.sel[0] - pad); this.v1 = Math.min(this.dur, this.sel[1] + pad); this.spec = null; this.draw(); } }
    zoomAll() { this.v0 = 0; this.v1 = this.dur; this.spec = null; this.draw(); }
    bind() {
      const cv = this.cv;
      let drag = null;
      const tAt = (e) => { const r = cv.getBoundingClientRect(); return Math.max(0, Math.min(this.dur, this.xt(e.clientX - r.left, r.width))); };
      cv.addEventListener('pointerdown', e => {
        if (!this.snd || e.button !== 0) return;
        cv.setPointerCapture(e.pointerId);
        const r = cv.getBoundingClientRect(), t = tAt(e), x = e.clientX - r.left;
        // grab a selection edge if close to one
        if (this.sel) { const xa = this.tx(this.sel[0], r.width), xb = this.tx(this.sel[1], r.width); if (Math.abs(x - xa) < 6) drag = { edge: 0 }; else if (Math.abs(x - xb) < 6) drag = { edge: 1 }; }
        if (!drag) {
          if (e.shiftKey && this.sel) { drag = { edge: t < (this.sel[0] + this.sel[1]) / 2 ? 0 : 1 }; this.sel[drag.edge] = t; }
          else drag = { t0: t, moved: false };
        }
        this.draw();
      });
      cv.addEventListener('pointermove', e => {
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
        if (!drag) {
          let cur = 'text';
          if (this.sel) { const xa = this.tx(this.sel[0], r.width), xb = this.tx(this.sel[1], r.width); if (Math.abs(x - xa) < 6 || Math.abs(x - xb) < 6) cur = 'ew-resize'; }
          cv.style.cursor = cur; this.hoverT = tAt(e); this.o.onHover && this.o.onHover(this.hoverT);
          return;
        }
        const t = tAt(e);
        if (drag.edge != null) { this.sel[drag.edge] = t; if (this.sel[0] > this.sel[1]) { this.sel.reverse(); drag.edge = 1 - drag.edge; } }
        else { if (Math.abs(t - drag.t0) * r.width / (this.v1 - this.v0) > 3) drag.moved = true; if (drag.moved) this.sel = [Math.min(drag.t0, t), Math.max(drag.t0, t)]; }
        this.draw(); this.o.onSelect && this.o.onSelect(this.sel, true);
      });
      const up = (e) => {
        if (!drag) return;
        if (drag.t0 != null && !drag.moved) { this.cursor = drag.t0; this.sel = null; this.o.onCursor && this.o.onCursor(this.cursor); }
        if (this.sel && this.sel[1] - this.sel[0] < 0.001) this.sel = null;
        drag = null; this.draw(); this.o.onSelect && this.o.onSelect(this.sel, false);
      };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      cv.addEventListener('pointerleave', () => { this.hoverT = null; this.o.onHover && this.o.onHover(null); });
      cv.addEventListener('dblclick', () => { if (!this.snd) return; this.sel = [0, this.dur]; this.draw(); this.o.onSelect && this.o.onSelect(this.sel, false); });
      cv.addEventListener('wheel', e => {
        if (!this.snd) return; e.preventDefault();
        const r = cv.getBoundingClientRect(), t = this.xt(e.clientX - r.left, r.width);
        if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.5 && !e.shiftKey) this.zoom(Math.exp(e.deltaY * 0.004), t);
        else { const span = this.v1 - this.v0, d = (e.deltaX || e.deltaY) / r.width * span; this.v0 = Math.max(0, Math.min(this.dur - span, this.v0 + d)); this.v1 = this.v0 + span; this.spec = null; this.draw(); }
      }, { passive: false });
    }
    requestSpec(W, H) {
      const key = this.snd._v + '|' + this.v0.toFixed(4) + '|' + this.v1.toFixed(4) + '|' + Math.round(W) + '|' + Math.round(H);
      if (this.specKey === key || this.specBusy) return;
      this.specBusy = true; const snd = this.snd, v0 = this.v0, v1 = this.v1;
      const a = Math.floor(v0 * snd.sr), b = Math.ceil(v1 * snd.sr);
      const x = SP.DSP.mono({ ch: snd.ch.map(c => c.subarray(a, b)) });
      const cols = Math.min(1600, Math.max(32, Math.round(W))), rows = Math.min(320, Math.max(64, Math.round(H)));
      SP.Jobs.spectrogram(x.slice(), snd.sr, cols, rows).then(s => {
        this.specBusy = false;
        if (snd !== this.snd) return;
        const img = new ImageData(s.cols, s.rows);
        for (let c = 0; c < s.cols; c++) for (let r = 0; r < s.rows; r++) { const v = s.data[c * s.rows + r], o = ((s.rows - 1 - r) * s.cols + c) * 4; img.data[o] = LUT[v * 3]; img.data[o + 1] = LUT[v * 3 + 1]; img.data[o + 2] = LUT[v * 3 + 2]; img.data[o + 3] = 255; }
        const oc = document.createElement('canvas'); oc.width = s.cols; oc.height = s.rows; oc.getContext('2d').putImageData(img, 0, 0);
        this.spec = oc; this.specKey = key; this.draw();
      }).catch(() => { this.specBusy = false; });
    }
    draw() {
      const { g, W, H } = sizeCanvas(this.cv);
      g.fillStyle = '#090b0f'; g.fillRect(0, 0, W, H);
      if (!this.snd) return;
      const RULER = 18, hh = H - RULER;
      // ruler
      g.fillStyle = '#0d1016'; g.fillRect(0, 0, W, RULER);
      const span = this.v1 - this.v0, steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
      const step = steps.find(s => s / span * W > 70) || 600;
      g.font = '9px ' + getComputedStyle(document.body).getPropertyValue('--mono'); g.fillStyle = '#586178'; g.strokeStyle = '#1d2330';
      g.beginPath();
      for (let t = Math.ceil(this.v0 / step) * step; t <= this.v1; t += step) { const x = Math.round(this.tx(t, W)) + 0.5; g.moveTo(x, RULER - 5); g.lineTo(x, H); g.fillText(step < 1 ? t.toFixed(step < 0.01 ? 3 : step < 0.1 ? 2 : 1) : SP.fmtTime(t).replace(/\.00$/, ''), x + 3, 11); }
      g.stroke();
      const showSpec = this.mode !== 'wave', showWave = this.mode !== 'spec';
      if (showSpec) {
        const sy = RULER, sh = this.mode === 'both' ? hh * 0.55 : hh;
        if (this.spec && this.specKey.startsWith(this.snd._v + '|' + this.v0.toFixed(4) + '|' + this.v1.toFixed(4))) { g.imageSmoothingEnabled = true; g.drawImage(this.spec, 0, sy, W, sh); }
        else { g.fillStyle = '#0b0d12'; g.fillRect(0, sy, W, sh); g.fillStyle = '#586178'; g.fillText('drawing spectrum…', 8, sy + 16); }
        this.requestSpec(W, sh);
        // frequency labels
        g.fillStyle = 'rgba(223,231,242,.55)';
        for (const f of [100, 1000, 10000]) { const fr = Math.log(f / 30) / Math.log(Math.min(20000, this.snd.sr / 2) / 30); if (fr > 0 && fr < 1) g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), 4, sy + sh - fr * sh - 2); }
        if (showWave) drawWave(g, this.snd, this.v0, this.v1, 0, sy + sh, W, hh - sh, '#6ee7ff');
      } else drawWave(g, this.snd, this.v0, this.v1, 0, RULER, W, hh, '#6ee7ff');
      // selection
      if (this.sel) {
        const xa = this.tx(this.sel[0], W), xb = this.tx(this.sel[1], W);
        g.fillStyle = 'rgba(255,92,138,0.16)'; g.fillRect(xa, RULER, xb - xa, hh);
        g.fillStyle = '#ff5c8a'; g.fillRect(xa - 0.5, 0, 1.5, H); g.fillRect(xb - 1, 0, 1.5, H);
        g.fillRect(xa, 0, xb - xa, 3);
      }
      // cursor and playhead
      const cx = this.tx(this.cursor, W); g.fillStyle = 'rgba(223,231,242,.6)'; g.fillRect(cx, RULER, 1, hh);
      if (this.playhead != null) { const px = this.tx(this.playhead, W); g.fillStyle = '#fff'; g.fillRect(px - 0.5, 0, 2, H); }
    }
  }

  // ---------------- breakpoint lane ----------------
  // opts: { def, dur, get(): bp array, set(bp), commit(), wave: {snd, t0, t1}, fmt(v) }
  class EnvLane {
    constructor(opts) {
      this.o = opts;
      const el = this.el = document.createElement('div'); el.className = 'lane';
      el.innerHTML = `<div class="lane-head"><b>${SP.escape(opts.def.label)}</b><span class="lane-val"></span><span class="lane-tools"></span></div>`;
      this.cv = document.createElement('canvas'); el.appendChild(this.cv);
      this.valEl = el.querySelector('.lane-val');
      const tools = el.querySelector('.lane-tools');
      const btn = (label, title, fn) => { const b = document.createElement('button'); b.className = 'small ghost'; b.textContent = label; b.title = title; b.onclick = fn; tools.appendChild(b); };
      btn('↗', 'Ramp up', () => this.preset('up')); btn('↘', 'Ramp down', () => this.preset('down')); btn('⋀', 'Rise and fall', () => this.preset('arch'));
      btn('⚂', 'Random steps', () => this.preset('random')); btn('—', 'Flat', () => this.preset('flat'));
      if (opts.onClose) btn('×', 'Back to a single value', opts.onClose);
      this.bind();
      new ResizeObserver(() => this.draw()).observe(this.cv);
    }
    get bp() { return this.o.get(); }
    yOf(v, H) { return 4 + (1 - SP.toNorm(this.o.def, v)) * (H - 8); }
    vOf(y, H) { return SP.fromNorm(this.o.def, 1 - (y - 4) / (H - 8)); }
    preset(kind) {
      const d = this.o.def, dur = this.o.dur, lo = d.min, hi = d.max, cur = this.bp.length ? this.bp[0][1] : d.def;
      const at = (n) => SP.fromNorm(d, n);
      let bp;
      if (kind === 'up') bp = [[0, at(0.1)], [dur, at(0.9)]];
      else if (kind === 'down') bp = [[0, at(0.9)], [dur, at(0.1)]];
      else if (kind === 'arch') bp = [[0, at(0.1)], [dur / 2, at(0.9)], [dur, at(0.1)]];
      else if (kind === 'random') { bp = []; const n = 8; for (let i = 0; i <= n; i++) { const v = at(Math.random()); bp.push([dur * i / n, v]); if (i < n) bp.push([dur * (i + 1) / n - dur * 0.001, v]); } }
      else bp = [[0, cur], [dur, cur]];
      this.o.set(bp.map(([t, v]) => [t, Math.min(hi, Math.max(lo, v))])); this.o.commit && this.o.commit(); this.draw();
    }
    bind() {
      const cv = this.cv; let drag = -1;
      const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, W: r.width, H: r.height }; };
      const hit = (p) => { const bp = this.bp; let best = -1, bd = 100; bp.forEach(([t, v], i) => { const dx = t / this.o.dur * p.W - p.x, dy = this.yOf(v, p.H) - p.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }); return best; };
      const sort = () => { const bp = this.bp; const moving = bp[drag]; bp.sort((a, b) => a[0] - b[0]); drag = bp.indexOf(moving); };
      cv.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const p = pos(e); let i = hit(p);
        if (i < 0) { const bp = this.bp; bp.push([Math.max(0, Math.min(this.o.dur, p.x / p.W * this.o.dur)), this.vOf(p.y, p.H)]); drag = bp.length - 1; sort(); }
        else drag = i;
        cv.setPointerCapture(e.pointerId); this.draw();
      });
      cv.addEventListener('pointermove', e => {
        const p = pos(e);
        if (drag < 0) { const i = hit(p); cv.style.cursor = i >= 0 ? 'grab' : 'crosshair'; const t = p.x / p.W * this.o.dur; this.valEl.textContent = SP.fmtTime(Math.max(0, t)) + '  ·  ' + this.fmt(this.vOf(p.y, p.H)); return; }
        const bp = this.bp, pt = bp[drag];
        pt[0] = Math.max(0, Math.min(this.o.dur, p.x / p.W * this.o.dur)); pt[1] = this.vOf(Math.max(0, Math.min(p.H, p.y)), p.H);
        sort(); this.valEl.textContent = SP.fmtTime(pt[0]) + '  ·  ' + this.fmt(pt[1]); this.draw();
      });
      const up = () => { if (drag >= 0) { drag = -1; this.o.commit && this.o.commit(); this.draw(); } };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      const del = (e) => { e.preventDefault(); const i = hit(pos(e)); if (i >= 0 && this.bp.length > 1) { this.bp.splice(i, 1); this.o.commit && this.o.commit(); this.draw(); } };
      cv.addEventListener('dblclick', del); cv.addEventListener('contextmenu', del);
      cv.addEventListener('pointerleave', () => { this.valEl.textContent = ''; });
    }
    fmt(v) { return this.o.fmt ? this.o.fmt(v) : v.toFixed(2); }
    draw() {
      const { g, W, H } = sizeCanvas(this.cv);
      g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
      const w = this.o.wave;
      if (w && w.snd) drawWave(g, { ch: [SP.DSP.mono(w.snd)], sr: w.snd.sr }, w.t0, w.t1, 0, 0, W, H, 'rgba(110,231,255,0.13)');
      const d = this.o.def;
      if (d.min < 0 && d.max > 0) { const y = this.yOf(0, H); g.strokeStyle = '#1d2330'; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      const bp = this.bp, dur = this.o.dur;
      if (!bp.length) return;
      g.beginPath();
      g.moveTo(0, this.yOf(bp[0][1], H));
      // follow the parameter's own curve between points
      for (let i = 0; i < bp.length; i++) {
        const [t, v] = bp[i];
        if (i > 0) { const [tp, vp] = bp[i - 1]; const steps = Math.max(1, Math.round((t - tp) / dur * W / 6)); for (let s = 1; s <= steps; s++) { const f = s / steps; const vv = d.curve === 'log' && vp > 0 && v > 0 ? vp * Math.pow(v / vp, f) : vp + (v - vp) * f; g.lineTo((tp + (t - tp) * f) / dur * W, this.yOf(vv, H)); } }
        else g.lineTo(t / dur * W, this.yOf(v, H));
      }
      g.lineTo(W, this.yOf(bp[bp.length - 1][1], H));
      g.strokeStyle = '#ff5c8a'; g.lineWidth = 1.8; g.stroke(); g.lineWidth = 1;
      g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fillStyle = 'rgba(255,92,138,0.08)'; g.fill();
      for (const [t, v] of bp) { g.fillStyle = '#dfe7f2'; g.beginPath(); g.arc(t / dur * W, this.yOf(v, H), 3.5, 0, Math.PI * 2); g.fill(); }
    }
  }

  SP.WaveView = WaveView;
  SP.EnvLane = EnvLane;
})();
