const test = require('node:test');
const assert = require('node:assert/strict');
const AH = require('../analysis.js');
const AE = require('../explain.js');

const SR = 48000;
const tone = Float32Array.from({ length: SR * 4 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR) * (1 + 0.5 * Math.sin(i / 9000)));

test('every metric gets a what, a meaning and a status', () => {
  const r = AH.analyze([tone, tone.map((v) => v * 0.9)], SR, { container: 'WAV', codec: 'PCM', lossless: true, bitDepth: 16 });
  const m = AE.metrics(r);
  for (const id of ['peak', 'loudness', 'range', 'shortTerm', 'rms', 'crest', 'noise', 'bandwidth', 'clipping', 'dc', 'silence', 'bitDepth', 'hum', 'sampleRate', 'format', 'correlation', 'balance']) {
    assert.ok(m[id], id);
    assert.ok(m[id].what.length > 10 && m[id].meaning.length > 5, id);
    assert.ok(['good', 'warn', 'bad', 'neutral'].includes(m[id].status), id);
  }
  for (const b of r.frequency.bands) assert.ok(AE.band(b).meaning.includes('%'));
  const c = AE.charts(r);
  for (const k of ['wave', 'spectrum', 'spectrogram', 'bands']) assert.ok(c[k].length > 20, k);
});

test('explanations react to the values', () => {
  assert.equal(AE.metrics({ ...base(), loudness: { integrated: -6, range: 2, maxShortTerm: -5 } }).loudness.status, 'bad');
  assert.equal(AE.metrics({ ...base(), loudness: { integrated: -14, range: 6, maxShortTerm: -10 } }).loudness.status, 'good');
  assert.match(AE.metrics({ ...base(), frequency: { ...base().frequency, bandwidthHz: 16000, sharpCutoff: true } }).bandwidth.meaning, /lossy/);
  assert.match(AE.metrics({ ...base(), frequency: { ...base().frequency, hum: { detected: true, frequency: 50 } } }).hum.meaning, /Europe/);
  assert.equal(AE.tone({ label: 'Mains hum (60 Hz × 1)' }).status, 'warn');
  const l = AE.layer({ id: 'residual', sharePercent: 2, centroidHz: 300, rangeHz: [100, 900] });
  assert.equal(l.status, 'good');
  assert.match(l.meaning, /low mids region \(body and fullness\)/);
});

function base() {
  return {
    levels: { peakDb: -3, rmsDb: -18, crestDb: 15, clipEvents: 0, clippedSamples: 0, noiseFloorDb: -60, typicalDb: -20, perChannel: [{ dcOffset: 0 }] },
    loudness: { integrated: -14, range: 6, maxShortTerm: -10 },
    frequency: { bandwidthHz: 20000, sharpCutoff: false, hum: { detected: false }, bands: AH.BANDS.map((b) => ({ ...b, percent: 10 })) },
    silence: { percent: 1, dropouts: [], leadingSeconds: 0, trailingSeconds: 0 },
    info: { sampleRate: 44100, effectiveBitDepth: 16, format: { codec: 'PCM', lossless: true } },
    stereo: null,
  };
}
