/*
 * CheckAudio analysis engine.
 *
 * Pure functions over Float32Array channel data (values in [-1, 1]).
 * Works in the browser (exposed as window.AudioHealth) and in Node
 * (module.exports) so it can be unit tested without a browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AudioHealth = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ampDb = (a) => 20 * Math.log10(Math.max(a, 1e-10));
  const powDb = (p) => 10 * Math.log10(Math.max(p, 1e-20));
  const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

  function percentile(values, p) {
    if (!values.length) return null;
    const s = Float64Array.from(values).sort();
    const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[i];
  }

  // ---------------------------------------------------------------- FFT ---

  const fftTables = new Map();
  function getTables(n) {
    let t = fftTables.get(n);
    if (!t) {
      const cos = new Float64Array(n / 2);
      const sin = new Float64Array(n / 2);
      for (let k = 0; k < n / 2; k++) {
        cos[k] = Math.cos((2 * Math.PI * k) / n);
        sin[k] = Math.sin((2 * Math.PI * k) / n);
      }
      t = { cos, sin };
      fftTables.set(n, t);
    }
    return t;
  }

  /** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const { cos, sin } = getTables(n);
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = -sin[k * step];
          const a = i + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
  }

  function mixToMono(channels) {
    if (channels.length === 1) return channels[0];
    const n = channels[0].length;
    const out = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
    for (let i = 0; i < n; i++) out[i] /= channels.length;
    return out;
  }

  /**
   * Welch-averaged power spectrum. Power is scaled so a full-scale sine
   * reads 0 dB at its bin. At most `maxFrames` evenly spread frames are used.
   */
  function averageSpectrum(signal, sampleRate, size = 4096, maxFrames = 1500, { median = false } = {}) {
    const w = hann(size);
    const hop = size / 2;
    const scale = (4 / size) ** 2; // 2 / sum(hann) squared
    const bins = size / 2 + 1;
    const power = new Float64Array(bins);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    const available = Math.max(1, Math.floor((signal.length - size) / hop) + 1);
    const used = Math.min(available, maxFrames);
    const stride = used > 1 ? (available - 1) / (used - 1) : 0;
    // Median mode keeps every frame so transients (drum hits) can't mask steady tones.
    const frames = median ? new Float32Array(used * bins) : null;
    for (let f = 0; f < used; f++) {
      const start = Math.round(f * stride) * hop;
      for (let i = 0; i < size; i++) {
        const j = start + i;
        re[i] = j < signal.length ? signal[j] * w[i] : 0;
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) {
        const p = (re[k] * re[k] + im[k] * im[k]) * scale;
        if (frames) frames[f * bins + k] = p;
        else power[k] += p;
      }
    }
    const dB = new Float32Array(bins);
    const column = new Float32Array(used);
    for (let k = 0; k < bins; k++) {
      if (frames) {
        for (let f = 0; f < used; f++) column[f] = frames[f * bins + k];
        column.sort();
        power[k] = column[used >> 1];
      } else power[k] /= used;
      dB[k] = powDb(power[k]);
    }
    return { size, sampleRate, binHz: sampleRate / size, power, dB };
  }

  /** Spectrogram as `columns` x `bins` dB values (column-major). */
  function spectrogram(signal, sampleRate, { size = 2048, columns = 600 } = {}) {
    const w = hann(size);
    const scale = (4 / size) ** 2;
    const bins = size / 2 + 1;
    const cols = Math.max(1, Math.min(columns, Math.floor(signal.length / (size / 4)) || 1));
    const data = new Float32Array(cols * bins);
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    const span = Math.max(0, signal.length - size);
    for (let c = 0; c < cols; c++) {
      const start = cols > 1 ? Math.round((c / (cols - 1)) * span) : 0;
      for (let i = 0; i < size; i++) {
        const j = start + i;
        re[i] = j < signal.length ? signal[j] * w[i] : 0;
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) data[c * bins + k] = powDb((re[k] * re[k] + im[k] * im[k]) * scale);
    }
    return { columns: cols, bins, binHz: sampleRate / size, data };
  }

  // ----------------------------------------------------------- Loudness ---

  /** ITU-R BS.1770 K-weighting filters (two biquads) for any sample rate. */
  function kWeighting(fs) {
    // Same bilinear design as libebur128; matches the 48 kHz coefficients in the spec.
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / fs);
    const Vh = 10 ** (G / 20);
    const Vb = Vh ** 0.4996667741545416;
    let a0 = 1 + K / Q + K * K;
    const shelf = {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0,
    };
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan((Math.PI * f0) / fs);
    a0 = 1 + K / Q + K * K;
    const highpass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
    return [shelf, highpass];
  }

  function channelWeights(n) {
    // 5.1 layout (L R C LFE Ls Rs): LFE excluded, surrounds +1.5 dB.
    if (n === 6) return [1, 1, 1, 0, 1.41, 1.41];
    return new Array(n).fill(1);
  }

  /** Integrated loudness (LUFS), loudness range (LU) and max momentary / short-term. */
  function loudness(channels, sampleRate) {
    const blockLen = Math.round(sampleRate * 0.1);
    const nBlocks = Math.floor(channels[0].length / blockLen);
    const ms = new Float64Array(nBlocks); // weighted mean square per 100 ms
    const weights = channelWeights(channels.length);
    const [s, h] = kWeighting(sampleRate);
    channels.forEach((x, c) => {
      const g = weights[c];
      if (!g) return;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
      for (let b = 0; b < nBlocks; b++) {
        let acc = 0;
        const end = (b + 1) * blockLen;
        for (let i = b * blockLen; i < end; i++) {
          const x0 = x[i];
          const y0 = s.b0 * x0 + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
          x2 = x1; x1 = x0;
          const z0 = h.b0 * y0 + h.b1 * y1 + h.b2 * y2 - h.a1 * z1 - h.a2 * z2;
          y2 = y1; y1 = y0;
          z2 = z1; z1 = z0;
          acc += z0 * z0;
        }
        ms[b] += (g * acc) / blockLen;
      }
    });

    const lufs = (z) => -0.691 + 10 * Math.log10(Math.max(z, 1e-20));
    const windowed = (n) => {
      const out = [];
      let sum = 0;
      for (let i = 0; i < nBlocks; i++) {
        sum += ms[i];
        if (i >= n) sum -= ms[i - n];
        if (i >= n - 1) out.push(sum / n);
      }
      return out;
    };

    const momentary = windowed(4); // 400 ms, 75 % overlap
    const shortTerm = windowed(30); // 3 s, 100 ms hop

    let integrated = null;
    const absGated = momentary.filter((z) => lufs(z) > -70);
    if (absGated.length) {
      const rel = lufs(absGated.reduce((a, b) => a + b, 0) / absGated.length) - 10;
      const gated = absGated.filter((z) => lufs(z) > rel);
      if (gated.length) integrated = lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
    }

    let range = null;
    const stAbs = shortTerm.filter((z) => lufs(z) > -70);
    if (stAbs.length) {
      const rel = lufs(stAbs.reduce((a, b) => a + b, 0) / stAbs.length) - 20;
      const st = stAbs.filter((z) => lufs(z) > rel).map(lufs);
      if (st.length) range = percentile(st, 95) - percentile(st, 10);
    }

    const max = (arr) => (arr.length ? lufs(Math.max(...arr)) : null);
    return {
      integrated,
      range,
      maxMomentary: max(momentary),
      maxShortTerm: max(shortTerm),
      shortTermCurve: shortTerm.map(lufs),
    };
  }

  // ------------------------------------------------------ Time domain ---

  function channelStats(x) {
    let peak = 0, sum = 0, sumSq = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v;
      sumSq += v * v;
    }
    // Clipping: runs of >= 3 samples pinned at the channel's peak value.
    // Relative to the peak so clipping that was later turned down is still found.
    let clippedSamples = 0, clipEvents = 0;
    if (peak >= 0.5) {
      const thr = peak * 0.9999;
      let run = 0;
      for (let i = 0; i <= x.length; i++) {
        const a = i < x.length ? Math.abs(x[i]) : 0;
        if (a >= thr) run++;
        else {
          if (run >= 3) { clipEvents++; clippedSamples += run; }
          run = 0;
        }
      }
    }
    const n = Math.max(1, x.length);
    return { peak, rms: Math.sqrt(sumSq / n), dcOffset: sum / n, clippedSamples, clipEvents };
  }

  /** RMS level (dBFS) of 100 ms blocks across all channels. */
  function blockLevels(channels, sampleRate) {
    const blockLen = Math.max(1, Math.round(sampleRate * 0.1));
    const nBlocks = Math.ceil(channels[0].length / blockLen);
    const levels = new Float32Array(nBlocks);
    for (let b = 0; b < nBlocks; b++) {
      const start = b * blockLen;
      const end = Math.min(channels[0].length, start + blockLen);
      let acc = 0;
      for (const ch of channels) for (let i = start; i < end; i++) acc += ch[i] * ch[i];
      levels[b] = powDb(acc / ((end - start) * channels.length));
    }
    return { blockSeconds: blockLen / sampleRate, levels };
  }

  /** Gaps of exact digital silence (all channels 0) inside the audio. */
  function findDropouts(channels, sampleRate) {
    const n = channels[0].length;
    const minLen = Math.round(sampleRate * 0.01);
    const maxLen = Math.round(sampleRate * 2);
    const out = [];
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) {
      if (channels.some((c) => c[i] !== 0)) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) return out;
    let runStart = -1;
    for (let i = first; i <= last + 1; i++) {
      let zero = i <= last;
      if (zero) for (const c of channels) if (c[i] !== 0) { zero = false; break; }
      if (zero) { if (runStart < 0) runStart = i; }
      else if (runStart >= 0) {
        const len = i - runStart;
        if (len >= minLen && len <= maxLen) out.push({ time: runStart / sampleRate, duration: len / sampleRate });
        runStart = -1;
      }
    }
    return out;
  }

  /** Smallest bit depth (8/16/24) that represents every sampled value; 32 if none. */
  function effectiveBitDepth(channels) {
    const limit = 2_000_000;
    // Decoders scale integers by 2^(b-1) or 2^(b-1)-1, so accept either.
    const fits = (bits, scale, tol) => {
      let seen = 0;
      for (const ch of channels) {
        const step = Math.max(1, Math.floor(ch.length / limit));
        for (let i = 0; i < ch.length; i += step) {
          const v = ch[i] * scale;
          if (Math.abs(v - Math.round(v)) > tol) return false;
          if (ch[i] !== 0) seen++;
        }
      }
      return seen > 0;
    };
    for (const bits of [8, 16]) {
      const s = 2 ** (bits - 1);
      if (fits(bits, s, 1e-3) || fits(bits, s - 1, 1e-2)) return bits;
    }
    return fits(24, 2 ** 23, 1e-3) ? 24 : 32;
  }

  function stereo(left, right) {
    let lr = 0, ll = 0, rr = 0, diff = 0;
    for (let i = 0; i < left.length; i++) {
      const l = left[i], r = right[i];
      lr += l * r; ll += l * l; rr += r * r;
      diff += Math.abs(l - r);
    }
    const correlation = ll > 0 && rr > 0 ? lr / Math.sqrt(ll * rr) : null;
    return {
      correlation,
      identical: diff === 0,
      balanceDb: ll > 0 && rr > 0 ? 10 * Math.log10(ll / rr) : null,
      leftSilent: ll === 0,
      rightSilent: rr === 0,
    };
  }

  // ------------------------------------------------- Frequency domain ---

  const BANDS = [
    { name: 'Sub-bass', lo: 20, hi: 60 },
    { name: 'Bass', lo: 60, hi: 250 },
    { name: 'Low mids', lo: 250, hi: 500 },
    { name: 'Mids', lo: 500, hi: 2000 },
    { name: 'Upper mids', lo: 2000, hi: 4000 },
    { name: 'Presence', lo: 4000, hi: 6000 },
    { name: 'Brilliance', lo: 6000, hi: 20000 },
  ];

  function bandEnergy(spec) {
    const nyq = spec.sampleRate / 2;
    let total = 0, subsonic = 0;
    const sums = BANDS.map(() => 0);
    for (let k = 1; k < spec.power.length; k++) {
      const f = k * spec.binHz;
      const p = spec.power[k];
      total += p;
      if (f < 20) subsonic += p;
      BANDS.forEach((b, i) => { if (f >= b.lo && f < Math.min(b.hi, nyq + 1)) sums[i] += p; });
    }
    return {
      bands: BANDS.map((b, i) => ({ ...b, percent: total > 0 ? (100 * sums[i]) / total : 0, dB: powDb(sums[i]) })),
      subsonicPercent: total > 0 ? (100 * subsonic) / total : 0,
    };
  }

  function smoothDb(spec, radius) {
    const n = spec.power.length;
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let acc = 0, cnt = 0;
      for (let j = Math.max(0, k - radius); j <= Math.min(n - 1, k + radius); j++) { acc += spec.power[j]; cnt++; }
      out[k] = powDb(acc / cnt);
    }
    return out;
  }

  /** Effective bandwidth: the highest frequency that rises clearly above the spectral floor. */
  function bandwidth(spec) {
    const sm = smoothDb(spec, 3);
    const nyq = spec.sampleRate / 2;
    const binOf = (f) => Math.min(sm.length - 1, Math.max(0, Math.round(f / spec.binHz)));
    let ref = -Infinity;
    for (let k = binOf(100); k <= binOf(Math.min(10000, nyq)); k++) ref = Math.max(ref, sm[k]);
    const thr = ref - 100;
    let cut = 0;
    for (let k = sm.length - 1; k > 0; k--) if (sm[k] > thr) { cut = k; break; }
    let cutoff = cut * spec.binHz;

    // Lossy encoders leave a cliff: find the steepest drop between neighbouring 500 Hz windows.
    const prefix = new Float64Array(sm.length + 1);
    for (let k = 0; k < sm.length; k++) prefix[k + 1] = prefix[k] + sm[k];
    const mean = (a, b) => (b > a ? (prefix[b] - prefix[a]) / (b - a) : 0);
    const gap = Math.max(1, Math.round(100 / spec.binHz)), win = Math.max(2, Math.round(500 / spec.binHz));
    // Search from 8 kHz (encoder lowpasses sit above that), and require that nothing
    // comes back above the cliff, so a tone or note ending isn't mistaken for one.
    const maxAbove = new Float32Array(sm.length + 1).fill(-Infinity);
    for (let k = sm.length - 1; k >= 0; k--) maxAbove[k] = Math.max(maxAbove[k + 1], sm[k]);
    let drop = 0, dropAt = 0;
    for (let k = binOf(8000); k + gap + win < sm.length; k++) {
      const before = mean(k - gap - win, k - gap);
      const d = before - mean(k + gap, k + gap + win);
      if (d > drop && maxAbove[k + gap] < before - 20) { drop = d; dropAt = k; }
    }
    if (drop > 30) cutoff = dropAt * spec.binHz;
    return { cutoff, sharpDropDb: drop };
  }

  /** Mains hum: narrow peaks at 50/60 Hz and their harmonics. */
  function detectHum(spec) {
    const results = [50, 60].map((base) => {
      const harmonics = [];
      for (let h = 1; h <= 5; h++) {
        const f = base * h;
        const k = Math.round(f / spec.binHz);
        if (k + 2 >= spec.dB.length) break;
        let peak = -Infinity;
        for (let j = k - 2; j <= k + 2; j++) peak = Math.max(peak, spec.dB[j]);
        const neighbours = [];
        for (let j = 1; j < spec.dB.length; j++) {
          const d = Math.abs(j * spec.binHz - f);
          if (d >= 8 && d <= 30) neighbours.push(spec.dB[j]);
        }
        const prominence = peak - percentile(neighbours, 50);
        harmonics.push({ frequency: f, level: peak, prominence });
      }
      const strong = harmonics.filter((x) => x.prominence > 10 && x.level > -80);
      return { base, harmonics, strong: strong.length, fundamentalProminence: Math.max(...harmonics.slice(0, 2).map((x) => x.prominence)) };
    });
    results.sort((a, b) => b.strong - a.strong || b.fundamentalProminence - a.fundamentalProminence);
    const best = results[0];
    return {
      detected: best.strong >= 2 && best.fundamentalProminence > 12,
      frequency: best.base,
      harmonics: best.harmonics,
    };
  }

  function toneLabel(f) {
    for (const base of [50, 60]) {
      const h = f / base;
      if (Math.abs(h - Math.round(h)) * base < 1.5 && Math.round(h) <= 10) return `Mains hum (${base} Hz × ${Math.round(h)})`;
    }
    if (f < 30) return 'Subsonic tone';
    if (f >= 15000 && f <= 16100) return 'CRT/TV line whine';
    if (f >= 17000) return 'High-frequency tone (whine, watermark or carrier)';
    if (Math.abs(f - 1000) < 2) return 'Test tone (1 kHz)';
    if (Math.abs(f - 440) < 1.5) return 'Tuning tone (440 Hz)';
    return 'Steady tone';
  }

  /**
   * Narrowband tones present for most of the file. Musical notes come and go;
   * a peak that never moves is almost always hum, whine or an added tone.
   */
  function steadyTones(signal, sampleRate, { minPresence = 0.6 } = {}) {
    const sg = spectrogram(signal, sampleRate, { size: 8192, columns: 240 });
    const { bins, columns, binHz, data } = sg;
    const hits = new Uint16Array(bins);
    const levels = new Float64Array(bins);
    const freqSum = new Float64Array(bins);
    const prefix = new Float64Array(bins + 1);
    let active = 0;
    for (let c = 0; c < columns; c++) {
      const o = c * bins;
      let maxDb = -Infinity;
      for (let k = 0; k < bins; k++) { prefix[k + 1] = prefix[k] + data[o + k]; if (data[o + k] > maxDb) maxDb = data[o + k]; }
      if (maxDb < -70) continue; // silent column
      active++;
      for (let k = 4; k < bins - 4; k++) {
        const v = data[o + k];
        if (v < -100 || v < data[o + k - 1] || v < data[o + k + 1]) continue;
        // Mean of the surroundings, skipping the peak's own main lobe.
        const w = 40, g = 4;
        const l0 = Math.max(0, k - w), l1 = Math.max(0, k - g), r0 = Math.min(bins, k + g + 1), r1 = Math.min(bins, k + w + 1);
        const n = l1 - l0 + (r1 - r0);
        if (n <= 0) continue;
        const around = (prefix[l1] - prefix[l0] + prefix[r1] - prefix[r0]) / n;
        if (v - around > 15) {
          hits[k]++;
          levels[k] += v;
          // Parabolic interpolation in this frame for sub-bin frequency accuracy.
          const y0 = data[o + k - 1], y2 = data[o + k + 1], den = y0 - 2 * v + y2;
          freqSum[k] += (k + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0)) * binHz;
        }
      }
    }
    if (!active) return [];
    const tones = [];
    for (let k = 1; k < bins - 1; k++) {
      // Let a tone wander by one bin between frames.
      const count = Math.max(hits[k - 1], hits[k], hits[k + 1]) === hits[k] ? hits[k - 1] + hits[k] + hits[k + 1] : 0;
      if (count / active < minPresence) continue;
      const frequency = (freqSum[k - 1] + freqSum[k] + freqSum[k + 1]) / count;
      if (frequency < 15) continue;
      const level = (levels[k - 1] + levels[k] + levels[k + 1]) / count;
      tones.push({ frequency, level, presence: Math.min(1, count / active), label: toneLabel(frequency) });
      k += 2;
    }
    return tones.sort((a, b) => b.level - a.level).slice(0, 20);
  }

  // -------------------------------------------------- Format sniffing ---

  /** Read container, sample rate and bit depth from a file's header bytes. */
  function sniffFormat(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
    try {
      if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') {
        for (let o = 12; o + 8 <= u8.length;) {
          const id = str(o, 4), size = dv.getUint32(o + 4, true);
          if (id === 'fmt ') {
            const code = dv.getUint16(o + 8, true);
            return {
              container: 'WAV',
              codec: code === 3 ? 'PCM float' : 'PCM',
              channels: dv.getUint16(o + 10, true),
              sampleRate: dv.getUint32(o + 12, true),
              bitDepth: dv.getUint16(o + 22, true),
              lossless: true,
            };
          }
          o += 8 + size + (size & 1);
        }
      }
      if (str(0, 4) === 'fLaC') {
        const d = 8;
        return {
          container: 'FLAC', codec: 'FLAC', lossless: true,
          sampleRate: (u8[d + 10] << 12) | (u8[d + 11] << 4) | (u8[d + 12] >> 4),
          channels: ((u8[d + 12] >> 1) & 7) + 1,
          bitDepth: (((u8[d + 12] & 1) << 4) | (u8[d + 13] >> 4)) + 1,
        };
      }
      if (str(0, 4) === 'OggS') {
        const p = 27 + u8[26];
        if (str(p + 1, 6) === 'vorbis') {
          return { container: 'Ogg', codec: 'Vorbis', lossless: false, channels: u8[p + 11], sampleRate: dv.getUint32(p + 12, true) };
        }
        if (str(p, 8) === 'OpusHead') {
          return { container: 'Ogg', codec: 'Opus', lossless: false, channels: u8[p + 9], sampleRate: 48000 };
        }
        if (str(p + 1, 4) === 'FLAC') return { container: 'Ogg', codec: 'FLAC', lossless: true };
      }
      if (str(0, 4) === 'FORM' && (str(8, 4) === 'AIFF' || str(8, 4) === 'AIFC')) {
        return { container: 'AIFF', codec: 'PCM', lossless: true };
      }
      if (str(4, 4) === 'ftyp') return { container: 'MP4', codec: 'AAC/ALAC' };
      // MP3: skip an ID3v2 tag, then look for a frame sync.
      let o = 0;
      if (str(0, 3) === 'ID3') {
        o = 10 + ((u8[6] & 0x7f) << 21 | (u8[7] & 0x7f) << 14 | (u8[8] & 0x7f) << 7 | (u8[9] & 0x7f));
        if (u8[5] & 0x10) o += 10;
      }
      for (const end = Math.min(u8.length - 4, o + 65536); o < end; o++) {
        if (u8[o] !== 0xff || (u8[o + 1] & 0xe0) !== 0xe0) continue;
        const version = (u8[o + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
        const layer = (u8[o + 1] >> 1) & 3; // 1 = Layer III
        const brIdx = u8[o + 2] >> 4, srIdx = (u8[o + 2] >> 2) & 3;
        if (version === 1 || layer !== 1 || srIdx === 3 || brIdx === 0 || brIdx === 15) continue;
        const sampleRate = [44100, 48000, 32000][srIdx] / (version === 3 ? 1 : version === 2 ? 2 : 4);
        const br = version === 3
          ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][brIdx]
          : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][brIdx];
        return { container: 'MP3', codec: 'MPEG Layer III', lossless: false, sampleRate, bitrateKbps: br, channels: (u8[o + 3] >> 6) === 3 ? 1 : 2 };
      }
    } catch (e) {
      // Truncated or malformed header: fall through.
    }
    return { container: 'Unknown' };
  }

  // ------------------------------------------------------------ Report ---

  const PENALTY = { error: 25, warning: 10, info: 0 };

  /**
   * Full health check.
   * @param {Float32Array[]} channels
   * @param {number} sampleRate
   * @param {object} [format] result of sniffFormat()
   */
  function analyze(channels, sampleRate, format = {}) {
    if (!channels.length || !channels[0].length) throw new Error('The file contains no audio samples.');
    const duration = channels[0].length / sampleRate;
    const nyq = sampleRate / 2;
    const issues = [];
    const add = (severity, title, detail) => issues.push({ severity, title, detail });

    // Levels
    const stats = channels.map(channelStats);
    const peak = Math.max(...stats.map((s) => s.peak));
    const rms = Math.sqrt(stats.reduce((a, s) => a + s.rms * s.rms, 0) / stats.length);
    const clippedSamples = stats.reduce((a, s) => a + s.clippedSamples, 0);
    const clipEvents = stats.reduce((a, s) => a + s.clipEvents, 0);
    const peakDb = ampDb(peak);

    if (peak === 0) add('error', 'File is completely silent', 'Every sample is zero.');
    if (clipEvents > 0) {
      const sev = clipEvents > 20 ? 'error' : 'warning';
      add(sev, `Clipping detected (${clipEvents} events)`,
        `${clippedSamples} samples are flattened at the peak level. Audio was driven past its limit and the waveform tops were cut off, causing distortion.`);
    }
    if (peak > 0 && peakDb > -0.1 && clipEvents === 0) {
      add('warning', 'No headroom', `Peaks reach ${round(peakDb, 2)} dBFS. Lossy encoding can push these over 0 dBFS; aim for about -1 dBFS.`);
    }
    if (peak > 0 && peakDb < -20) {
      add('warning', 'Very low level', `Peaks only reach ${round(peakDb)} dBFS. The recording is quiet, so noise will be loud once it is turned up.`);
    }
    const maxDc = Math.max(...stats.map((s) => Math.abs(s.dcOffset)));
    if (maxDc > 0.005) {
      add('warning', 'DC offset', `The waveform is shifted off centre by ${round(maxDc * 100, 2)} % of full scale. This wastes headroom and can cause clicks at edits. A high-pass filter around 20 Hz removes it.`);
    }

    // Loudness
    const loud = loudness(channels, sampleRate);
    if (loud.integrated !== null) {
      const plr = peakDb - loud.integrated;
      if (loud.integrated > -7) add('warning', 'Extremely loud master', `Integrated loudness is ${round(loud.integrated)} LUFS. Streaming services normalise to about -14 LUFS, so this will be turned down and only the squashed dynamics remain.`);
      if (plr < 7 && peak > 0) add('warning', 'Heavily compressed', `Peak-to-loudness ratio is only ${round(plr)} dB, which suggests strong limiting or compression.`);
    }

    // Silence and dropouts
    const blocks = blockLevels(channels, sampleRate);
    const lv = Array.from(blocks.levels);
    const silent = lv.filter((l) => l < -60).length;
    let lead = 0; while (lead < lv.length && lv[lead] < -60) lead++;
    let trail = 0; while (trail < lv.length - lead && lv[lv.length - 1 - trail] < -60) trail++;
    const audible = lv.filter((l) => l > -150);
    const noiseFloor = percentile(audible, 10);
    const dropouts = findDropouts(channels, sampleRate);
    if (dropouts.length) {
      add('error', `Dropouts (${dropouts.length})`,
        `Short gaps of pure digital silence inside the audio, e.g. at ${dropouts.slice(0, 3).map((d) => d.time.toFixed(2) + ' s').join(', ')}. Usually a buffer underrun or a bad edit.`);
    }
    if (peak > 0 && lead * blocks.blockSeconds > 2) add('info', 'Leading silence', `${round(lead * blocks.blockSeconds)} s of silence at the start.`);
    if (peak > 0 && trail * blocks.blockSeconds > 2) add('info', 'Trailing silence', `${round(trail * blocks.blockSeconds)} s of silence at the end.`);
    // Only judge noise when there are pauses (quiet blocks well below the typical level);
    // in continuous music the quietest blocks are just quiet music.
    const typical = percentile(audible, 50);
    if (noiseFloor !== null && typical !== null && typical - noiseFloor > 12 && noiseFloor > -50) {
      add('warning', 'High noise floor', `Pauses only drop to about ${round(noiseFloor)} dBFS instead of near-silence. There is likely audible hiss, hum or background noise.`);
    }

    // Spectrum
    const mono = mixToMono(channels);
    const spectrum = averageSpectrum(mono, sampleRate, 4096);
    const humSpectrum = averageSpectrum(mono, sampleRate, 16384, 300, { median: true });
    const energy = bandEnergy(spectrum);
    const bw = bandwidth(spectrum);
    const tones = steadyTones(mono, sampleRate);
    const hum = detectHum(humSpectrum);
    // A hum fundamental (or two harmonics) that persists through the file also counts.
    for (const base of [50, 60]) {
      const humTones = tones.filter((t) => t.label.startsWith(`Mains hum (${base} Hz`));
      if (!hum.detected && (humTones.length >= 2 || humTones.some((t) => Math.abs(t.frequency - base) < 1.5))) {
        hum.detected = true;
        hum.frequency = base;
      }
    }
    const expected = Math.min(19000, nyq * 0.85);
    if (peak > 0 && bw.cutoff < expected) {
      const sharp = bw.sharpDropDb > 30;
      add('warning', `Limited bandwidth (content stops near ${round(bw.cutoff / 1000)} kHz)`,
        sharp
          ? 'There is a sharp cliff in the spectrum, typical of a lossy file (MP3/AAC) or a low sample rate copy. If this is meant to be lossless, it was probably transcoded from a lossy source.'
          : 'High frequencies roll off early. This can be the content itself, but may also mean a dull mic, heavy filtering or a lossy source.');
    }
    if (sampleRate >= 88200 && bw.cutoff < 24000 && peak > 0) {
      add('warning', 'Likely upsampled', `The file is ${sampleRate / 1000} kHz but has no content above ${round(bw.cutoff / 1000)} kHz, so it was probably converted up from 44.1/48 kHz.`);
    }
    if (hum.detected) {
      add('warning', `Mains hum (${hum.frequency} Hz)`, `Narrow peaks at ${hum.frequency} Hz and its harmonics point to electrical hum from a ground loop or unshielded cable.`);
    }
    for (const t of tones.filter((x) => !x.label.startsWith('Mains hum') && (x.frequency >= 15000 || x.label !== 'Steady tone'))) {
      add('warning', `Steady tone at ${t.frequency >= 1000 ? round(t.frequency / 1000, 2) + ' kHz' : round(t.frequency) + ' Hz'}`,
        `${t.label}. A fixed-frequency tone runs through ${Math.round(t.presence * 100)} % of the file at ${round(t.level)} dBFS. It was probably added by equipment or processing, not by the performance.`);
    }
    if (energy.subsonicPercent > 10) {
      add('warning', 'Subsonic rumble', `${round(energy.subsonicPercent)} % of the energy is below 20 Hz, where it can't be heard but still uses headroom. Use a high-pass filter.`);
    }

    // Stereo
    let st = null;
    if (channels.length >= 2) {
      st = stereo(channels[0], channels[1]);
      if (st.leftSilent !== st.rightSilent) add('error', 'One channel is silent', `The ${st.leftSilent ? 'left' : 'right'} channel carries no signal.`);
      else if (st.identical) add('info', 'Mono content in a stereo file', 'Both channels are identical. The file could be stored as mono at half the size.');
      else if (st.correlation !== null && st.correlation < 0) add('error', 'Phase problem', `Channel correlation is ${round(st.correlation, 2)}. Left and right largely cancel when summed to mono (phone speakers, radio, club systems). One channel may be polarity-inverted.`);
      else if (st.correlation !== null && st.correlation < 0.2) add('info', 'Very wide stereo', `Correlation is ${round(st.correlation, 2)}. Check that the mix still holds up in mono.`);
      if (st.balanceDb !== null && Math.abs(st.balanceDb) > 3) add('warning', 'Channel imbalance', `The ${st.balanceDb > 0 ? 'left' : 'right'} channel is ${round(Math.abs(st.balanceDb))} dB louder.`);
    }

    // Format
    const bitDepth = effectiveBitDepth(channels);
    if (format.bitDepth && format.bitDepth > 16 && bitDepth <= 16 && format.codec !== 'PCM float' && peak > 0) {
      add('info', 'Padded bit depth', `The file is stored as ${format.bitDepth}-bit but only uses ${bitDepth} bits of resolution, so it was converted up from a lower bit depth.`);
    }
    if (format.lossless === false) add('info', 'Lossy format', `${format.codec}${format.bitrateKbps ? ' at ' + format.bitrateKbps + ' kbps' : ''}. Some detail was discarded during encoding.`);
    if (duration < 0.4) add('info', 'Very short file', 'Loudness measurements need at least 400 ms of audio.');

    const order = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => order[a.severity] - order[b.severity]);
    const score = Math.max(0, 100 - issues.reduce((a, i) => a + PENALTY[i.severity], 0));
    const verdict = score >= 90 ? 'Healthy' : score >= 70 ? 'Minor issues' : score >= 40 ? 'Needs attention' : 'Serious problems';

    return {
      score,
      verdict,
      issues,
      info: { duration, sampleRate, channels: channels.length, effectiveBitDepth: bitDepth, format },
      levels: {
        peakDb,
        rmsDb: ampDb(rms),
        crestDb: peakDb - ampDb(rms),
        perChannel: stats.map((s) => ({ peakDb: ampDb(s.peak), rmsDb: ampDb(s.rms), dcOffset: s.dcOffset })),
        clippedSamples,
        clipEvents,
        noiseFloorDb: noiseFloor,
      },
      loudness: loud,
      silence: { percent: lv.length ? (100 * silent) / lv.length : 0, leadingSeconds: lead * blocks.blockSeconds, trailingSeconds: trail * blocks.blockSeconds, dropouts },
      frequency: { bandwidthHz: bw.cutoff, sharpCutoff: bw.sharpDropDb > 30, bands: energy.bands, subsonicPercent: energy.subsonicPercent, hum, steadyTones: tones },
      stereo: st,
      spectrum,
    };
  }

  return {
    analyze, sniffFormat, fft, averageSpectrum, spectrogram, loudness, kWeighting,
    channelStats, findDropouts, effectiveBitDepth, bandwidth, detectHum, steadyTones, mixToMono, BANDS,
  };
});
