const test = require('node:test');
const assert = require('node:assert/strict');
const AH = require('../analysis.js');
const AL = require('../layers.js');

const SR = 48000;
const make = (seconds, fn) => Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) => fn(i / SR, i));
const sine = (f, a = 1) => (t) => a * Math.sin(2 * Math.PI * f * t);
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const titles = (r) => r.issues.map((i) => i.title).join(' | ');

test('FFT finds a sine at the right bin with 0 dB full-scale calibration', () => {
  const spec = AH.averageSpectrum(make(1, sine(1500)), SR, 4096);
  let best = 0;
  for (let k = 1; k < spec.dB.length; k++) if (spec.dB[k] > spec.dB[best]) best = k;
  assert.ok(Math.abs(best * spec.binHz - 1500) < spec.binHz);
  assert.ok(Math.abs(spec.dB[best]) < 1.5, `peak ${spec.dB[best]} dB`);
});

test('K-weighting matches the BS.1770 48 kHz coefficients', () => {
  const [s, h] = AH.kWeighting(48000);
  assert.ok(Math.abs(s.b0 - 1.53512485958697) < 1e-9);
  assert.ok(Math.abs(s.a1 + 1.69065929318241) < 1e-9);
  assert.ok(Math.abs(h.a1 + 1.99004745483398) < 1e-9);
  assert.ok(Math.abs(h.a2 - 0.99007225036621) < 1e-9);
});

test('a full-scale 1 kHz sine in one channel reads -3.01 LUFS', () => {
  const l = AH.loudness([make(5, sine(1000))], SR);
  assert.ok(Math.abs(l.integrated + 3.01) < 0.05, `${l.integrated}`);
});

test('clean music-like signal is healthy', () => {
  // Decaying plucked notes with harmonics plus short noise bursts (hi-hats) for full bandwidth.
  const notes = [220, 247, 262, 294, 330, 349, 392, 440];
  const l = make(8, (t) => {
    const n = Math.floor(t * 4), age = t - n / 4, f = notes[n % notes.length];
    let v = 0;
    for (let h = 1; h <= 8; h++) v += (0.25 / h) * Math.sin(2 * Math.PI * f * h * t) * Math.exp(-age * (3 + h));
    if (age < 0.05) v += 0.08 * rand() * Math.exp(-age * 80);
    return v + 0.00005 * rand();
  });
  const r = AH.analyze([l, l.map((v, i) => 0.9 * v + 0.1 * l[Math.max(0, i - 300)])], SR, {});
  assert.equal(r.issues.filter((i) => i.severity !== 'info').length, 0, titles(r));
});

test('detects clipping', () => {
  const x = make(3, (t) => Math.max(-1, Math.min(1, sine(200, 2)(t))));
  const r = AH.analyze([x], SR, {});
  assert.ok(r.levels.clipEvents > 10);
  assert.match(titles(r), /Clipping/);
});

test('detects a dropout', () => {
  const x = make(4, (t) => (t > 2 && t < 2.03 ? 0 : sine(300, 0.3)(t)));
  const r = AH.analyze([x], SR, {});
  assert.equal(r.silence.dropouts.length, 1);
  assert.ok(Math.abs(r.silence.dropouts[0].time - 2) < 0.01);
});

test('detects mains hum and a high-frequency whine as added tones', () => {
  const x = make(6, (t) => 0.2 * rand() * 0.05 + sine(50, 0.02)(t) + sine(100, 0.01)(t) + sine(18000, 0.003)(t) + sine(700 + 200 * Math.floor(t), 0.2)(t));
  const r = AH.analyze([x], SR, {});
  assert.equal(r.frequency.hum.detected, true);
  assert.equal(r.frequency.hum.frequency, 50);
  assert.ok(r.frequency.steadyTones.some((t) => Math.abs(t.frequency - 18000) < 3), JSON.stringify(r.frequency.steadyTones));
});

