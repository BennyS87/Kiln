// Kiln - the app: sound bin with history, process browser, process panel with breakpoint curves,
// rendering, A/B playback, recipes (reusable chains), project files and export.
(function () {
  const SP = window.Kiln, D = SP.DSP;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const native = window.kilnNative || null;
  const esc = SP.escape;
  const FAM_COLORS = { spectral: '#b48cff', waveset: '#ff6a3d', granular: '#3cf0b4', time: '#49c6ff', edit: '#9aa6bd', fx: '#ffb547' };
  const FAMILIES = D.FAMILIES;
  const famName = (f) => (FAMILIES.find(x => x[0] === f) || [f, f])[1];
  const FMT = (k) => SP.fmt[k] || SP.fmt.num;

  // ---------- the effects chain, as a process that runs on Web Audio ----------
  const FX_PROC = {
    id: 'fx.chain', family: 'fx', name: 'Effects chain', inputs: 1, fx: true,
    desc: 'Runs the sound through the same effects as Reel Studio, Orbit and Spiders: EQ, filter, compressor, saturation, distortion, phaser / flanger / chorus, echo, reverb, trance gate and vocoder. Add as many as you like, in any order.',
    params: [D.P('tail', 'Tail', 0, 20, 2, 'sec', { env: false, curve: 'pow', pow: 2 }), D.P('bpm', 'Tempo (BPM)', 40, 240, 120, 'int', { env: false, step: 1 }), D.P('gain', 'Output', -24, 12, 0, 'db', { env: false })],
    choices: []
  };
  const PROCS = Object.assign({}, D.procs, { 'fx.chain': FX_PROC });
  const ORDER = FAMILIES.map(([f]) => f).flatMap(f => (f === 'fx' ? ['fx.chain'] : D.order.filter(id => D.procs[id].family === f)));

  // ---------- state ----------
  const S = {
    sounds: [], view: null, inA: null, inB: null,
    proc: 'spec.blur', vals: {}, envDur: {}, effects: [SP.FX.create('reverb')],
    selOnly: true, normalise: true, autoplay: true, replace: false,
    recipes: [], filter: 'all', search: '',
    path: null, dirty: false, busy: false, lastResult: null
  };
  const undoStack = [], redoStack = [];
  const player = new SP.Audio.Player();
  let view = null;

  const byId = (id) => S.sounds.find(s => s.id === id) || null;
  const durOf = (s) => s ? s.ch[0].length / s.sr : 0;
  const childrenOf = (id) => S.sounds.filter(s => s.parent === id);
  const viewed = () => byId(S.view);
  const inputA = () => byId(S.inA) || viewed();

  // ---------- small UI helpers ----------
  let toastT = 0;
  function toast(msg, ms) { const t = $('toast'); t.innerHTML = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || 2600); }
  function markDirty() { if (!S.dirty) { S.dirty = true; native && native.setDirty(true); updateTitle(); } }
  function updateTitle() {
    const nm = S.path ? S.path.split(/[\\/]/).pop().replace(/\.kiln$/, '') : 'Untitled';
    const t = 'Kiln — ' + nm + (S.dirty ? ' •' : '');
    document.title = t; native && native.setTitle(t);
  }
  function modal(html, cls) {
    const back = el('div', 'modal-back'), m = el('div', 'modal' + (cls ? ' ' + cls : ''), html);
    back.appendChild(m); $('modalRoot').appendChild(back);
    back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
    function close() { back.remove(); }
    return { m, close };
  }
  async function confirmBox(message, detail, buttons) {
    if (native) return native.confirm({ message, detail, buttons });
    return window.confirm(message + (detail ? '\n\n' + detail : '')) ? 0 : (buttons ? buttons.length - 1 : 1);
  }
  function ctxMenu(x, y, items) {
    const m = $('ctxMenu'); m.innerHTML = '';
    for (const it of items) {
      if (it === '-') { m.appendChild(el('hr')); continue; }
      const b = el('button', '', esc(it.label)); b.disabled = !!it.disabled; b.onclick = () => { hide(); it.fn(); }; m.appendChild(b);
    }
    m.style.display = 'block';
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
    const hide = () => { m.style.display = 'none'; document.removeEventListener('pointerdown', off, true); };
    const off = (e) => { if (!m.contains(e.target)) hide(); };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  }

  // ---------- undo ----------
  function snapshot() { return { sounds: S.sounds.slice(), names: S.sounds.map(s => s.name), recipes: JSON.parse(JSON.stringify(S.recipes)), view: S.view, inA: S.inA, inB: S.inB }; }
  function restore(sn) {
    S.sounds = sn.sounds; S.sounds.forEach((s, i) => s.name = sn.names[i]); S.recipes = sn.recipes;
    S.view = byId(sn.view) ? sn.view : (S.sounds[0] && S.sounds[0].id) || null;
    S.inA = byId(sn.inA) ? sn.inA : S.view; S.inB = byId(sn.inB) ? sn.inB : null;
    renderAll(); markDirty();
  }
  function checkpoint() { undoStack.push(snapshot()); if (undoStack.length > 80) undoStack.shift(); redoStack.length = 0; }
  function undo() { if (!undoStack.length) return toast('Nothing to undo'); redoStack.push(snapshot()); restore(undoStack.pop()); toast('Undone'); }
  function redo() { if (!redoStack.length) return toast('Nothing to redo'); undoStack.push(snapshot()); restore(redoStack.pop()); toast('Redone'); }

  // ---------- sounds ----------
  function addSound(o) {
    const s = { id: SP.uid('snd'), name: o.name || 'Sound', sr: o.sr, ch: o.ch, parent: o.parent || null, step: o.step || null, created: Date.now(), _v: 1 };
    // keep derived sounds right after their family in the list
    if (s.parent) {
      let idx = S.sounds.findIndex(x => x.id === s.parent);
      const desc = new Set([s.parent]);
      for (let i = idx + 1; i < S.sounds.length; i++) { if (desc.has(S.sounds[i].parent)) { desc.add(S.sounds[i].id); idx = i; } else break; }
      S.sounds.splice(idx + 1, 0, s);
    } else S.sounds.push(s);
    markDirty();
    return s;
  }
  function sliceSound(s, a, b) { const i0 = Math.max(0, Math.floor(a * s.sr)), i1 = Math.min(s.ch[0].length, Math.ceil(b * s.sr)); return { sr: s.sr, ch: s.ch.map(c => c.slice(i0, Math.max(i0 + 1, i1))) }; }
  function depthOf(s) { let d = 0, p = s; while (p && p.parent && d < 30) { p = byId(p.parent); d++; } return d; }
  function selectSound(id, asInput) {
    const s = byId(id); if (!s) return;
    if (view.snd) { view.snd._sel = view.sel; view.snd._cursor = view.cursor; }
    S.view = id; if (asInput !== false) { S.inA = id; syncEnvDur(); }
    view.setSound(s);
    renderBin(); renderSoundBar(); renderHistory(); renderPanel();
  }
  async function deleteSound(id) {
    const s = byId(id); if (!s) return;
    const kids = []; const walk = (pid) => { for (const c of childrenOf(pid)) { kids.push(c); walk(c.id); } }; walk(id);
    if (kids.length) {
      const r = await confirmBox(`Delete “${s.name}” and the ${kids.length} sound${kids.length > 1 ? 's' : ''} made from it?`, 'You can undo this with ⌘Z.', ['Delete all', 'Cancel']);
      if (r !== 0) return;
    }
    checkpoint();
    const gone = new Set([id, ...kids.map(k => k.id)]);
    if (player.playing && player.snd && gone.has(player.snd.id)) player.stop();
    const idx = S.sounds.findIndex(x => x.id === id);
    S.sounds = S.sounds.filter(x => !gone.has(x.id));
    if (gone.has(S.view)) S.view = s.parent && byId(s.parent) ? s.parent : (S.sounds[Math.min(idx, S.sounds.length - 1)] || {}).id || null;
    if (gone.has(S.inA)) S.inA = S.view;
    if (gone.has(S.inB)) S.inB = null;
    markDirty(); renderAll();
  }
  function renameSound(id) {
    const s = byId(id); if (!s) return;
    S.view === id ? startRename() : (selectSound(id), startRename());
  }
  function startRename() {
    const n = $('sndName'), s = viewed(); if (!s) return;
    n.contentEditable = 'true'; n.focus();
    const r = document.createRange(); r.selectNodeContents(n); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    const done = (save) => { n.contentEditable = 'false'; n.onblur = n.onkeydown = null; const v = n.textContent.trim(); if (save && v && v !== s.name) { checkpoint(); s.name = v; markDirty(); } renderSoundBar(); renderBin(); renderPanel(); };
    n.onblur = () => done(true);
    n.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') { e.preventDefault(); n.textContent = s.name; done(false); } e.stopPropagation(); };
  }
  function cropSelection() {
    const s = viewed(); if (!s || !view.sel) return toast('Drag across the sound to select part of it first');
    checkpoint();
    const [a, b] = view.sel, part = sliceSound(s, a, b);
    D.declick(part.ch[0], 32); part.ch.slice(1).forEach(c => D.declick(c, 32));
    const n = addSound({ name: s.name + ' (part)', sr: s.sr, ch: part.ch, parent: s.id, step: { proc: 'crop', range: [a, b] } });
    selectSound(n.id);
    toast('Selection copied to a new sound');
  }

  // ---------- process values ----------
  const procDef = (id) => PROCS[id] || PROCS['spec.blur'];
  function inputRange() {
    const A = inputA(); if (!A) return null;
    const sel = A === viewed() ? view.sel : A._sel;
    return S.selOnly && sel && sel[1] - sel[0] > 0.005 ? sel.slice() : null;
  }
  const inputDur = () => { const A = inputA(); if (!A) return 1; const r = inputRange(); return r ? r[1] - r[0] : durOf(A); };
  function valuesFor(id) {
    if (!S.vals[id]) { S.vals[id] = D.defaults(procDef(id), inputDur()); S.envDur[id] = inputDur(); }
    return S.vals[id];
  }
  // keep breakpoint curves spread over the same proportion of the input when the input changes length
  function syncEnvDur() {
    const d = inputDur();
    for (const id in S.vals) {
      const old = S.envDur[id]; if (!old || Math.abs(old - d) < 1e-6) { S.envDur[id] = d; continue; }
      const k = d / old;
      for (const key in S.vals[id]) { const v = S.vals[id][key]; if (v && typeof v === 'object' && v.bp) v.bp.forEach(p => p[0] *= k); }
      S.envDur[id] = d;
    }
  }

  // ---------- rendering ----------
  async function render() {
    if (S.busy) return;
    const A = inputA(); if (!A) return toast('Import a sound first');
    const def = procDef(S.proc);
    const range = inputRange();
    const a = range ? sliceSound(A, range[0], range[1]) : { sr: A.sr, ch: A.ch };
    const inputs = [a];
    let B = null;
    if (def.inputs === 2) {
      B = byId(S.inB);
      if (!B) return toast('This process mixes two sounds: choose sound <b>B</b> first');
      inputs.push(B.sr === A.sr ? { sr: B.sr, ch: B.ch } : { sr: A.sr, ch: B.ch.map(c => SP.Audio.resample(c, B.sr, A.sr)) });
    }
    const values = JSON.parse(JSON.stringify(valuesFor(def.id)));
    setBusy(true, 'Rendering ' + def.name + '…');
    const t0 = performance.now();
    try {
      let res = def.fx ? await SP.Audio.renderFx(a, S.effects, values) : await SP.Jobs.run(def.id, inputs, values, p => setProgress(p));
      if (S.normalise) { const pk = D.peakAll(res.ch); if (pk > 1e-6) { const g = D.dbToGain(-1) / pk; res.ch.forEach(c => { for (let i = 0; i < c.length; i++) c[i] *= g; }); } }
      const step = { proc: def.id, values, range, inDur: durOf(a), inputB: B ? B.id : null, inputBName: B ? B.name : null };
      if (def.fx) step.effects = JSON.parse(JSON.stringify(S.effects));
      checkpoint();
      let out;
      const prev = S.lastResult && byId(S.lastResult);
      if (S.replace && prev && prev.parent === A.id && prev.step && prev.step.proc === def.id && !childrenOf(prev.id).length) {
        prev.ch = res.ch; prev.sr = res.sr; prev.step = step; prev._v++; prev._mini = null; out = prev;
      } else out = addSound({ name: A.name + ' · ' + def.name, sr: res.sr, ch: res.ch, parent: A.id, step });
      S.lastResult = out.id;
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      setBusy(false, `${def.name}: ${SP.fmtTime(durOf(out))} made in ${secs} s`);
      const keepA = S.inA;
      selectSound(out.id, false); S.inA = keepA; renderBin(); renderPanel();
      if (S.autoplay) play(0);
    } catch (e) {
      setBusy(false, e.message === 'Cancelled' ? 'Cancelled' : 'Could not render: ' + e.message);
      if (e.message !== 'Cancelled') { console.error(e); toast('Could not render: ' + esc(e.message)); }
    }
  }
  function setBusy(on, msg) {
    S.busy = on;
    const btn = $('renderBtn'), bar = document.querySelector('.pp-foot .bar'), st = document.querySelector('.pp-foot .status'), cancel = $('cancelBtn');
    if (btn) { btn.disabled = on; btn.textContent = on ? 'Rendering…' : 'Render'; }
    if (bar) { bar.classList.toggle('on', on); bar.firstChild.style.width = '0%'; }
    if (cancel) cancel.style.display = on ? '' : 'none';
    if (st && msg != null) st.textContent = msg;
  }
  function setProgress(p) { const bar = document.querySelector('.pp-foot .bar i'); if (bar) bar.style.width = Math.round(Math.min(1, p) * 100) + '%'; }
  function chainResult() {
    const s = viewed(); if (!s) return;
    S.inA = s.id; syncEnvDur(); renderBin(); renderPanel(); toast(`“${esc(s.name)}” is now input A`);
  }

  // ---------- playback ----------
  function play(from) {
    const s = viewed(); if (!s) return;
    player.init();
    const sel = view.sel;
    if (from == null) from = sel ? sel[0] : view.cursor;
    player.play(s, from, sel ? sel[1] : null, 'view');
  }
  function togglePlay() { if (player.playing) player.stop(); else play(); }
  function compare() {
    const s = viewed(); if (!s) return;
    const src = s.parent ? byId(s.parent) : null;
    if (!src) return toast('This sound has no source to compare with');
    const pos = player.playing ? player.position() : (view.sel ? view.sel[0] : view.cursor);
    player.init();
    if (player.playing && player.tag === 'B') { player.play(s, pos / Math.max(1e-6, durOf(src)) * durOf(s), null, 'view'); return; }
    // map the position back into the source (taking a selection range into account)
    const r = s.step && s.step.range, sd = r ? r[1] - r[0] : durOf(src);
    const p = (r ? r[0] : 0) + pos / Math.max(1e-6, durOf(s)) * sd;
    player.play(src, p, r ? r[1] : null, 'B');
    toast('Playing the source: <b>' + esc(src.name) + '</b>', 1400);
  }
  function tick() {
    const p = player.position();
    if (view) {
      const playingView = player.playing && player.snd === viewed();
      view.playhead = playingView ? p : null;
      if (playingView && p > view.v1) { const span = view.v1 - view.v0; view.v0 = Math.min(view.dur - span, p - span * 0.1); view.v1 = view.v0 + span; view.spec = null; }
      view.draw();
    }
    const s = viewed();
    $('pos').firstChild.nodeValue = SP.fmtTime(p != null ? p : (view && view.cursor) || 0);
    $('posSub').textContent = player.playing ? (player.tag === 'B' ? 'SOURCE (A/B)' : 'PLAYING') : s ? SP.fmtTime(durOf(s)) + ' total' : 'no sound';
    drawMeter();
    requestAnimationFrame(tick);
  }
  let meterPk = [0, 0];
  function drawMeter() {
    const cv = $('meter'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const lv = player.playing ? player.levels() : [0, 0];
    meterPk = meterPk.map((v, i) => Math.max(lv[i], v * 0.92));
    g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
    for (let c = 0; c < 2; c++) {
      const db = 20 * Math.log10(meterPk[c] + 1e-9), w = Math.max(0, Math.min(1, (db + 54) / 54)) * W;
      const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#3cf0b4'); gr.addColorStop(0.75, '#ffb547'); gr.addColorStop(1, '#ff3b4e');
      g.fillStyle = gr; g.fillRect(0, 6 + c * 18, w, 12);
    }
  }

  // ---------- bin ----------
  function miniPeaks(s, cols) {
    if (s._mini && s._mini.v === s._v && s._mini.cols === cols) return s._mini.p;
    const x = s.ch[0], k = x.length / cols, p = new Float32Array(cols);
    for (let c = 0; c < cols; c++) { let m = 0; const a = Math.floor(c * k), b = Math.min(x.length, Math.floor((c + 1) * k)); for (let i = a; i < b; i += Math.max(1, (b - a) >> 6)) { const v = Math.abs(x[i]); if (v > m) m = v; } p[c] = m; }
    s._mini = { v: s._v, cols, p };
    return p;
  }
  function stepLabel(st) {
    if (!st) return '';
    if (st.proc === 'crop') return 'selection ' + SP.fmtTime(st.range[0]) + '–' + SP.fmtTime(st.range[1]);
    if (st.proc === 'recipe') return 'recipe: ' + st.recipe.name;
    return procDef(st.proc).name;
  }
  function renderBin() {
    const list = $('binList'); list.innerHTML = '';
    if (!S.sounds.length) { list.appendChild(el('div', 'empty-note', 'Import sounds with <b>+ Import</b> or drop them on the window. Everything you render appears here under the sound it came from.')); return; }
    for (const s of S.sounds) {
      const d = depthOf(s);
      const row = el('div', 'snd' + (s.id === S.view ? ' sel' : '') + (s.id === S.inA ? ' inA' : ''));
      row.style.setProperty('--depth', Math.min(d, 8)); if (d) row.style.setProperty('--branch', 'block');
      const tag = s.id === S.inA && s.id === S.inB ? 'A B' : s.id === S.inA ? 'A' : s.id === S.inB ? 'B' : '';
      row.innerHTML = `<div class="nm" title="${esc(s.name)}">${esc(s.name)}</div><div class="meta">${SP.fmtTime(durOf(s))} · ${s.ch.length === 1 ? 'mono' : 'stereo'}${s.step ? ' · <b>' + esc(stepLabel(s.step)) + '</b>' : ''}</div>${tag ? `<span class="tag">${tag}</span>` : ''}`;
      const cv = el('canvas', 'mini'); row.appendChild(cv);
      row.onclick = () => selectSound(s.id);
      row.ondblclick = () => renameSound(s.id);
      row.oncontextmenu = (e) => { e.preventDefault(); soundMenu(s, e.clientX, e.clientY); };
      list.appendChild(row);
      requestAnimationFrame(() => {
        const { g, W, H } = SP.sizeCanvas(cv), p = miniPeaks(s, Math.max(10, Math.round(W)));
        g.fillStyle = s.id === S.view ? '#ff6a3d' : '#3a4560';
        for (let i = 0; i < p.length; i++) { const h = Math.max(1, p[i] * H); g.fillRect(i * W / p.length, (H - h) / 2, Math.max(1, W / p.length - 0.2), h); }
      });
    }
  }
  function soundMenu(s, x, y) {
    ctxMenu(x, y, [
      { label: 'Use as input A', fn: () => { S.inA = s.id; syncEnvDur(); renderBin(); renderPanel(); } },
      { label: 'Use as input B', fn: () => { S.inB = s.id; renderBin(); renderPanel(); } },
      '-',
      { label: 'Rename…', fn: () => renameSound(s.id) },
      { label: 'Duplicate', fn: () => { checkpoint(); const n = addSound({ name: s.name + ' copy', sr: s.sr, ch: s.ch.map(c => c.slice()), parent: s.parent, step: s.step }); selectSound(n.id); } },
      { label: 'Export…', fn: () => { selectSound(s.id); exportDialog(); } },
      { label: 'Open the settings that made it', disabled: !s.step || !PROCS[s.step.proc], fn: () => reopenStep(s) },
      '-',
      { label: 'Delete', fn: () => deleteSound(s.id) }
    ]);
  }
  function reopenStep(s) {
    const st = s.step; if (!st || !PROCS[st.proc]) return;
    S.proc = st.proc; S.vals[st.proc] = JSON.parse(JSON.stringify(st.values)); S.envDur[st.proc] = st.inDur || inputDur();
    if (st.effects) S.effects = JSON.parse(JSON.stringify(st.effects));
    if (s.parent && byId(s.parent)) {
      S.inA = s.parent;
      const par = byId(s.parent);
      par._sel = st.range ? st.range.slice() : null;
      if (S.view === par.id) view.sel = par._sel;
    }
    if (st.inputB && byId(st.inputB)) S.inB = st.inputB;
    S.selOnly = !!st.range;
    syncEnvDur(); renderAll();
    toast(`Loaded the settings for <b>${esc(procDef(st.proc).name)}</b>. Change them and render again.`);
  }

  // ---------- sound bar & history ----------
  function renderSoundBar() {
    const s = viewed();
    $('welcome').style.display = S.sounds.length ? 'none' : '';
    $('sndName').textContent = s ? s.name : 'No sound';
    $('sndMeta').textContent = s ? `${SP.fmtTime(durOf(s))} · ${s.ch.length === 1 ? 'mono' : 'stereo'} · ${s.sr} Hz · peak ${(20 * Math.log10(D.peakAll(s.ch) + 1e-9)).toFixed(1)} dB` : '';
    renderSelInfo();
  }
  function renderSelInfo() {
    const sel = view && view.sel;
    $('selInfo').textContent = sel ? `selection ${SP.fmtTime(sel[0])} – ${SP.fmtTime(sel[1])} (${(sel[1] - sel[0]).toFixed(2)} s)` : '';
    $('cropBtn').disabled = !sel;
  }
  function historyOf(s) { const chain = []; let p = s, guard = 0; while (p && guard++ < 200) { chain.unshift(p); p = p.parent ? byId(p.parent) : null; } return chain; }
  function describeValues(st) {
    const def = PROCS[st.proc]; if (!def) return '';
    const parts = [];
    for (const p of def.params) { const v = st.values[p.key]; if (v == null) continue; parts.push(p.label + ' ' + (typeof v === 'object' ? 'curve' : FMT(p.fmt)(v))); }
    for (const c of def.choices) if (st.values[c.key] != null && st.values[c.key] !== c.def) parts.push(st.values[c.key]);
    if (st.effects) parts.unshift(st.effects.filter(f => f.on).map(f => SP.FX.TYPES[f.type].short || SP.FX.TYPES[f.type].name).join(' → ') || 'no effects');
    if (st.inputBName) parts.unshift('with ' + st.inputBName);
    if (st.range) parts.unshift('part ' + SP.fmtTime(st.range[0]) + '–' + SP.fmtTime(st.range[1]));
    return parts.join(', ');
  }
  function renderHistory() {
    const h = $('history'); h.innerHTML = '';
    const s = viewed(); if (!s) return;
    const chain = historyOf(s);
    h.appendChild(el('h3', '', 'History'));
    if (chain.length === 1) { h.appendChild(el('div', 'hint', 'An original sound. Render a process and the steps that made each new sound show up here.')); return; }
    chain.forEach((c, i) => {
      const row = el('div', 'hist-step');
      const label = i === 0 ? 'Original: ' + esc(c.name) : esc(stepLabel(c.step));
      const detail = i === 0 ? SP.fmtTime(durOf(c)) : c.step.proc === 'recipe' ? c.step.recipe.steps.map(x => procDef(x.proc).name).join(' → ') : esc(describeValues(c.step));
      row.innerHTML = `<div class="n">${i}</div><div class="t"><b>${label}</b><span>${detail}</span></div>`;
      if (i > 0 && PROCS[c.step.proc]) { const b = el('button', 'ghost', 'Edit'); b.title = 'Load these settings, with the same source, to try again'; b.onclick = () => reopenStep(c); row.appendChild(b); }
      if (c.id !== s.id) row.querySelector('.t').style.cursor = 'pointer', row.querySelector('.t').onclick = () => selectSound(c.id);
      h.appendChild(row);
    });
    const b = el('button', 'small', 'Save these steps as a recipe'); b.style.marginTop = '8px'; b.onclick = saveRecipe; h.appendChild(b);
  }

  // ---------- process browser ----------
  function renderChips() {
    const c = $('famChips'); c.innerHTML = '';
    const mk = (key, label) => { const b = el('button', S.filter === key ? 'on' : '', label); if (key !== 'all') b.style.setProperty('--fc', FAM_COLORS[key]); b.onclick = () => { S.filter = key; renderChips(); renderProcList(); }; c.appendChild(b); };
    mk('all', 'All'); for (const [f, n] of FAMILIES) mk(f, n);
  }
  function renderProcList() {
    const list = $('procList'); list.innerHTML = '';
    const q = S.search.trim().toLowerCase();
    let shown = 0;
    for (const [f] of FAMILIES) {
      if (S.filter !== 'all' && S.filter !== f) continue;
      const ids = ORDER.filter(id => PROCS[id].family === f && (!q || (PROCS[id].name + ' ' + PROCS[id].desc + ' ' + famName(f)).toLowerCase().includes(q)));
      if (!ids.length) continue;
      const hd = el('div', 'famhead', famName(f)); hd.style.setProperty('--fc', FAM_COLORS[f]); list.appendChild(hd);
      for (const id of ids) {
        const p = PROCS[id], row = el('div', 'proc' + (id === S.proc ? ' on' : ''));
        row.style.setProperty('--fc', FAM_COLORS[f]);
        row.innerHTML = `<b>${esc(p.name)}</b><span>${esc(p.desc)}</span>${p.inputs === 2 ? '<i class="two">A+B</i>' : ''}`;
        row.onclick = () => { S.proc = id; renderProcList(); renderPanel(); };
        list.appendChild(row); shown++;
      }
    }
    if (!shown) list.appendChild(el('div', 'empty-note', 'No process matches “' + esc(S.search) + '”.'));
    $('procCount').textContent = ORDER.length + ' processes';
  }

  // ---------- process panel ----------
  function soundOptions(sel, allowNone) {
    const s = el('select');
    if (allowNone) { const o = el('option', '', '— choose a sound —'); o.value = ''; s.appendChild(o); }
    for (const x of S.sounds) { const o = el('option', '', esc('  '.repeat(Math.min(6, depthOf(x))) + x.name)); o.value = x.id; if (x.id === sel) o.selected = true; s.appendChild(o); }
    return s;
  }
  function renderPanel() {
    const P = $('procPanel'); P.innerHTML = '';
    const def = procDef(S.proc), vals = valuesFor(def.id), A = inputA();
    const fc = FAM_COLORS[def.family];
    const head = el('div', 'pp-head');
    head.innerHTML = `<div class="titles"><h2>${esc(def.name)} <span class="famtag" style="--fc:${fc}">${esc(famName(def.family))}</span></h2><p>${esc(def.desc)}</p></div>`;
    const reset = el('button', 'small ghost', 'Reset'); reset.title = 'Back to the default settings';
    reset.onclick = () => { S.vals[def.id] = D.defaults(def, inputDur()); S.envDur[def.id] = inputDur(); if (def.fx) S.effects = [SP.FX.create('reverb')]; renderPanel(); };
    head.appendChild(reset);
    P.appendChild(head);

    // inputs
    const inp = el('div', 'pp-inputs');
    if (!S.sounds.length) inp.appendChild(el('span', 'hint', 'Import a sound to start.'));
    else {
      const a = el('div', 'inp'); a.appendChild(el('span', '', 'A'));
      const sa = soundOptions(S.inA || S.view); sa.onchange = () => { S.inA = sa.value; syncEnvDur(); renderBin(); renderPanel(); };
      a.appendChild(sa); inp.appendChild(a);
      const sel = A && (A === viewed() ? view.sel : A._sel);
      const ck = el('label', 'chk'); ck.innerHTML = `<input type="checkbox" ${S.selOnly ? 'checked' : ''} ${sel ? '' : 'disabled'}> Selection only${sel ? ` <span class="mono" style="color:var(--accent)">${SP.fmtTime(sel[0])}–${SP.fmtTime(sel[1])}</span>` : ''}`;
      ck.querySelector('input').onchange = (e) => { S.selOnly = e.target.checked; syncEnvDur(); renderPanel(); };
      inp.appendChild(ck);
      if (def.inputs === 2) {
        const b = el('div', 'inp'); b.appendChild(el('span', '', 'B'));
        const sb = soundOptions(S.inB, true); sb.onchange = () => { S.inB = sb.value || null; renderBin(); };
        b.appendChild(sb); inp.appendChild(b);
      }
    }
    P.appendChild(inp);

    // body
    const body = el('div', 'pp-body');
    if (def.choices.length) {
      const ch = el('div', 'pp-choices');
      for (const c of def.choices) {
        const f = el('div', 'field'); f.appendChild(el('label', '', esc(c.label)));
        f.appendChild(SP.FxUI.select(c.options, vals[c.key] == null ? c.def : vals[c.key], v => { vals[c.key] = v; markDirty(); }));
        ch.appendChild(f);
      }
      body.appendChild(ch);
    }
    const knobs = el('div', 'pp-knobs'), lanes = el('div', 'lanes');
    const dur = inputDur();
    for (const p of def.params) {
      const kd = Object.assign({}, p, { fmt: FMT(p.fmt) });
      if ((p.key === 'at' || p.key === 'start') && A) kd.max = Math.max(0.01, dur);
      if (p.key === 'offset' && A) kd.max = Math.max(0.01, dur);
      const box = el('div', 'pk' + (p.env ? '' : ' noenv'));
      const isEnv = () => vals[p.key] && typeof vals[p.key] === 'object';
      const kn = new SP.Knob({ def: kd, color: fc, get: () => isEnv() ? vals[p.key].bp[0][1] : (vals[p.key] == null ? p.def : vals[p.key]), set: v => { vals[p.key] = v; }, commit: () => markDirty() });
      box.appendChild(kn.el);
      const cb = el('button', 'curve', isEnv() ? '✓ curve' : '~ curve'); cb.title = isEnv() ? 'Back to a single value' : 'Draw a curve so this changes over time';
      cb.onclick = () => {
        if (isEnv()) vals[p.key] = vals[p.key].bp[0][1];
        else { const v = vals[p.key] == null ? p.def : vals[p.key]; vals[p.key] = { bp: [[0, v], [dur, v]] }; S.envDur[def.id] = dur; }
        markDirty(); renderPanel();
      };
      box.appendChild(cb);
      if (isEnv()) box.classList.add('env');
      knobs.appendChild(box);
      if (isEnv()) {
        const range = inputRange();
        const lane = new SP.EnvLane({
          def: kd, dur, fmt: kd.fmt, get: () => vals[p.key].bp, set: bp => { vals[p.key] = { bp }; }, commit: () => markDirty(),
          wave: A ? { snd: A, t0: range ? range[0] : 0, t1: range ? range[1] : durOf(A) } : null,
          onClose: () => { vals[p.key] = vals[p.key].bp[0][1]; markDirty(); renderPanel(); }
        });
        lanes.appendChild(lane.el);
      }
    }
    if (def.params.length) body.appendChild(knobs);
    if (lanes.childNodes.length) body.appendChild(lanes);
    else if (def.params.some(p => p.env)) body.appendChild(el('div', 'hint', 'Press <b>~ curve</b> under a knob to draw a curve for it, so the setting changes over the length of the sound, like a CDP breakpoint file.'));
    if (def.fx) {
      const wrap = el('div', 'fxwrap');
      const add = SP.FxUI.select([['', '+ Add effect…']].concat(SP.FX.ORDER.map(t => [t, SP.FX.TYPES[t].name])), '', v => { if (!v) return; S.effects.push(SP.FX.create(v)); markDirty(); renderPanel(); });
      add.style.width = '100%'; add.style.marginTop = '8px'; wrap.appendChild(add);
      if (!S.effects.length) wrap.appendChild(el('div', 'hint', 'Effects run top to bottom.'));
      S.effects.forEach((fx, i) => wrap.appendChild(SP.FxUI.fxCard(S.effects, fx, i, renderPanel)));
      body.appendChild(wrap);
    }
    P.appendChild(body);

    // footer
    const foot = el('div', 'pp-foot');
    const chk = (label, key, title) => { const l = el('label', 'chk'); l.title = title; l.innerHTML = `<input type="checkbox" ${S[key] ? 'checked' : ''}> ${label}`; l.querySelector('input').onchange = e => { S[key] = e.target.checked; }; return l; };
    foot.append(chk('Normalise', 'normalise', 'Set the loudest peak of the result to −1 dB'), chk('Play when done', 'autoplay', 'Play the result as soon as it is made'), chk('Replace last try', 'replace', 'Rendering the same process on the same source again replaces the previous result instead of adding another'));
    const bar = el('div', 'bar'); bar.appendChild(el('i')); foot.appendChild(bar);
    const st = el('div', 'status grow'); foot.appendChild(st);
    const cancel = el('button', 'small', 'Cancel'); cancel.id = 'cancelBtn'; cancel.style.display = 'none'; cancel.onclick = () => SP.Jobs.cancel(); foot.appendChild(cancel);
    const rb = el('button', 'accent', 'Render'); rb.id = 'renderBtn'; rb.title = 'Make a new sound with this process (⌘↵)'; rb.onclick = render; rb.disabled = !A || S.busy;
    if (S.busy) rb.textContent = 'Rendering…';
    foot.appendChild(rb);
    P.appendChild(foot);
    if (S.busy) setBusy(true);
  }

  // ---------- recipes ----------
  function normaliseValues(values, dur) {
    const v = JSON.parse(JSON.stringify(values));
    for (const k in v) if (v[k] && typeof v[k] === 'object' && v[k].bp) v[k] = { bpn: v[k].bp.map(([t, x]) => [dur > 0 ? t / dur : 0, x]) };
    return v;
  }
  function denormaliseValues(values, dur) {
    const v = JSON.parse(JSON.stringify(values));
    for (const k in v) if (v[k] && typeof v[k] === 'object' && v[k].bpn) v[k] = { bp: v[k].bpn.map(([f, x]) => [f * dur, x]) };
    return v;
  }
  function stepsOf(s) {
    const steps = [];
    for (const c of historyOf(s).slice(1)) {
      const st = c.step; if (!st) continue;
      if (st.proc === 'recipe') steps.push(...st.recipe.steps);
      else if (PROCS[st.proc]) steps.push({ proc: st.proc, values: normaliseValues(st.values, st.inDur || durOf(c)), effects: st.effects || null, inputB: st.inputB || null, inputBName: st.inputBName || null });
    }
    return steps;
  }
  function saveRecipe() {
    const s = viewed(); if (!s) return;
    const steps = stepsOf(s);
    if (!steps.length) return toast('Render something first: a recipe is the chain of processes that made a sound');
    const { m, close } = modal(`<h2>Save recipe</h2><p>${steps.length} step${steps.length > 1 ? 's' : ''}: ${esc(steps.map(x => procDef(x.proc).name).join(' → '))}</p>
      <div class="field"><label>Name</label><input type="text" id="rcpName" value="${esc(steps.map(x => procDef(x.proc).name).slice(-3).join(' + '))}"></div>
      <p class="hint">Curves are stored as a share of the sound's length, so they fit any sound you apply the recipe to.${steps.some(x => x.inputB) ? ' Steps that use a sound B will use the same B sound if it is still in the project.' : ''}</p>
      <div class="foot"><button id="rcpCancel">Cancel</button><button class="accent" id="rcpOk">Save</button></div>`);
    const inp = m.querySelector('#rcpName'); inp.focus(); inp.select();
    const ok = () => { checkpoint(); S.recipes.push({ id: SP.uid('rcp'), name: inp.value.trim() || 'Recipe', steps }); markDirty(); renderRecipes(); close(); toast('Recipe saved'); };
    m.querySelector('#rcpOk').onclick = ok; m.querySelector('#rcpCancel').onclick = close;
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); };
  }
  function renderRecipes() {
    const l = $('recipeList'); l.innerHTML = '';
    if (!S.recipes.length) { l.appendChild(el('div', 'empty-note', 'A recipe is a saved chain of processes you can run on any sound in one go, or on many sounds at once. Save one from a sound\'s history.')); return; }
    for (const r of S.recipes) {
      const row = el('div', 'recipe');
      row.innerHTML = `<div class="t"><b>${esc(r.name)}</b><span>${esc(r.steps.map(x => procDef(x.proc).name).join(' → '))}</span></div>`;
      const go = el('button', 'accent', 'Apply…'); go.onclick = () => applyDialog(r);
      row.appendChild(go);
      row.oncontextmenu = (e) => { e.preventDefault(); ctxMenu(e.clientX, e.clientY, [{ label: 'Rename…', fn: () => { const n = prompt('Recipe name', r.name); if (n) { checkpoint(); r.name = n; markDirty(); renderRecipes(); } } }, { label: 'Delete recipe', fn: () => { checkpoint(); S.recipes = S.recipes.filter(x => x !== r); markDirty(); renderRecipes(); } }]); };
      l.appendChild(row);
    }
  }
  function applyDialog(r) {
    if (!S.sounds.length) return toast('Import a sound first');
    const rows = S.sounds.map(s => `<label class="chk" style="display:flex;gap:6px;padding:3px 0"><input type="checkbox" value="${s.id}" ${s.id === S.view ? 'checked' : ''}> ${esc('  '.repeat(Math.min(6, depthOf(s))) + s.name)}</label>`).join('');
    const { m, close } = modal(`<h2>Apply “${esc(r.name)}”</h2><p>${esc(r.steps.map(x => procDef(x.proc).name).join(' → '))}</p>
      <div class="scroll" style="max-height:260px;border:1px solid var(--line2);border-radius:8px;padding:6px 10px">${rows}</div>
      <div class="foot"><span class="status" id="apStatus" style="flex:1;color:var(--dim)"></span><button id="apCancel">Close</button><button class="accent" id="apOk">Apply</button></div>`, 'wide');
    m.querySelector('#apCancel').onclick = close;
    m.querySelector('#apOk').onclick = async () => {
      const ids = [...m.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
      if (!ids.length) return;
      m.querySelector('#apOk').disabled = true;
      checkpoint();
      let last = null;
      for (let i = 0; i < ids.length; i++) {
        const src = byId(ids[i]); if (!src) continue;
        m.querySelector('#apStatus').textContent = `${i + 1} of ${ids.length}: ${src.name}`;
        try { last = await runRecipe(r, src, p => { m.querySelector('#apStatus').textContent = `${i + 1} of ${ids.length}: ${src.name} — ${Math.round(p * 100)}%`; }); }
        catch (e) { toast('Recipe stopped: ' + esc(e.message)); break; }
      }
      close();
      if (last) { selectSound(last.id, false); renderBin(); if (S.autoplay) play(0); }
      toast(`Applied “${esc(r.name)}” to ${ids.length} sound${ids.length > 1 ? 's' : ''}`);
    };
  }
  async function runRecipe(r, src, onProgress) {
    let cur = { sr: src.sr, ch: src.ch };
    for (let k = 0; k < r.steps.length; k++) {
      const st = r.steps[k], def = procDef(st.proc), dur = cur.ch[0].length / cur.sr;
      const values = denormaliseValues(st.values, dur);
      const prog = (p) => onProgress && onProgress((k + p) / r.steps.length);
      if (def.fx) { cur = await SP.Audio.renderFx(cur, st.effects || [], values); continue; }
      const inputs = [cur];
      if (def.inputs === 2) {
        const B = byId(st.inputB);
        if (!B) { toast(`Skipped “${esc(def.name)}”: its sound B (${esc(st.inputBName || '?')}) is no longer in the project`); continue; }
        inputs.push(B.sr === cur.sr ? B : { sr: cur.sr, ch: B.ch.map(c => SP.Audio.resample(c, B.sr, cur.sr)) });
      }
      cur = await SP.Jobs.run(def.id, inputs, values, prog);
    }
    if (S.normalise) { const pk = D.peakAll(cur.ch); if (pk > 1e-6) { const g = D.dbToGain(-1) / pk; cur.ch.forEach(c => { for (let i = 0; i < c.length; i++) c[i] *= g; }); } }
    return addSound({ name: src.name + ' · ' + r.name, sr: cur.sr, ch: cur.ch, parent: src.id, step: { proc: 'recipe', recipe: JSON.parse(JSON.stringify(r)) } });
  }

  // ---------- import ----------
  const AUDIO_RE = /\.(wav|wave|mp3|aif|aiff|aifc|flac|ogg|oga|m4a|aac|mp4|webm)$/i;
  async function importFiles(files) {
    let first = null, n = 0;
    for (const f of files) {
      if (!AUDIO_RE.test(f.name)) { toast(`Skipped ${esc(f.name)}: not a sound file`); continue; }
      try {
        const r = await SP.Audio.decodeFile(f.name, f.data);
        if (!r.ch.length || !r.ch[0].length) throw new Error('empty file');
        if (!first) checkpoint();
        const s = addSound({ name: f.name.replace(/\.[^.]+$/, ''), sr: r.sr, ch: r.ch });
        first = first || s; n++;
      } catch (e) { console.error(e); toast(`Could not read ${esc(f.name)}: ${esc(e.message)}`, 4000); }
    }
    if (first) { selectSound(first.id); toast(`Imported ${n} sound${n > 1 ? 's' : ''}`); }
  }
  async function importDialog() {
    if (native) { const files = await native.openAudio(); if (files && files.length) importFiles(files); }
    else $('audioInput').click();
  }
  function demoSound() {
    // a short phrase: plucked notes, a sung-vowel drone, a few noise hits - something with pitch, noise and attacks to transform
    const sr = 44100, dur = 6, n = sr * dur, L = new Float32Array(n), R = new Float32Array(n);
    let seed = 9; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const notes = [57, 64, 67, 69, 72, 69, 64, 62, 60, 64, 67, 76];
    notes.forEach((m, k) => {
      const f = 440 * Math.pow(2, (m - 69) / 12), t0 = 0.15 + k * 0.42, i0 = Math.round(t0 * sr), pan = 0.5 + 0.35 * Math.sin(k * 1.7);
      // Karplus-Strong pluck
      const P = Math.round(sr / f), buf = new Float32Array(P); for (let i = 0; i < P; i++) buf[i] = rnd() * 2 - 1;
      let idx = 0;
      for (let i = 0; i < sr * 1.6 && i0 + i < n; i++) { const a = buf[idx], b = buf[(idx + 1) % P]; buf[idx] = (a + b) * 0.4985; idx = (idx + 1) % P; const v = a * 0.35 * Math.min(1, i / 30); L[i0 + i] += v * (1 - pan); R[i0 + i] += v * pan; }
    });
    // vowel drone: saw through two moving formants
    let ph = 0, z1 = [0, 0], z2 = [0, 0];
    const bp = (x, f, q, z) => { const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * q), b0 = al, a0 = 1 + al, a1 = -2 * Math.cos(w), a2 = 1 - al; const y = (b0 * x - b0 * z[1] - a1 * z[0] - a2 * (z[2] || 0)) / a0; z[2] = z[0]; z[0] = y; z[1] = z[3] || 0; z[3] = x; return y; };
    for (let i = 0; i < n; i++) {
      const t = i / sr; ph += 110 * (1 + 0.004 * Math.sin(t * 5.5)) / sr; const saw = (ph % 1) * 2 - 1;
      const f1 = 500 + 250 * Math.sin(t * 0.7), f2 = 1400 + 700 * Math.sin(t * 0.43 + 1);
      const v = (bp(saw, f1, 6, z1) + bp(saw, f2, 8, z2) * 0.6) * 0.5 * Math.min(1, t / 1.5) * Math.min(1, (dur - t) / 1);
      L[i] += v * 0.9; R[i] += v * 0.7;
    }
    // noise hits
    for (const t0 of [1.2, 2.05, 3.3, 4.12, 4.95]) { const i0 = Math.round(t0 * sr); for (let i = 0; i < sr * 0.25 && i0 + i < n; i++) { const e = Math.exp(-i / (sr * 0.03)), v = (rnd() * 2 - 1) * e * 0.4; L[i0 + i] += v; R[i0 + i] += v * 0.8; } }
    const pk = Math.max(D.peak(L), D.peak(R)); for (let i = 0; i < n; i++) { L[i] *= 0.89 / pk; R[i] *= 0.89 / pk; }
    checkpoint();
    const s = addSound({ name: 'Demo phrase', sr, ch: [L, R] });
    selectSound(s.id);
  }

  // ---------- export ----------
  function exportDialog() {
    const s = viewed(); if (!s) return toast('Nothing to export yet');
    const { m, close } = modal(`<h2>Export</h2>
      <div class="field"><label>What</label><select id="exWhat"><option value="one">This sound: ${esc(s.name)}</option><option value="all">All ${S.sounds.length} sounds, into a folder</option></select></div>
      <div class="field"><label>Format</label><select id="exFmt"><option value="w24">WAV, 24-bit</option><option value="w16">WAV, 16-bit</option><option value="w32">WAV, 32-bit float</option><option value="m320">MP3, 320 kbps</option><option value="m192">MP3, 192 kbps</option></select></div>
      <p class="hint">WAV keeps the sound's own sample rate (${s.sr} Hz). 32-bit float keeps levels above 0 dB without clipping.</p>
      <div class="progress" id="exProg"><i></i></div>
      <div class="foot"><button id="exCancel">Cancel</button><button class="accent" id="exOk">Export</button></div>`);
    m.querySelector('#exCancel').onclick = close;
    m.querySelector('#exOk').onclick = async () => {
      const what = m.querySelector('#exWhat').value, fmt = m.querySelector('#exFmt').value;
      const prog = m.querySelector('#exProg'); prog.style.display = 'block';
      const encode = async (snd) => fmt[0] === 'w' ? SP.Audio.encodeWav(snd, parseInt(fmt.slice(1), 10)) : SP.Audio.encodeMp3(snd, parseInt(fmt.slice(1), 10), p => prog.firstChild.style.width = Math.round(p * 100) + '%');
      const ext = fmt[0] === 'w' ? 'wav' : 'mp3';
      const fname = (snd) => snd.name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) + '.' + ext;
      try {
        if (what === 'one') {
          const bytes = await encode(s);
          if (native) { const p = await native.saveFile({ defaultPath: fname(s), filters: [{ name: ext.toUpperCase(), extensions: [ext] }], data: bytes, encoding: 'binary' }); if (p) toast('Saved ' + esc(p.split(/[\\/]/).pop())); }
          else download(bytes, fname(s), ext === 'wav' ? 'audio/wav' : 'audio/mpeg');
        } else {
          if (native) {
            const folder = await native.chooseFolder({ title: 'Choose a folder for the sounds' }); if (!folder) return;
            for (let i = 0; i < S.sounds.length; i++) { prog.firstChild.style.width = Math.round(i / S.sounds.length * 100) + '%'; await native.writeInFolder({ folder, name: fname(S.sounds[i]), data: await encode(S.sounds[i]) }); }
            toast(`Saved ${S.sounds.length} files`);
          } else for (const x of S.sounds) download(await encode(x), fname(x), 'audio/wav');
        }
        close();
      } catch (e) { console.error(e); toast('Export failed: ' + esc(e.message)); }
    };
  }
  function download(bytes, name, type) {
    const a = el('a'); a.href = URL.createObjectURL(new Blob([bytes], { type })); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // ---------- project files ----------
  function serialise() {
    return JSON.stringify({
      app: 'kiln', version: 1, saved: new Date().toISOString(),
      sounds: S.sounds.map(s => ({ id: s.id, name: s.name, parent: s.parent, step: s.step, sr: s.sr, ch: s.ch.map(c => SP.f32ToB64(c)), sel: s === viewed() ? view.sel : s._sel || null })),
      recipes: S.recipes,
      ui: { view: S.view, inA: S.inA, inB: S.inB, proc: S.proc, vals: S.vals, envDur: S.envDur, effects: S.effects, selOnly: S.selOnly, normalise: S.normalise, autoplay: S.autoplay, replace: S.replace }
    });
  }
  function load(text, path) {
    const j = JSON.parse(text);
    if (j.app !== 'kiln') throw new Error('This is not a Kiln project');
    player.stop();
    S.sounds = j.sounds.map(s => ({ id: s.id, name: s.name, parent: s.parent, step: s.step, sr: s.sr, ch: s.ch.map(b => new Float32Array(SP.b64ToF32(b))), _sel: s.sel || null, _v: 1 }));
    S.recipes = j.recipes || [];
    const u = j.ui || {};
    Object.assign(S, { proc: PROCS[u.proc] ? u.proc : 'spec.blur', vals: u.vals || {}, envDur: u.envDur || {}, effects: u.effects || [], selOnly: u.selOnly !== false, normalise: u.normalise !== false, autoplay: u.autoplay !== false, replace: !!u.replace });
    S.view = byId(u.view) ? u.view : (S.sounds[0] || {}).id || null;
    S.inA = byId(u.inA) ? u.inA : S.view; S.inB = byId(u.inB) ? u.inB : null;
    S.path = path || null; S.dirty = false; native && native.setDirty(false);
    undoStack.length = redoStack.length = 0;
    view.setSound(viewed());
    renderAll(); updateTitle();
  }
  async function save(as) {
    const text = serialise();
    if (native) {
      const p = await native.saveFile({ defaultPath: S.path || 'Untitled.kiln', filters: [{ name: 'Kiln project', extensions: ['kiln'] }], data: text, path: as ? null : S.path });
      if (!p) return false;
      S.path = p;
    } else download(new TextEncoder().encode(text), 'Untitled.kiln', 'application/json');
    S.dirty = false; native && native.setDirty(false); updateTitle(); toast('Project saved');
    return true;
  }
  async function openProject() {
    if (S.dirty) { const r = await confirmBox('Open another project?', 'Unsaved changes in this one will be lost.', ['Open', 'Cancel']); if (r !== 0) return; }
    if (native) { const f = await native.openProject(); if (f) try { load(f.content, f.path); } catch (e) { toast('Could not open: ' + esc(e.message)); } }
    else $('fileInput').click();
  }
  async function newProject() {
    if (S.dirty) { const r = await confirmBox('Start a new project?', 'Unsaved changes will be lost.', ['New project', 'Cancel']); if (r !== 0) return; }
    player.stop();
    Object.assign(S, { sounds: [], view: null, inA: null, inB: null, recipes: [], path: null, dirty: false, lastResult: null });
    undoStack.length = redoStack.length = 0; native && native.setDirty(false);
    view.setSound(null); renderAll(); updateTitle();
  }

  // ---------- wiring ----------
  function renderAll() { view.setSound(viewed(), true); renderBin(); renderSoundBar(); renderHistory(); renderChips(); renderProcList(); renderPanel(); renderRecipes(); }
  function command(cmd) {
    switch (cmd) {
      case 'new': return newProject();
      case 'open': return openProject();
      case 'save': return save(false);
      case 'save-as': return save(true);
      case 'save-then-close': return save(false).then(ok => { if (ok) native.closeNow(); });
      case 'import': return importDialog();
      case 'export': return exportDialog();
      case 'undo': return undo();
      case 'redo': return redo();
      case 'select-all': if (viewed()) { view.sel = [0, view.dur]; view.draw(); onSelect(view.sel, false); } return;
      case 'crop': return cropSelection();
      case 'rename': return S.view && renameSound(S.view);
      case 'delete': return S.view && deleteSound(S.view);
      case 'render': return render();
      case 'chain': return chainResult();
      case 'find': $('procSearch').focus(); $('procSearch').select(); return;
      case 'save-recipe': return saveRecipe();
      case 'toggle-play': return togglePlay();
      case 'compare': return compare();
      case 'home': view.cursor = 0; view.sel = null; view.v0 = 0; view.v1 = view.dur; view.spec = null; view.draw(); renderSelInfo(); if (player.playing) play(0); return;
      case 'loop': player.loop = !player.loop; $('loopBtn').classList.toggle('on', player.loop); if (player.playing) play(player.position()); return;
    }
  }
  function onSelect(sel, live) {
    const s = viewed(); if (s) s._sel = sel ? sel.slice() : null;
    renderSelInfo();
    if (!live) { if (S.inA === S.view) syncEnvDur(); renderPanel(); }
  }

  function init() {
    SP.app = { touch: markDirty, commit: markDirty };
    view = new SP.WaveView($('wave'), {
      onSelect, onCursor: () => { if (player.playing && player.snd === viewed()) play(view.cursor); }
    });
    view.mode = 'wave';
    player.on(playing => { $('playBtn').classList.toggle('playing', playing); $('playIcon').setAttribute('d', playing ? 'M6 5h4v14H6zm8 0h4v14h-4z' : 'M7 4.5v15l13-7.5z'); });

    $('playBtn').onclick = togglePlay; $('homeBtn').onclick = () => command('home'); $('loopBtn').onclick = () => command('loop'); $('compareBtn').onclick = compare;
    $('master').oninput = (e) => player.setVolume(+e.target.value);
    $('viewSeg').querySelectorAll('button').forEach(b => b.onclick = () => { $('viewSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); view.setMode(b.dataset.v); });
    $('zoomSel').onclick = () => view.zoomToSel(); $('zoomAll').onclick = () => view.zoomAll();
    $('newBtn').onclick = newProject; $('openBtn').onclick = openProject; $('saveBtn').onclick = () => save(false); $('exportBtn').onclick = exportDialog;
    $('importBtn').onclick = importDialog; $('welcomeImport').onclick = importDialog; $('welcomeDemo').onclick = demoSound;
    $('cropBtn').onclick = cropSelection; $('recipeBtn').onclick = saveRecipe;
    $('sndName').ondblclick = startRename;
    $('procSearch').oninput = (e) => { S.search = e.target.value; renderProcList(); };
    $('procSearch').onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const first = document.querySelector('#procList .proc'); if (first) first.click(); e.target.blur(); }
      if (e.key === 'Escape') { e.target.value = ''; S.search = ''; renderProcList(); e.target.blur(); }
    };
    $('audioInput').onchange = async (e) => { const files = await Promise.all([...e.target.files].map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))); e.target.value = ''; importFiles(files); };
    $('fileInput').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { load(await f.text(), null); } catch (err) { toast('Could not open: ' + esc(err.message)); } };

    // drag and drop
    let dragN = 0;
    window.addEventListener('dragenter', e => { e.preventDefault(); dragN++; document.body.classList.add('dragover'); });
    window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('dragover'); } });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
      e.preventDefault(); dragN = 0; document.body.classList.remove('dragover');
      const fl = [...e.dataTransfer.files];
      const proj = fl.find(f => /\.kiln$/i.test(f.name));
      if (proj) { try { load(await proj.text(), null); } catch (err) { toast('Could not open: ' + esc(err.message)); } return; }
      importFiles(await Promise.all(fl.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
    });

    // splitter between view and process panel
    const sp = $('splitter'), pp = $('procPanel');
    sp.addEventListener('pointerdown', e => {
      sp.setPointerCapture(e.pointerId); const y0 = e.clientY, h0 = pp.getBoundingClientRect().height;
      const mv = (ev) => { const h = Math.max(200, Math.min(innerHeight - 260, h0 - (ev.clientY - y0))); pp.style.flex = `0 0 ${h}px`; };
      const up = () => { sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); };
      sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up);
    });

    // keyboard
    window.addEventListener('keydown', e => {
      const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'Enter') { e.preventDefault(); return render(); }
      if (typing) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Enter') { e.preventDefault(); command('home'); }
      else if (e.key === 'Escape') { if (S.busy) SP.Jobs.cancel(); else if (view.sel) { view.sel = null; view.draw(); onSelect(null, false); } }
      else if (!native && mod) {
        const k = e.key.toLowerCase();
        const map = { z: e.shiftKey ? 'redo' : 'undo', s: 'save', o: 'open', e: 'export', i: 'import', d: 'crop', j: 'chain', f: 'find', b: 'compare', l: 'loop', a: 'select-all' };
        if (map[k]) { e.preventDefault(); command(map[k]); }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.view && !mod) { e.preventDefault(); deleteSound(S.view); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); const i = S.sounds.findIndex(s => s.id === S.view), j = i + (e.key === 'ArrowUp' ? -1 : 1);
        if (S.sounds[j]) selectSound(S.sounds[j].id);
      }
    });
    if (native) { native.onMenu(command); native.onOpenProject(({ path, content }) => { try { load(content, path); } catch (e) { toast('Could not open: ' + esc(e.message)); } }); }
    window.addEventListener('beforeunload', e => { if (S.dirty && !native) { e.preventDefault(); e.returnValue = ''; } });

    renderAll(); updateTitle();
    requestAnimationFrame(tick);
    // test hook
    window.__kiln = { S, render, selectSound, demoSound, command, view: () => view, player, load, serialise, runRecipe, importFiles };
  }
  init();
})();
