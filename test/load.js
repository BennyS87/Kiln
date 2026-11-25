// Loads the DSP modules in Node the same way the worker does
const fs = require('fs'), path = require('path'), vm = require('vm');
module.exports = function load() {
  const g = { Math, Float32Array, Float64Array, Uint8Array, Uint32Array, Int16Array, Array, Object, JSON, Error, isFinite, parseInt, parseFloat, Number, String, console };
  g.self = g; vm.createContext(g);
  const dir = path.join(__dirname, '..', 'src', 'dsp');
  const files = ['core.js'].concat(fs.readdirSync(dir).filter(f => f !== 'core.js' && f.endsWith('.js')).sort());
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), g, { filename: f });
  const D = {}; for (const m of g.KilnDSPModules) m(D);
  return D;
};