test('detects phase-inverted stereo and a silent channel', () => {
  const x = make(3, sine(500, 0.3));
  assert.match(titles(AH.analyze([x, x.map((v) => -v)], SR, {})), /Phase problem/);
  assert.match(titles(AH.analyze([x, new Float32Array(x.length)], SR, {})), /One channel is silent/);
});

test('detects lossy-style bandwidth cutoff', () => {
  // White noise low-passed hard at 16 kHz in the frequency domain.
  const n = 1 << 17, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = rand() * 0.3;
  AH.fft(re, im);
  const cut = Math.round((16000 / SR) * n);
  for (let k = cut; k <= n - cut; k++) { re[k] = 0; im[k] = 0; }
  for (let i = 0; i < n; i++) im[i] = -im[i];
  AH.fft(re, im);
  const x = Float32Array.from(re, (v) => v / n);
  const r = AH.analyze([x], SR, {});
  assert.ok(Math.abs(r.frequency.bandwidthHz - 16000) < 300, `${r.frequency.bandwidthHz}`);
  assert.equal(r.frequency.sharpCutoff, true);
});

test('effective bit depth spots 16-bit audio in a 24-bit container', () => {
  const x = make(1, (t) => Math.round(sine(300, 0.5)(t) * 32768) / 32768);
  assert.equal(AH.effectiveBitDepth([x]), 16);
  assert.match(titles(AH.analyze([x], SR, { bitDepth: 24, codec: 'PCM' })), /Padded bit depth/);
});

test('sniffs WAV and MP3 headers', () => {
  const wav = new Uint8Array(44);
  const dv = new DataView(wav.buffer);
  [...'RIFF'].forEach((c, i) => (wav[i] = c.charCodeAt(0)));
  [...'WAVEfmt '].forEach((c, i) => (wav[8 + i] = c.charCodeAt(0)));
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, 96000, true); dv.setUint16(34, 24, true);
  assert.deepEqual(AH.sniffFormat(wav), { container: 'WAV', codec: 'PCM', channels: 2, sampleRate: 96000, bitDepth: 24, lossless: true });
  const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0, 0, 0, 0]); // MPEG1 L3 128 kbps 44.1 kHz
  const f = AH.sniffFormat(mp3);
  assert.equal(f.container, 'MP3');
  assert.equal(f.sampleRate, 44100);
  assert.equal(f.bitrateKbps, 128);
});

test('HPSS layers sum back to the input and separate tones from clicks', async () => {
  const tone = make(4, sine(440, 0.3));
  const clicks = make(4, (t, i) => (i % 12000 < 100 ? 0.8 * rand() * Math.exp(-(i % 12000) / 20) : 0));
  const x = tone.map((v, i) => v + clicks[i]);
  const { harmonic, percussive, residual } = await AL.hpss(x, SR);
  let err = 0;
  for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(harmonic[i] + percussive[i] + residual[i] - x[i]));
  assert.ok(err < 1e-5, `reconstruction error ${err}`);
  const corr = (a, b) => { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return ab / Math.sqrt(aa * bb); };
  assert.ok(corr(harmonic, tone) > 0.95);
  assert.ok(corr(percussive, clicks) > 0.6);
});

test('dissect returns five layers for stereo input', async () => {
  const x = make(3, sine(330, 0.3));
  const res = await AL.dissect([x, x.map((v) => v * 0.5)], SR);
  assert.deepEqual(res.layers.map((l) => l.id), ['harmonic', 'percussive', 'residual', 'mid', 'side']);
});

test('effective bit depth handles Chrome-style mixed 32767/32768 scaling', () => {
  const x = Float32Array.from({ length: 4800 }, (_, i) => {
    const k = Math.round(Math.sin(i / 5) * 20000);
    return k >= 0 ? k / 32767 : k / 32768;
  });
  assert.equal(AH.effectiveBitDepth([x]), 16);
});
