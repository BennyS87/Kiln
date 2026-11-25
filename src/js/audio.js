// Kiln - audio I/O and playback: file decoding (WAV and AIFF read natively at their own sample rate),
// WAV / MP3 writing, the player, and offline rendering of the shared effect chain.
(function () {
  const SP = window.Kiln;

  // ---------------- decoding ----------------
  const str4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  function deinterleave(dv, off, frames, nCh, bits, fmt, little) {
    const ch = []; for (let c = 0; c < nCh; c++) ch.push(new Float32Array(frames));
    const bps = bits / 8;
    for (let i = 0, o = off; i < frames; i++) for (let c = 0; c < nCh; c++, o += bps) {
      let v;
      if (fmt === 3) v = bits === 64 ? dv.getFloat64(o, little) : dv.getFloat32(o, little);
      else if (bits === 8) v = little ? (dv.getUint8(o) - 128) / 128 : dv.getInt8(o) / 128;
      else if (bits === 16) v = dv.getInt16(o, little) / 32768;
      else if (bits === 24) { const b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2); let n = little ? (b0 | (b1 << 8) | (b2 << 16)) : ((b0 << 16) | (b1 << 8) | b2); if (n & 0x800000) n -= 0x1000000; v = n / 8388608; }
      else v = dv.getInt32(o, little) / 2147483648;
      ch[c][i] = v;
    }
    return ch;
  }
  function parseWav(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (str4(dv, 0) !== 'RIFF' && str4(dv, 0) !== 'RF64') return null;
    if (str4(dv, 8) !== 'WAVE') return null;
    let o = 12, fmt = null, data = null;
    while (o + 8 <= dv.byteLength) {
      const id = str4(dv, o); let size = dv.getUint32(o + 4, true);
      if (id === 'fmt ') {
        let tag = dv.getUint16(o + 8, true);
        const nCh = dv.getUint16(o + 10, true), sr = dv.getUint32(o + 12, true), bits = dv.getUint16(o + 22, true);
        if (tag === 0xFFFE && size >= 40) tag = dv.getUint16(o + 32, true); // extensible: sub-format GUID
        fmt = { tag, nCh, sr, bits };
      } else if (id === 'data') { if (size === 0xFFFFFFFF || o + 8 + size > dv.byteLength) size = dv.byteLength - o - 8; data = { off: o + 8, size }; }
      o += 8 + size + (size & 1);
      if (fmt && data) break;
    }
    if (!fmt || !data || (fmt.tag !== 1 && fmt.tag !== 3)) return null;
    const frames = Math.floor(data.size / (fmt.nCh * fmt.bits / 8));
    return { sr: fmt.sr, ch: deinterleave(dv, data.off, frames, fmt.nCh, fmt.bits, fmt.tag, true) };
  }
  // 80-bit IEEE extended float (AIFF sample rate)
  function ext80(dv, o) {
    const e = dv.getUint16(o) & 0x7fff, hi = dv.getUint32(o + 2), lo = dv.getUint32(o + 6);
    if (e === 0 && hi === 0 && lo === 0) return 0;
    return (hi * Math.pow(2, -31) + lo * Math.pow(2, -63)) * Math.pow(2, e - 16383);
  }
  function parseAiff(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (str4(dv, 0) !== 'FORM') return null;
    const form = str4(dv, 8); if (form !== 'AIFF' && form !== 'AIFC') return null;
    let o = 12, comm = null, ssnd = null;
    while (o + 8 <= dv.byteLength) {
      const id = str4(dv, o), size = dv.getUint32(o + 4);
      if (id === 'COMM') {
        comm = { nCh: dv.getUint16(o + 8), frames: dv.getUint32(o + 10), bits: dv.getUint16(o + 14), sr: ext80(dv, o + 16), comp: form === 'AIFC' ? str4(dv, o + 26) : 'NONE' };
      } else if (id === 'SSND') { const off = dv.getUint32(o + 8); ssnd = { off: o + 16 + off }; }
      o += 8 + size + (size & 1);
    }
    if (!comm || !ssnd) return null;
    const c = comm.comp.toLowerCase();
    let little = false, fmt = 1, bits = comm.bits;
    if (c === 'sowt') little = true;
    else if (c === 'fl32') { fmt = 3; bits = 32; } else if (c === 'fl64') { fmt = 3; bits = 64; }
    else if (c !== 'none' && c !== 'twos') throw new Error('Compressed AIFF-C (' + comm.comp + ') is not supported');
    const frames = Math.min(comm.frames, Math.floor((dv.byteLength - ssnd.off) / (comm.nCh * bits / 8)));
    return { sr: Math.round(comm.sr), ch: deinterleave(dv, ssnd.off, frames, comm.nCh, bits, fmt, little) };
  }
  let decodeCtx = null;
  async function decodeFile(name, bytes) {
    let r = null;
    try { r = parseWav(bytes) || parseAiff(bytes); } catch (e) { if (/AIFF-C/.test(e.message)) throw e; r = null; }
    if (!r) {
      decodeCtx = decodeCtx || new (window.AudioContext || window.webkitAudioContext)();
      const buf = await decodeCtx.decodeAudioData(bytes.slice().buffer);
      const ch = []; for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c).slice());
      r = { sr: buf.sampleRate, ch };
    }
    // Kiln works in mono and stereo; extra channels are folded down to stereo
    if (r.ch.length > 2) {
      const n = r.ch[0].length, L = new Float32Array(n), R = new Float32Array(n);
      r.ch.forEach((c, i) => { const t = i % 2 ? R : L; for (let j = 0; j < n; j++) t[j] += c[j] * 2 / r.ch.length; });
      r.ch = [L, R];
    }
    return r;
  }

  // ---------------- encoding ----------------
  function encodeWav(snd, bits) {
    bits = bits || 24;
    const nCh = snd.ch.length, n = snd.ch[0].length, bps = bits / 8, float = bits === 32;
    const dataLen = n * nCh * bps, buf = new ArrayBuffer(44 + dataLen), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, float ? 3 : 1, true); dv.setUint16(22, nCh, true);
    dv.setUint32(24, snd.sr, true); dv.setUint32(28, snd.sr * nCh * bps, true); dv.setUint16(32, nCh * bps, true); dv.setUint16(34, bits, true);
    w(36, 'data'); dv.setUint32(40, dataLen, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
      const v = snd.ch[c][i];
      if (float) { dv.setFloat32(o, v, true); o += 4; continue; }
      const x = Math.max(-1, Math.min(1, v));
      if (bits === 16) { dv.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); o += 2; }
      else { let q = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff); if (q < 0) q += 0x1000000; dv.setUint8(o, q & 255); dv.setUint8(o + 1, (q >> 8) & 255); dv.setUint8(o + 2, (q >> 16) & 255); o += 3; }
    }
    return new Uint8Array(buf);
  }
  async function encodeMp3(snd, kbps, onProgress) {
    if (!window.lamejs) throw new Error('MP3 encoder not loaded');
    let sr = snd.sr, L = snd.ch[0], R = snd.ch.length > 1 ? snd.ch[1] : L;
    const OK = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
    if (!OK.includes(sr)) { const to = sr > 48000 ? 48000 : 44100; L = resample(L, sr, to); R = R === snd.ch[0] ? L : resample(R, sr, to); sr = to; }
    const enc = new lamejs.Mp3Encoder(2, sr, kbps || 192);
    const block = 1152, len = L.length, l16 = new Int16Array(block), r16 = new Int16Array(block), parts = [];
    let lastYield = performance.now();
    for (let i = 0; i < len; i += block) {
      const n = Math.min(block, len - i);
      for (let j = 0; j < n; j++) { const a = Math.max(-1, Math.min(1, L[i + j])), b = Math.max(-1, Math.min(1, R[i + j])); l16[j] = a < 0 ? a * 0x8000 : a * 0x7fff; r16[j] = b < 0 ? b * 0x8000 : b * 0x7fff; }
      const mp3 = enc.encodeBuffer(n === block ? l16 : l16.subarray(0, n), n === block ? r16 : r16.subarray(0, n));
      if (mp3.length) parts.push(new Uint8Array(mp3));
      if (performance.now() - lastYield > 30) { if (onProgress) onProgress(i / len); await new Promise(r => setTimeout(r, 0)); lastYield = performance.now(); }
    }
    const end = enc.flush(); if (end.length) parts.push(new Uint8Array(end));
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function resample(x, from, to) {
    const n = Math.round(x.length * to / from), y = new Float32Array(n), k = from / to;
    for (let i = 0; i < n; i++) { const p = i * k, j = Math.floor(p), f = p - j; y[i] = (x[j] || 0) + ((x[j + 1] || 0) - (x[j] || 0)) * f; }
    return y;
  }

  // ---------------- player ----------------
  class Player {
    constructor() { this.ctx = null; this.src = null; this.playing = false; this.loop = false; this.listeners = []; this.volume = 0.85; }
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain(); this.master.gain.value = this.volume;
      this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 2048;
      this.splitter = this.ctx.createChannelSplitter(2);
      this.aL = this.ctx.createAnalyser(); this.aR = this.ctx.createAnalyser(); this.aL.fftSize = this.aR.fftSize = 1024;
      this.master.connect(this.ctx.destination); this.master.connect(this.splitter);
      this.splitter.connect(this.aL, 0); this.splitter.connect(this.aR, 1);
    }
    setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
    bufferFor(snd) {
      if (snd._ab && snd._ab._v === snd._v) return snd._ab;
      const ab = this.ctx.createBuffer(snd.ch.length, snd.ch[0].length, snd.sr);
      snd.ch.forEach((c, i) => ab.copyToChannel(c, i));
      ab._v = snd._v; snd._ab = ab;
      return ab;
    }
    /** play snd from `from` seconds; if `to` is given, stop (or loop back) there */
    play(snd, from, to, tag) {
      this.init(); this.stop(true);
      const ab = this.bufferFor(snd), dur = ab.duration;
      from = Math.max(0, Math.min(from || 0, dur - 0.001));
      const end = to != null && to > from + 0.005 ? Math.min(to, dur) : dur;
      const src = this.ctx.createBufferSource(); src.buffer = ab;
      const g = this.ctx.createGain(); g.gain.value = 0;
      const t0 = this.ctx.currentTime + 0.01;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(1, t0 + 0.004);
      src.connect(g).connect(this.master);
      if (this.loop) { src.loop = true; src.loopStart = to != null ? from : 0; src.loopEnd = end; src.start(t0, from); }
      else src.start(t0, from, end - from);
      this.src = src; this.gain = g; this.playing = true; this.snd = snd; this.tag = tag || null;
      this.t0 = t0; this.from = from; this.end = end; this.loopStart = src.loopStart;
      src.onended = () => { if (this.src === src) { this.playing = false; this.src = null; this.emit(); } };
      this.emit();
    }
    stop(quiet) {
      if (this.src) { const s = this.src, g = this.gain, t = this.ctx.currentTime; try { g.gain.setTargetAtTime(0, t, 0.006); s.stop(t + 0.04); } catch (e) { } this.src = null; }
      this.playing = false; if (!quiet) this.emit();
    }
    position() {
      if (!this.playing || !this.ctx) return null;
      let p = this.from + (this.ctx.currentTime - this.t0);
      if (this.loop && this.src && this.src.loop) { const ls = this.loopStart, le = this.end; if (p > le) p = ls + ((p - ls) % Math.max(0.001, le - ls)); }
      return Math.max(0, Math.min(p, this.end));
    }
    levels() {
      if (!this.ctx) return [0, 0];
      const d = new Float32Array(1024), out = [];
      for (const a of [this.aL, this.aR]) { a.getFloatTimeDomainData(d); let m = 0; for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i])); out.push(m); }
      return out;
    }
    on(fn) { this.listeners.push(fn); }
    emit() { for (const f of this.listeners) f(this.playing); }
  }

  // ---------------- the shared effect chain, rendered offline ----------------
  const stereoGain = (ctx, v) => { const n = ctx.createGain(); n.gain.value = v == null ? 1 : v; n.channelCount = 2; n.channelCountMode = 'explicit'; return n; };
  class FxChain { // same as Spiders / Orbit
    constructor(ctx, input, output) { this.ctx = ctx; this.input = input; this.output = output; this.fx = []; }
    build(effects, bpm) {
      const active = (effects || []).filter(f => f.on);
      let prev = this.input;
      for (const f of active) { const node = SP.FX.build(this.ctx, f, bpm); prev.connect(node.input); prev = node.output; this.fx.push(node); }
      prev.connect(this.output);
    }
    schedule(t0, b0, b1, spb) { for (const n of this.fx) if (n.schedule) n.schedule(t0, b0, b1, spb); }
  }
  async function renderFx(snd, effects, opts) {
    const bpm = opts.bpm || 120, tail = Math.max(0, opts.tail || 0), sr = snd.sr;
    const len = snd.ch[0].length + Math.round(tail * sr);
    const ctx = new OfflineAudioContext(2, Math.max(1, len), sr);
    const ab = ctx.createBuffer(snd.ch.length, snd.ch[0].length, sr);
    snd.ch.forEach((c, i) => ab.copyToChannel(c, i));
    const src = ctx.createBufferSource(); src.buffer = ab;
    const input = stereoGain(ctx), out = stereoGain(ctx, D_gain(opts.gain));
    src.connect(input); out.connect(ctx.destination);
    const chain = new FxChain(ctx, input, out); chain.build(effects, bpm);
    const spb = 60 / bpm; chain.schedule(0, 0, len / sr / spb + 1, spb);
    src.start(0);
    const res = await ctx.startRendering();
    let ch = [res.getChannelData(0).slice(), res.getChannelData(1).slice()];
    if (snd.ch.length === 1 && opts.keepMono) { const m = new Float32Array(ch[0].length); for (let i = 0; i < m.length; i++) m[i] = (ch[0][i] + ch[1][i]) * 0.5; ch = [m]; }
    // trim the silent end of the tail
    let end = ch[0].length; const floor = 1e-5;
    while (end > snd.ch[0].length && ch.every(c => Math.abs(c[end - 1]) < floor)) end--;
    return { sr, ch: ch.map(c => c.slice(0, end)) };
  }
  const D_gain = (db) => Math.pow(10, (db || 0) / 20);

  SP.Audio = { decodeFile, encodeWav, encodeMp3, resample, Player, renderFx, parseWav, parseAiff };
})();
