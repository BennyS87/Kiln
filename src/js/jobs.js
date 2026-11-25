// Kiln - runs the DSP processes in a background worker built from the same source as the window copy.
(function () {
  const SP = window.Kiln;
  const D = (window.KilnDSP = {});
  for (const m of window.KilnDSPModules) m(D);
  SP.DSP = D;

  const WORKER_SRC = 'const D = {};\n' + window.KilnDSPModules.map(f => '(' + f.toString() + ')(D);').join('\n') + `
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'run') {
      let last = 0;
      const res = D.run(m.proc, m.inputs, m.values, (p) => { const now = Date.now(); if (now - last > 80) { last = now; self.postMessage({ id: m.id, progress: p }); } });
      self.postMessage({ id: m.id, ok: true, res }, res.ch.map(c => c.buffer));
    } else if (m.type === 'spectrogram') {
      const s = D.spectrogram(m.x, m.sr, m.cols, m.rows);
      self.postMessage({ id: m.id, ok: true, res: s }, [s.data.buffer]);
    }
  } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
};`;

  let worker = null, specWorker = null, nextId = 1;
  const pending = new Map();
  function makeWorker() {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onmessage = (e) => {
        const m = e.data, p = pending.get(m.id); if (!p) return;
        if (m.progress != null) { p.onProgress && p.onProgress(m.progress); return; }
        pending.delete(m.id);
        if (m.ok) p.resolve(m.res); else p.reject(new Error(m.error));
      };
      w.onerror = (e) => { for (const [id, p] of pending) if (p.worker === w) { pending.delete(id); p.reject(new Error(e.message || 'Worker error')); } };
      return w;
    } catch (e) { console.warn('Worker unavailable, running on the main thread', e); return null; }
  }
  function ensure() { if (!worker) worker = makeWorker(); return worker; }

  const copyIn = (snd) => ({ sr: snd.sr, ch: snd.ch.map(c => c.slice()) });

  /** run a DSP process; inputs: [{sr, ch}] ; returns {sr, ch} */
  function run(proc, inputs, values, onProgress) {
    const w = ensure();
    if (!w) return new Promise((resolve, reject) => setTimeout(() => { try { resolve(D.run(proc, inputs, values, onProgress)); } catch (e) { reject(e); } }, 10));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress, worker: w });
      w.postMessage({ id, type: 'run', proc, inputs: inputs.map(copyIn), values });
    });
  }
  /** stop whatever is rendering */
  function cancel() {
    if (!worker) return;
    worker.terminate();
    for (const [id, p] of pending) if (p.worker === worker) { pending.delete(id); p.reject(new Error('Cancelled')); }
    worker = null;
  }
  function spectrogram(x, sr, cols, rows) {
    if (!specWorker) specWorker = makeWorker();
    const w = specWorker;
    if (!w) return Promise.resolve(D.spectrogram(x, sr, cols, rows));
    const id = nextId++;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, worker: w }); w.postMessage({ id, type: 'spectrogram', x, sr, cols, rows }); });
  }

  SP.Jobs = { run, cancel, spectrogram };
})();
