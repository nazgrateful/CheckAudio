/*
 * CheckAudio history: saves every analysis in this browser (IndexedDB) so past
 * files can be reopened without the audio. Only results are stored (findings,
 * measurements, chart data, layer summaries, transcript), never the audio itself.
 *
 * Two object stores: "summaries" (small, for the list) and "details" (full results).
 */
(function (root) {
  'use strict';

  const DB = 'checkaudio', VERSION = 1;
  const PREF = 'checkaudio.saveHistory';
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!root.indexedDB) return reject(new Error('This browser cannot store history.'));
        const req = root.indexedDB.open(DB, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('details')) db.createObjectStore('details', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error || new Error('Could not open history storage.')); };
      });
    }
    return dbPromise;
  }

  async function run(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const result = fn(...stores.map((s) => tx.objectStore(s)));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('History storage was blocked or is full.'));
    });
  }

  // --------------------------------------------------------- compaction ---

  const spec = (s) => s && { binHz: s.binHz, sampleRate: s.sampleRate, size: s.size, dB: Float32Array.from(s.dB) };

  /** Spectrogram to at most `maxCols` columns of 8-bit values. */
  function packSpectrogram(sg, maxCols = 350) {
    if (!sg) return null;
    const step = Math.max(1, Math.ceil(sg.columns / maxCols));
    const cols = Math.ceil(sg.columns / step);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < sg.data.length; i++) { const v = sg.data[i]; if (v > hi) hi = v; if (v < lo) lo = v; }
    lo = Math.max(lo, hi - 120);
    const q = new Uint8Array(cols * sg.bins);
    for (let c = 0; c < cols; c++) {
      const src = c * step * sg.bins, dst = c * sg.bins;
      for (let k = 0; k < sg.bins; k++) q[dst + k] = Math.max(0, Math.min(255, Math.round(((sg.data[src + k] - lo) / (hi - lo || 1)) * 255)));
    }
    return { columns: cols, bins: sg.bins, binHz: sg.binHz, lo, hi, q };
  }

  function unpackSpectrogram(p) {
    if (!p) return null;
    const data = new Float32Array(p.q.length);
    for (let i = 0; i < p.q.length; i++) data[i] = p.lo + (p.q[i] / 255) * (p.hi - p.lo);
    return { columns: p.columns, bins: p.bins, binHz: p.binHz, data };
  }

  /** Build the stored record from the app's state. */
  function pack(state) {
    const id = (state.scan && state.scan.sha256) || `${state.file.name}:${state.file.size}`;
    const r = state.report;
    const report = r && { ...r, spectrum: spec(r.spectrum) };
    const summary = {
      id,
      name: state.file.name,
      size: state.file.size,
      savedAt: Date.now(),
      detected: state.scan ? state.scan.detected.name : null,
      security: state.scan ? state.scan.verdict : null,
      score: r ? r.score : null,
      verdict: r ? r.verdict : null,
      duration: r ? r.info.duration : null,
      sampleRate: r ? r.info.sampleRate : null,
      channels: r ? r.info.channels : null,
      hasLayers: Boolean(state.layers),
      hasTranscript: Boolean(state.transcript),
    };
    const details = {
      id,
      scan: state.scan,
      report,
      format: state.format,
      resampled: state.resampled,
      envelope: state.envelope,
      sgram: packSpectrogram(state.sgram),
      layers: state.layers && state.layers.map(({ signal, spectrum, ...l }) => ({ ...l, spectrum: spec(spectrum) })),
      tones: state.tones,
      transcript: state.transcript && { text: state.transcript.text, chunks: state.transcript.chunks },
    };
    return { summary, details };
  }

  // ---------------------------------------------------------------- API ---

  const enabled = () => { try { return root.localStorage.getItem(PREF) !== '0'; } catch (e) { return true; } };
  const setEnabled = (on) => { try { root.localStorage.setItem(PREF, on ? '1' : '0'); } catch (e) { /* private mode */ } };

  /** Save (or update) the analysis for the current file. */
  async function save(state) {
    if (!enabled() || !state.file) return null;
    const { summary, details } = pack(state);
    await run(['summaries', 'details'], 'readwrite', (s, d) => { s.put(summary); d.put(details); });
    return summary.id;
  }

  /** All saved summaries, newest first. */
  async function list() {
    const all = await run(['summaries'], 'readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => b.savedAt - a.savedAt);
  }

  /** One saved analysis, ready to render. */
  async function load(id) {
    const [summary, details] = await Promise.all([
      run(['summaries'], 'readonly', (s) => s.get(id)),
      run(['details'], 'readonly', (d) => d.get(id)),
    ]);
    if (!summary || !details) return null;
    return { summary, ...details, sgram: unpackSpectrogram(details.sgram) };
  }

  const remove = (id) => run(['summaries', 'details'], 'readwrite', (s, d) => { s.delete(id); d.delete(id); });
  const clear = () => run(['summaries', 'details'], 'readwrite', (s, d) => { s.clear(); d.clear(); });

  root.AudioHistory = { save, list, load, remove, clear, enabled, setEnabled, pack, packSpectrogram, unpackSpectrogram };
})(typeof self !== 'undefined' ? self : this);
