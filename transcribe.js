/*
 * CheckAudio transcription: Whisper via transformers.js, run in a Web Worker
 * so the page stays responsive. The worker is built from a Blob so the app
 * also works when index.html is opened straight from disk.
 */
(function (root) {
  'use strict';

  const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2';

  const WORKER_SOURCE = `
    import { pipeline, env } from '${TRANSFORMERS}';
    env.allowLocalModels = false;
    let asr = null, loaded = null;

    async function hasWebGPU() {
      try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { return false; }
    }

    self.onmessage = async (e) => {
      const { audio, model, language } = e.data;
      try {
        if (!asr || loaded !== model) {
          const device = (await hasWebGPU()) ? 'webgpu' : 'wasm';
          asr = await pipeline('automatic-speech-recognition', model, {
            device,
            dtype: device === 'webgpu' ? 'fp32' : 'q8',
            progress_callback: (p) => self.postMessage({ type: 'download', data: p }),
          });
          loaded = model;
        }
        self.postMessage({ type: 'status', text: 'Transcribing… (this can take a while for long files)' });
        const options = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, task: 'transcribe' };
        if (language) options.language = language;
        const result = await asr(audio, options);
        self.postMessage({ type: 'done', result });
      } catch (err) {
        self.postMessage({ type: 'error', message: String((err && err.message) || err) });
      }
    };
  `;

  let worker = null;
  function getWorker() {
    if (!worker) {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      worker = new Worker(url, { type: 'module' });
    }
    return worker;
  }

  /** Resample mono audio to the 16 kHz Whisper expects. */
  async function to16k(signal, sampleRate) {
    const target = 16000;
    if (sampleRate === target) return Float32Array.from(signal);
    const ctx = new OfflineAudioContext(1, Math.ceil((signal.length * target) / sampleRate), target);
    const buf = ctx.createBuffer(1, signal.length, sampleRate);
    buf.copyToChannel(signal, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    const out = await ctx.startRendering();
    return out.getChannelData(0).slice();
  }

  /**
   * Transcribe mono audio.
   * @param {Float32Array} signal
   * @param {number} sampleRate
   * @param {{model: string, language?: string, onStatus?: (text: string, fraction?: number) => void}} opts
   * @returns {Promise<{text: string, chunks: {timestamp: [number, number|null], text: string}[]}>}
   */
  async function transcribe(signal, sampleRate, { model, language, onStatus }) {
    onStatus && onStatus('Preparing audio…');
    const audio = await to16k(signal, sampleRate);
    const w = getWorker();
    const files = new Map();
    return new Promise((resolve, reject) => {
      w.onerror = (e) => reject(new Error(e.message || 'Could not load the speech model'));
      w.onmessage = ({ data }) => {
        if (data.type === 'download') {
          const p = data.data;
          if (p.status === 'progress' && p.total) {
            files.set(p.file, { loaded: p.loaded, total: p.total });
            let loaded = 0, total = 0;
            for (const f of files.values()) { loaded += f.loaded; total += f.total; }
            onStatus && onStatus(`Downloading speech model… ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`, loaded / total);
          } else if (p.status === 'ready') {
            onStatus && onStatus('Loading model…');
          }
        } else if (data.type === 'status') {
          onStatus && onStatus(data.text);
        } else if (data.type === 'done') {
          resolve(data.result);
        } else if (data.type === 'error') {
          reject(new Error(data.message));
        }
      };
      w.postMessage({ audio, model, language }, [audio.buffer]);
    });
  }

  function fmtTime(t, srt) {
    t = Math.max(0, t || 0);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000);
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    return srt ? `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}` : (h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`);
  }

  function toSrt(chunks, duration) {
    return chunks.map((c, i) => {
      const [a, b] = c.timestamp;
      return `${i + 1}\n${fmtTime(a, true)} --> ${fmtTime(b ?? duration, true)}\n${c.text.trim()}\n`;
    }).join('\n');
  }

  root.AudioTranscribe = { transcribe, fmtTime, toSrt };
})(typeof self !== 'undefined' ? self : this);
