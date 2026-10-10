/*
 * CheckAudio layer dissection.
 *
 * Splits audio into layers without machine learning:
 *  - Harmonic / Percussive / Residual via median-filtering HPSS
 *    (Fitzgerald 2010, with Driedger's separation margin)
 *  - Centre / Sides via mid-side decoding (vocals usually sit in the centre)
 * and lists the steady tones running through the file (AudioHealth.steadyTones).
 *
 * Depends on analysis.js (AudioHealth).
 */
(function (root, factory) {
  const AH = typeof module === 'object' && module.exports ? require('./analysis.js') : root.AudioHealth;
  const api = factory(AH);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AudioLayers = api;
})(typeof self !== 'undefined' ? self : this, function (AH) {
  'use strict';

  const powDb = (p) => 10 * Math.log10(Math.max(p, 1e-20));
  const nextTick = () => new Promise((r) => setTimeout(r, 0));

  /** Median of `n` values held in `buf` (insertion sort; n is small). */
  function median(buf, n) {
    for (let i = 1; i < n; i++) {
      const v = buf[i];
      let j = i - 1;
      while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
      buf[j + 1] = v;
    }
    return buf[n >> 1];
  }

  /**
   * Harmonic-percussive-residual separation of a mono signal.
   * Processed in chunks of STFT frames so memory stays bounded on long files.
   * @returns {Promise<{harmonic: Float32Array, percussive: Float32Array, residual: Float32Array}>}
   */
  async function hpss(signal, sampleRate, { onProgress, margin = 2 } = {}) {
    const N = sampleRate > 60000 ? 4096 : 2048;
    const hop = N / 2;
    const bins = N / 2 + 1;
    const kT = 13; // median length across time  (frames)
    const kF = 13; // median length across frequency (bins)
    const halfT = kT >> 1, halfF = kF >> 1;

    // sqrt-Hann analysis + synthesis windows sum to 1 at 50 % overlap.
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

    const len = signal.length;
    const frames = Math.ceil((len + N / 2) / hop) + 1;
    const frameStart = (f) => f * hop - N / 2;
    const out = { harmonic: new Float32Array(len), percussive: new Float32Array(len), residual: new Float32Array(len) };

    const chunk = 256;
    const re = new Float64Array(N), im = new Float64Array(N);
    const buf = new Float64Array(Math.max(kT, kF));
    const xr = new Float64Array(N), xi = new Float64Array(N);

    for (let c0 = 0; c0 < frames; c0 += chunk) {
      const c1 = Math.min(frames, c0 + chunk);
      const a = Math.max(0, c0 - halfT), b = Math.min(frames, c1 + halfT);
      const count = b - a;
      const R = new Float32Array(count * bins), I = new Float32Array(count * bins), M = new Float32Array(count * bins);

      for (let f = a; f < b; f++) {
        const s = frameStart(f);
        for (let i = 0; i < N; i++) {
          const j = s + i;
          re[i] = j >= 0 && j < len ? signal[j] * win[i] : 0;
          im[i] = 0;
        }
        AH.fft(re, im);
        const o = (f - a) * bins;
        for (let k = 0; k < bins; k++) {
          R[o + k] = re[k]; I[o + k] = im[k];
          M[o + k] = Math.hypot(re[k], im[k]);
        }
      }

      for (let f = c0; f < c1; f++) {
        const fi = f - a, o = fi * bins;
        for (let k = 0; k < bins; k++) {
          // Harmonic: smooth across time (sustained tones are horizontal lines).
          let n = 0;
          for (let t = Math.max(0, fi - halfT); t <= Math.min(count - 1, fi + halfT); t++) buf[n++] = M[t * bins + k];
          const h = median(buf, n);
          // Percussive: smooth across frequency (hits are vertical lines).
          n = 0;
          for (let q = Math.max(0, k - halfF); q <= Math.min(bins - 1, k + halfF); q++) buf[n++] = M[o + q];
          const p = median(buf, n);
          const mh = h > margin * p ? 1 : 0;
          const mp = p > margin * h ? 1 : 0;
          re[k] = R[o + k]; im[k] = I[o + k];
          // The spectrum is copied to re/im, so R/I can hold this frame's masks.
          R[o + k] = mh; I[o + k] = mp;
        }
        // Rebuild each layer from the stored spectrum and masks.
        const s = frameStart(f);
        for (const [name, maskOf] of [
          ['harmonic', (k) => R[o + k]],
          ['percussive', (k) => I[o + k]],
          ['residual', (k) => 1 - R[o + k] - I[o + k]],
        ]) {
          for (let k = 0; k < bins; k++) {
            const m = maskOf(k);
            xr[k] = re[k] * m; xi[k] = im[k] * m;
            if (k > 0 && k < N / 2) { xr[N - k] = xr[k]; xi[N - k] = -xi[k]; }
          }
          // Inverse FFT via conjugation.
          for (let i = 0; i < N; i++) xi[i] = -xi[i];
          AH.fft(xr, xi);
          const dst = out[name];
          for (let i = 0; i < N; i++) {
            const j = s + i;
            if (j >= 0 && j < len) dst[j] += (xr[i] / N) * win[i];
          }
        }
      }
      if (onProgress) onProgress(c1 / frames);
      await nextTick();
    }
    return out;
  }

  /** Mid/side decode. Returns null for mono input. */
  function midSide(channels) {
    if (channels.length < 2) return null;
    const [l, r] = channels;
    const mid = new Float32Array(l.length), side = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) { mid[i] = (l[i] + r[i]) / 2; side[i] = (l[i] - r[i]) / 2; }
    return { mid, side };
  }

  /** Spectral description of one layer. */
  function describe(signal, sampleRate, totalPower) {
    const spec = AH.averageSpectrum(signal, sampleRate, 4096, 600);
    let sum = 0, weighted = 0, peakK = 1;
    for (let k = 1; k < spec.power.length; k++) {
      sum += spec.power[k];
      weighted += spec.power[k] * k * spec.binHz;
      if (spec.power[k] > spec.power[peakK]) peakK = k;
    }
    // Frequency span holding the middle 90 % of the layer's energy.
    let acc = 0, lo = 0, hi = 0;
    for (let k = 1; k < spec.power.length; k++) {
      acc += spec.power[k];
      if (!lo && acc >= 0.05 * sum) lo = k * spec.binHz;
      if (!hi && acc >= 0.95 * sum) { hi = k * spec.binHz; break; }
    }
    let ms = 0;
    for (let i = 0; i < signal.length; i++) ms += signal[i] * signal[i];
    ms /= Math.max(1, signal.length);
    const bands = AH.BANDS.map((b) => {
      let p = 0;
      for (let k = 1; k < spec.power.length; k++) {
        const f = k * spec.binHz;
        if (f >= b.lo && f < b.hi) p += spec.power[k];
      }
      return { name: b.name, percent: sum > 0 ? (100 * p) / sum : 0 };
    });
    return {
      levelDb: powDb(ms),
      sharePercent: totalPower > 0 ? (100 * ms) / totalPower : 0,
      centroidHz: sum > 0 ? weighted / sum : 0,
      dominantHz: peakK * spec.binHz,
      rangeHz: [lo, hi],
      bands,
      spectrum: spec,
    };
  }

  /** Full dissection. Returns layer signals plus a description of each. */
  async function dissect(channels, sampleRate, { onProgress } = {}) {
    const mono = AH.mixToMono(channels);
    let total = 0;
    for (let i = 0; i < mono.length; i++) total += mono[i] * mono[i];
    total /= Math.max(1, mono.length);

    const parts = await hpss(mono, sampleRate, { onProgress: (p) => onProgress && onProgress(p * 0.9) });
    const layers = [
      { id: 'harmonic', name: 'Tonal / harmonic', hint: 'Sustained pitched sound: voice, chords, pads, bass notes, hum.', signal: parts.harmonic },
      { id: 'percussive', name: 'Percussive / transients', hint: 'Short, sharp events: drums, plucks, consonants, clicks.', signal: parts.percussive },
      { id: 'residual', name: 'Noise / residual', hint: 'Neither tonal nor percussive: hiss, breath, room tone, reverb tails.', signal: parts.residual },
    ];
    const ms = midSide(channels);
    if (ms) {
      layers.push(
        { id: 'mid', name: 'Centre (mid)', hint: 'Content panned to the centre. Lead vocals, kick, bass and snare usually live here.', signal: ms.mid },
        { id: 'side', name: 'Sides (stereo)', hint: 'Content that differs between left and right: wide instruments, stereo reverb and effects.', signal: ms.side },
      );
    }
    for (const layer of layers) Object.assign(layer, describe(layer.signal, sampleRate, total));
    if (onProgress) onProgress(0.95);
    await nextTick();
    const tones = AH.steadyTones(mono, sampleRate);
    if (onProgress) onProgress(1);
    return { layers, tones };
  }

  return { dissect, hpss, midSide, describe };
});
