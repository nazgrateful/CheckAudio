/*
 * CheckAudio explanations.
 *
 * Turns raw measurements into plain-language descriptions: what each number
 * is, and what this file's value means. Every function returns
 *   { what, meaning, status }   status: 'good' | 'warn' | 'bad' | 'neutral'
 * Works in the browser (window.AudioExplain) and in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AudioExplain = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const r1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
  const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
  const out = (what, meaning, status = 'neutral') => ({ what, meaning, status });

  // ------------------------------------------------------------ metrics ---

  function peak(levels) {
    const what = 'The loudest single sample in the file. 0 dBFS is the digital ceiling: nothing can go above it.';
    const v = levels.peakDb;
    if (!ok(v) || v < -150) return out(what, 'The file is silent.', 'bad');
    if (levels.clipEvents > 0) return out(what, `Peaks hit the ceiling and were flattened (clipping), so the loudest moments are distorted.`, 'bad');
    if (v > -0.1) return out(what, 'Peaks touch the ceiling with no safety margin. Converting to MP3/AAC or uploading to a streaming service can push them over and add distortion.', 'warn');
    if (v > -1) return out(what, `Just under the ceiling (${r1(v)} dBFS). Fine for a finished master, but tight for streaming, where about -1 dBFS is recommended.`, 'warn');
    if (v > -6) return out(what, 'Healthy headroom: loud, without risk of distortion.', 'good');
    if (v > -20) return out(what, 'Plenty of headroom. The file could be made louder without distorting.', 'neutral');
    return out(what, 'Very quiet. It needs a lot of extra volume, which also raises any background noise.', 'warn');
  }

  function integrated(loud) {
    const what = 'Average perceived loudness of the whole file, weighted like human hearing (LUFS). This is what Spotify, YouTube and Apple Music measure.';
    const v = loud.integrated;
    if (!ok(v)) return out(what, 'Too short or too quiet to measure (needs at least 0.4 s above -70 LUFS).', 'neutral');
    if (v > -9) return out(what, `Very loud (${r1(v)} LUFS), typical of heavily limited masters. Streaming services will turn it down by about ${Math.round(v + 14)} dB, so the extra loudness buys nothing and costs dynamics.`, 'bad');
    if (v > -12) return out(what, 'Loud, like a commercial master. Streaming services will turn it down slightly to their target of about -14 LUFS.', 'warn');
    if (v >= -16.5) return out(what, 'Right in the range streaming services and podcasts aim for (-14 to -16 LUFS). It will play at a normal volume everywhere.', 'good');
    if (v >= -24) return out(what, 'Moderate. This suits broadcast TV (-23/-24 LUFS) or dynamic music like classical. Streaming services may turn it up.', 'neutral');
    return out(what, 'Quiet. Most platforms will need to turn it up, and listeners may have to raise their volume.', 'warn');
  }

  function range(loud) {
    const what = 'Loudness range (LU): how much the loudness changes between the quiet and loud sections.';
    const v = loud.range;
    if (!ok(v)) return out(what, 'Not enough audio to measure (needs a few seconds).', 'neutral');
    if (v < 3) return out(what, 'Very consistent loudness, typical of heavily compressed pop, EDM, or speech processed for radio.', 'neutral');
    if (v < 8) return out(what, 'Moderate variation, typical of most pop, rock and podcasts.', 'good');
    if (v < 15) return out(what, 'Wide variation: dynamic music, film sound or live recordings.', 'neutral');
    return out(what, 'Very wide variation. Quiet and loud parts differ a lot, which can be hard to follow in a car or a noisy place.', 'warn');
  }

  function shortTerm(loud) {
    const what = 'The loudness of the loudest 3-second stretch.';
    if (!ok(loud.maxShortTerm)) return out(what, 'Not enough audio to measure.', 'neutral');
    if (!ok(loud.integrated)) return out(what, 'Measured, but there is no overall loudness to compare it with.', 'neutral');
    const d = loud.maxShortTerm - loud.integrated;
    if (d > 8) return out(what, `The loudest part is ${r1(d)} LU above the average: a big climax or a sudden loud moment. Watch for listeners reaching for the volume.`, 'neutral');
    if (d > 3) return out(what, `The loudest part is ${r1(d)} LU above the average. There is a normal amount of build-up.`, 'good');
    return out(what, 'Even the loudest moments stay close to the average, so the loudness is very even.', 'neutral');
  }

  function rms(levels) {
    return out('Average signal level (RMS), without any hearing weighting.',
      ok(levels.rmsDb) && levels.rmsDb > -150 ? `On average the signal sits ${r1(-levels.rmsDb)} dB below the ceiling.` : 'The file is silent.', 'neutral');
  }

  function crest(levels) {
    const what = 'Crest factor: the gap between the peaks and the average level. It shows how punchy or how squashed the sound is.';
    const v = levels.crestDb;
    if (!ok(v)) return out(what, 'Not measurable.', 'neutral');
    if (v < 8) return out(what, 'Very low: heavily compressed or limited. Drum hits and other transients are flattened, which can sound tiring.', 'bad');
    if (v < 12) return out(what, 'Moderately compressed, which is common in modern masters.', 'warn');
    if (v < 18) return out(what, 'Natural dynamics with clear punch.', 'good');
    return out(what, 'Very dynamic and spiky, typical of acoustic, classical or unprocessed recordings.', 'neutral');
  }

  function noiseFloor(levels, silence) {
    const what = 'Level of the quietest 10% of the file. In the pauses, this is the background noise.';
    const v = levels.noiseFloorDb;
    if (!ok(v)) return out(what, 'The file is completely silent or has no audible audio.', 'neutral');
    if (levels.typicalDb !== undefined && levels.typicalDb - v < 12) {
      return out(what, 'The file has no real pauses, so this mostly reflects the quietest music rather than noise.', 'neutral');
    }
    if (v < -70) return out(what, 'Very quiet background. The recording is clean.', 'good');
    if (v < -55) return out(what, 'A normal background level for most recordings.', 'good');
    if (v < -40) return out(what, 'Audible background noise or room tone in the quiet parts (hiss, air conditioning, traffic).', 'warn');
    return out(what, 'The quiet parts are still quite loud. There is strong background noise, or the pauses are not really silent.', 'warn');
  }

  function bandwidth(freq, sampleRate) {
    const what = 'The highest frequency that has real content. Human hearing tops out around 16 to 20 kHz, and less with age.';
    const v = freq.bandwidthHz;
    const nyq = sampleRate / 2;
    if (!v) return out(what, 'No content found.', 'neutral');
    if (v >= Math.min(19000, nyq * 0.9)) return out(what, 'Full bandwidth: nothing is missing at the top end.', 'good');
    if (v < 5000) return out(what, `Very narrow (stops at ${hz(v)}), telephone or voice-memo quality. It will sound muffled.`, 'bad');
    if (freq.sharpCutoff) return out(what, `It stops abruptly at ${hz(v)}, which is the signature of lossy encoding (MP3/AAC, or a low-quality copy). The highs above that are gone for good. If this file claims to be lossless, it was made from a lossy source.`, 'warn');
    if (v < 15000) return out(what, `Narrow (about ${hz(v)}). It will sound dull, typical of low-bitrate files, old recordings or heavy filtering.`, 'warn');
    return out(what, `It rolls off gently around ${hz(v)}. The sound is a little darker, either from the source itself or from a low-pass filter.`, 'neutral');
  }

  function clipping(levels) {
    const what = 'Clipping: places where the waveform tried to go past the ceiling and its tops were cut flat.';
    const n = levels.clipEvents;
    if (!n) return out(what, 'No flattened peaks, so there is no digital distortion.', 'good');
    if (n <= 20) return out(what, `${n} clipped spot${n === 1 ? '' : 's'} (${levels.clippedSamples} samples). These may be audible as crackles on the loudest hits.`, 'warn');
    return out(what, `${n} clipped spots (${levels.clippedSamples} samples). Clipping is widespread, so loud parts will sound distorted. Clipping can't be fully undone, so use an earlier, unclipped version if you have one.`, 'bad');
  }

  function dcOffset(levels) {
    const what = 'DC offset: whether the waveform is centred on zero.';
    const v = Math.max(...levels.perChannel.map((c) => Math.abs(c.dcOffset))) * 100;
    if (v < 0.1) return out(what, 'Centred correctly.', 'good');
    if (v < 0.5) return out(what, 'Slightly off-centre. This is harmless.', 'neutral');
    return out(what, 'Noticeably off-centre. It wastes headroom and can cause clicks at edit points. A high-pass filter around 20 Hz fixes it.', 'warn');
  }

  function silence(s) {
    const what = 'The share of the file that is near-silent (below -60 dBFS), and any dropouts.';
    if (s.dropouts.length) return out(what, `${s.dropouts.length} dropout${s.dropouts.length === 1 ? '' : 's'}: tiny gaps of pure digital silence in the middle of the sound, usually a glitch during recording or export. They are audible as clicks or stutters.`, 'bad');
    if (s.percent > 30) return out(what, `${r1(s.percent)}% is silent. Check for long gaps, especially at the start (${r1(s.leadingSeconds)} s) and end (${r1(s.trailingSeconds)} s).`, 'warn');
    if (s.percent > 5) return out(what, 'Some quiet gaps, which is normal for speech or songs with breaks.', 'neutral');
    return out(what, 'Almost no silence and no dropouts.', 'good');
  }

  function bitDepth(info) {
    const what = 'Effective bit depth: the resolution the samples actually use. More bits means a lower noise floor and more room for editing.';
    const b = info.effectiveBitDepth, stored = info.format && info.format.bitDepth;
    const padded = stored && stored > b && info.format.codec !== 'PCM float' ? ` The file is stored as ${stored}-bit but only uses ${b} bits, so it was converted up rather than recorded at the higher resolution.` : '';
    if (b <= 8) return out(what, `Low resolution (8-bit), with audible hiss and graininess.${padded}`, 'warn');
    if (b === 16) return out(what, `CD quality (16-bit, about 96 dB of dynamic range), which is plenty for listening.${padded}`, padded ? 'neutral' : 'good');
    if (b === 24) return out(what, `Studio resolution (24-bit), ideal for editing and mastering.${padded}`, 'good');
    return out(what, 'Floating-point or high-resolution data (or a lossy file decoded to floating point). It has maximum headroom for editing.', 'good');
  }

  function correlation(st) {
    const what = 'Stereo correlation: how similar left and right are. +1 means identical, 0 unrelated, and negative means opposite (cancelling).';
    if (!st) return out(what, 'Mono file: there is only one channel.', 'neutral');
    if (st.leftSilent || st.rightSilent) return out(what, `The ${st.leftSilent ? 'left' : 'right'} channel is silent, so one speaker will play nothing.`, 'bad');
    if (st.identical) return out(what, 'Both channels are identical. This is mono stored as stereo, so the file is twice as big as it needs to be.', 'neutral');
    const c = st.correlation;
    if (!ok(c)) return out(what, 'Not measurable.', 'neutral');
    if (c < 0) return out(what, 'Out of phase: parts of the sound cancel out when played in mono (phones, Bluetooth speakers, club systems). One channel may be polarity-inverted.', 'bad');
    if (c < 0.3) return out(what, 'Very wide stereo. Some elements may weaken or vanish when played in mono.', 'warn');
    if (c > 0.95) return out(what, 'Nearly mono, with a narrow stereo image.', 'neutral');
    return out(what, 'Healthy stereo width that also holds up on mono speakers.', 'good');
  }

  function balance(st) {
    const what = 'Channel balance: whether the left or right side is louder.';
    if (!st || !ok(st.balanceDb)) return out(what, 'Not applicable.', 'neutral');
    const v = Math.abs(st.balanceDb);
    if (v < 1) return out(what, 'Left and right are balanced.', 'good');
    if (v < 3) return out(what, 'Slightly lopsided, usually because of how it was mixed.', 'neutral');
    return out(what, `The ${st.balanceDb > 0 ? 'left' : 'right'} side is clearly louder. It may be a panning mistake, a faulty cable or a bad channel.`, 'warn');
  }

  function hum(freq) {
    const what = 'Mains hum: buzzing picked up from the electricity supply. It runs at 50 Hz in Europe, Asia, Africa and Australia, and at 60 Hz in the Americas and parts of Japan.';
    if (!freq.hum.detected) return out(what, 'Not detected. There is no electrical hum.', 'good');
    const where = freq.hum.frequency === 50 ? 'Europe, Asia, Africa or Australia' : 'the Americas, Korea, Taiwan or western Japan';
    return out(what, `${freq.hum.frequency} Hz hum is present, from a ground loop, an unshielded cable or nearby power equipment. It also hints that the recording was made somewhere on a ${freq.hum.frequency} Hz grid: ${where}.`, 'warn');
  }

  function sampleRate(info) {
    const what = 'Sample rate: how many times per second the sound was measured. The highest frequency a file can hold is half of this.';
    const sr = info.sampleRate;
    if (sr < 32000) return out(what, `Reduced quality. Nothing above ${hz(sr / 2)} can exist in this file.`, 'warn');
    if (sr === 44100) return out(what, 'CD standard. It captures everything people can hear.', 'good');
    if (sr === 48000) return out(what, 'Video and broadcast standard. It captures everything people can hear.', 'good');
    if (sr > 48000) return out(what, 'High resolution. The extra range is above human hearing, but it gives more room for processing.', 'good');
    return out(what, 'Fine for most listening.', 'neutral');
  }

  function codec(format) {
    const what = 'File format. Lossless formats keep every detail, while lossy formats (MP3, AAC, Ogg, Opus) throw some away to save space.';
    if (format.lossless === true) return out(what, `${format.codec || format.container} is lossless: what you hear is exactly what was saved.`, 'good');
    if (format.lossless === false) {
      const k = format.bitrateKbps;
      if (!k) return out(what, `${format.codec} is lossy. Some detail was discarded to make the file smaller.`, 'neutral');
      if (k >= 256) return out(what, `${format.codec} at ${k} kbps. It is lossy, but transparent for most listeners.`, 'good');
      if (k >= 128) return out(what, `${format.codec} at ${k} kbps. Good quality, though trained ears may hear artifacts on cymbals and reverb.`, 'neutral');
      return out(what, `${format.codec} at ${k} kbps, a low bitrate. Expect audible swishy or watery artifacts and dull highs.`, 'warn');
    }
    return out(what, `${format.container || 'Unknown'} container. The codec could not be confirmed from the header.`, 'neutral');
  }

  /** All metric explanations for a health report, keyed by metric id. */
  function metrics(report) {
    const L = report.levels, LU = report.loudness, F = report.frequency, I = report.info;
    const res = {
      peak: peak(L), loudness: integrated(LU), range: range(LU), shortTerm: shortTerm(LU), rms: rms(L),
      crest: crest(L), noise: noiseFloor(L, report.silence), bandwidth: bandwidth(F, I.sampleRate), clipping: clipping(L),
      dc: dcOffset(L), silence: silence(report.silence), bitDepth: bitDepth(I), hum: hum(F),
      sampleRate: sampleRate(I), format: codec(I.format || {}),
    };
    if (report.stereo) { res.correlation = correlation(report.stereo); res.balance = balance(report.stereo); }
    return res;
  }

  // -------------------------------------------------------------- bands ---

  // Typical share of total energy for music (rough guide; speech is lighter in the lows and highs).
  const BAND_INFO = {
    'Sub-bass': { what: 'Felt more than heard: deep kick drums, 808s, rumble.', lo: 1, hi: 25, low: 'Almost no deep bass. It will sound thin on big speakers (normal for speech and acoustic music).', high: 'Very heavy sub-bass. It will boom on large systems and can overload small speakers.' },
    Bass: { what: 'Warmth and weight: bass guitar, the body of the kick drum, the lower range of male voices.', lo: 10, hi: 55, low: 'Light on bass, so it will sound lean.', high: 'Bass-heavy. It sounds big but may mask other parts.' },
    'Low mids': { what: 'Body and fullness. Too much here sounds muddy or boxy.', lo: 5, hi: 35, low: 'Little body, so it can sound hollow.', high: 'A lot of low-mid energy, which can sound muddy or boxy.' },
    Mids: { what: 'The core of most instruments and of voices. Speech intelligibility lives here.', lo: 5, hi: 45, low: 'Scooped mids. Vocals and instruments may sound distant.', high: 'Mid-focused, which is very present and typical of voice recordings.' },
    'Upper mids': { what: 'Presence and clarity. The ear is most sensitive here, so too much sounds harsh.', lo: 0.5, hi: 15, low: 'Soft upper mids. The sound is smooth but can lack clarity.', high: 'Strong upper mids. It can sound harsh or shouty at high volume.' },
    Presence: { what: 'Definition and attack: consonants, the pick of a guitar, the stick on a drum.', lo: 0.2, hi: 8, low: 'Low presence. It may sound muffled or lack definition.', high: 'A lot of presence. It is bright and forward, and may be fatiguing.' },
    Brilliance: { what: 'Air and sparkle: cymbals, breath, "s" sounds.', lo: 0.05, hi: 10, low: 'Almost no air or sparkle. It will sound dull or muffled.', high: 'Very bright. Sibilance ("s" sounds) or cymbals may be piercing.' },
  };

  function band(b) {
    const i = BAND_INFO[b.name];
    if (!i) return out('', '', 'neutral');
    const p = b.percent;
    if (p < i.lo) return out(i.what, `${r1(p)}% of the energy. ${i.low}`, 'warn');
    if (p > i.hi) return out(i.what, `${r1(p)}% of the energy. ${i.high}`, 'warn');
    return out(i.what, `${r1(p)}% of the energy, a typical amount for music.`, 'good');
  }

  function bandsSummary(bands) {
    const sorted = [...bands].sort((a, b) => b.percent - a.percent);
    const low = bands.slice(0, 2).reduce((a, b) => a + b.percent, 0);
    const high = bands.slice(4).reduce((a, b) => a + b.percent, 0);
    const tilt = low > 70 ? 'The balance leans heavily towards the low end, giving a warm or dark, bass-driven sound.'
      : high > 25 ? 'The balance leans towards the high end, giving a bright, crisp or thin sound.'
        : 'The balance is centred on the low and middle frequencies, which is normal for most music and voice.';
    return `Most of the energy is in the ${sorted[0].name.toLowerCase()} (${r1(sorted[0].percent)}%), followed by the ${sorted[1].name.toLowerCase()} (${r1(sorted[1].percent)}%). ${tilt}`;
  }

  // ------------------------------------------------------------- layers ---

  const REGION_SHORT = {
    'Sub-bass': 'deep bass you feel more than hear', Bass: 'warmth and weight', 'Low mids': 'body and fullness',
    Mids: 'the core of voices and instruments', 'Upper mids': 'presence and clarity', Presence: 'definition and attack', Brilliance: 'air and sparkle',
  };

  function regionOf(f) {
    const b = Object.keys(BAND_INFO);
    const edges = [60, 250, 500, 2000, 4000, 6000, Infinity];
    return b[edges.findIndex((e) => f < e)];
  }

  function layer(l) {
    const s = l.sharePercent;
    const texts = {
      harmonic: [[80, 'The file is dominated by sustained, pitched sound: melodies, chords, singing or speech.', 'neutral'], [40, 'A mix of tonal and rhythmic content.', 'neutral'], [-1, 'Little sustained pitch. The file is mostly rhythm or noise.', 'neutral']],
      percussive: [[30, 'Strongly rhythmic, with drums, beats or lots of sharp transients.', 'neutral'], [10, 'Clear rhythmic or percussive elements.', 'neutral'], [-1, 'Few sharp transients. The material is smooth or sustained.', 'neutral']],
      residual: [[20, 'Lots of noise-like content: hiss, room ambience, reverb, distortion or breathiness. If unintended, the recording may be noisy.', 'warn'], [5, 'Some ambience, reverb or background noise.', 'neutral'], [-1, 'Clean and dry, with little noise or reverb.', 'good']],
      mid: [[90, 'Nearly everything sits in the centre: a narrow or near-mono mix.', 'neutral'], [70, 'Typical: the main elements are centred, with some stereo spread around them.', 'good'], [-1, 'Unusually wide. A lot of the sound is off-centre.', 'warn']],
      side: [[30, 'Very wide stereo. The mix may thin out on mono speakers.', 'warn'], [5, 'Normal stereo width from reverbs and panned instruments.', 'good'], [-1, 'Little stereo information, close to mono.', 'neutral']],
    }[l.id] || [];
    const [, meaning, status] = texts.find(([min]) => s > min) || [0, '', 'neutral'];
    const region = regionOf(l.centroidHz);
    const where = l.sharePercent < 0.01 ? 'This layer is essentially empty.'
      : `Its energy sits mainly between ${hz(l.rangeHz[0])} and ${hz(l.rangeHz[1])}, centred in the ${region.toLowerCase()} region (${REGION_SHORT[region]}).`;
    return out(`${r1(s)}% of the file's energy.`, `${meaning} ${where}`, status);
  }

  // -------------------------------------------------------------- tones ---

  function tone(t) {
    const l = t.label;
    if (l.startsWith('Mains hum')) return out('Electrical hum, or one of its harmonics.', 'Comes from the power supply: a ground loop, an unshielded cable or nearby equipment. A notch filter or a hum-removal tool can take it out.', 'warn');
    if (l.startsWith('CRT')) return out('Line whine from an old CRT TV or monitor (about 15.7 kHz).', 'A tube TV or monitor was running near the microphone. Many adults can no longer hear it, but younger listeners can.', 'warn');
    if (l.startsWith('High-frequency')) return out('A steady tone near the top of hearing.', 'Possible sources: switching power supplies, chargers, monitors, camera electronics, or a deliberately inaudible watermark or tracking tone added by software or a broadcaster.', 'warn');
    if (l.startsWith('Subsonic')) return out('A steady tone below hearing.', 'It cannot be heard, but it uses headroom and can make speaker cones move visibly. A high-pass filter removes it.', 'warn');
    if (l.startsWith('Test tone')) return out('A 1 kHz reference tone.', 'Used to calibrate levels, or for broadcast line-up and censoring ("bleep"). It was deliberately added.', 'neutral');
    if (l.startsWith('Tuning tone')) return out('A 440 Hz tone, the A that musicians tune to.', 'A tuning reference, or a very steady held note.', 'neutral');
    return out('A tone that stays at one frequency for most of the file.', 'It could be a long held note or drone in the music, or an added tone from equipment. Listen to the tonal layer to tell which.', 'neutral');
  }

  // ------------------------------------------------------------- charts ---

  function charts(report) {
    const F = report.frequency;
    const peakBand = [...F.bands].sort((a, b) => b.percent - a.percent)[0];
    return {
      wave: `The shape of the sound over time: taller means louder. ${report.levels.clipEvents ? 'Red marks show where it clipped.' : 'There are no clipping marks.'} ${report.silence.dropouts.length ? 'Thin gaps are dropouts.' : ''}`.trim(),
      spectrum: `Which pitches the file contains, averaged over its whole length: low on the left, high on the right, and higher means more energy. Here the strongest region is the ${peakBand.name.toLowerCase()} and content reaches ${hz(F.bandwidthHz)}. Narrow spikes are steady tones, and a sudden drop near the right edge means a lossy encoding cutoff.`,
      spectrogram: 'Pitch over time: time runs left to right, pitch rises bottom to top, and brighter means louder. Horizontal lines are sustained notes or tones (a line running the whole width is a steady added tone). Vertical streaks are hits and clicks, and an empty band at the top is a bandwidth cutoff.',
      bands: bandsSummary(F.bands),
    };
  }

  return { metrics, band, bandsSummary, layer, tone, charts, BAND_INFO };
});
