/* CheckAudio UI: wires the analysis, layer and transcription engines to the page. */
(function () {
  'use strict';

  const AH = window.AudioHealth;
  const AL = window.AudioLayers;
  const AT = window.AudioTranscribe;
  const AS = window.AudioScan;
  const GD = window.GDrive;
  const AE = window.AudioExplain;
  const HI = window.AudioHistory;
  const $ = (id) => document.getElementById(id);

  const state = {
    file: null, scan: null, channels: null, sampleRate: 0, format: null, resampled: false,
    report: null, envelope: null, sgram: null,
    layers: null, tones: null, transcript: null,
    saved: null, // summary of the history entry being viewed (no audio available)
  };

  // ------------------------------------------------------------ helpers ---

  const fmt = (v, d = 1, unit = '') => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}${unit}`);
  const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
  const fmtSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
  const fmtDur = (s) => { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light'
    || document.documentElement.dataset.theme === 'dark';
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) n.append(kid.nodeType ? kid : String(kid));
    return n;
  };
  const tick = () => new Promise((r) => setTimeout(r, 30));

  function setStatus(text, fraction) {
    $('status').hidden = !text;
    $('status-text').textContent = text || '';
    $('status-bar').style.width = fraction === undefined ? '0' : `${Math.round(fraction * 100)}%`;
  }
  function showError(msg) { $('error').hidden = !msg; $('error').textContent = msg || ''; }

  function download(name, data, type) {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function encodeWav(channels, sampleRate) {
    const n = channels[0].length, nc = channels.length;
    const buf = new ArrayBuffer(44 + n * nc * 2);
    const dv = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nc, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * nc * 2, true);
    dv.setUint16(32, nc * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * nc * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++, o += 2) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ----------------------------------------------------------- playback ---

  let audioCtx = null, playing = null;
  function stop() {
    if (playing) { try { playing.src.stop(); } catch (e) { /* already stopped */ } playing.btn && (playing.btn.textContent = playing.label); playing = null; }
  }
  function play(channels, offset = 0, btn = null, toggle = true) {
    const same = toggle && playing && playing.btn === btn && btn;
    stop();
    if (same) return;
    audioCtx = audioCtx || new AudioContext();
    audioCtx.resume();
    const buf = audioCtx.createBuffer(channels.length, channels[0].length, state.sampleRate);
    channels.forEach((c, i) => buf.copyToChannel(c, i));
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0, offset);
    playing = { src, btn, label: btn ? btn.textContent : '' };
    if (btn) btn.textContent = '■ Stop';
    src.onended = () => { if (playing && playing.src === src) stop(); };
  }

  // ------------------------------------------------------------ loading ---

  async function decode(bytes) {
    const format = AH.sniffFormat(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4 << 20)));
    const known = format.sampleRate >= 8000 && format.sampleRate <= 384000;
    const tryRate = async (rate) => {
      const ctx = new OfflineAudioContext(1, 1, rate);
      return ctx.decodeAudioData(bytes.slice(0));
    };
    let buffer, resampled = !known;
    try {
      buffer = await tryRate(known ? format.sampleRate : 48000);
    } catch (e) {
      if (!known) throw new Error('This browser could not decode the file. Try WAV, FLAC or MP3.');
      buffer = await tryRate(48000);
      resampled = true;
    }
    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    return { channels, sampleRate: buffer.sampleRate, format, resampled };
  }

  async function loadFile(file) {
    stop();
    showError('');
    $('results').hidden = true;
    Object.assign(state, { file, scan: null, report: null, channels: null, envelope: null, sgram: null, layers: null, tones: null, transcript: null, saved: null });
    $('saved-banner').hidden = true;
    let bytes;
    try {
      setStatus('Scanning for threats…', 0.05);
      await tick();
      bytes = await file.arrayBuffer();
      state.scan = await AS.scan(bytes, file.name);
      renderSecurity();
    } catch (e) {
      console.error(e);
      setStatus('');
      showError(`Could not read the file: ${e.message}`);
      return;
    }
    if (state.scan.verdict === 'danger') {
      securityOnly('Audio analysis was skipped because this file looks dangerous. Don\'t open it in other programs.');
      saveHistory();
      return;
    }
    try {
      setStatus('Decoding audio…', 0.1);
      await tick();
      Object.assign(state, await decode(bytes));
      setStatus('Running health check…', 0.5);
      await tick();
      state.report = AH.analyze(state.channels, state.sampleRate, state.format);
      const mono = AH.mixToMono(state.channels);
      state.sgram = AH.spectrogram(mono, state.sampleRate, { size: 2048, columns: 700 });
      state.envelope = envelope(state.channels, 2000, state.report);
      setStatus('');
      renderHeader();
      renderHealth();
      resetLayers();
      resetTranscript();
      showTabs(true);
      $('results').hidden = false;
      selectTab(state.scan.verdict === 'clean' ? 'health' : 'security');
      saveHistory();
    } catch (e) {
      console.error(e);
      securityOnly(e.message || String(e));
      saveHistory();
    }
  }

  /** Show only the Security tab, e.g. when the file is dangerous or isn't decodable audio. */
  function securityOnly(message) {
    setStatus('');
    $('file-name').textContent = state.file.name;
    $('file-meta').textContent = `${state.scan.detected.name} · ${fmtSize(state.file.size)}`;
    showTabs(false);
    $('results').hidden = false;
    selectTab('security');
    showError(message);
  }

  function showTabs(all) {
    document.querySelectorAll('.tabs button').forEach((b) => { b.hidden = !all && b.dataset.tab !== 'security'; });
    $('play-all').hidden = !all || !state.channels;
  }

  // ------------------------------------------------------------ security ---

  const SEC_TEXT = {
    clean: ['No threats found', 'Nothing suspicious was found in this file.', '✓'],
    suspicious: ['Suspicious', 'Something unusual was found. Read the findings before trusting this file.', '!'],
    danger: ['Dangerous file', 'This file shows clear signs of malware or a disguised program. Do not open it.', '✕'],
  };
  const SEC_ICON = { critical: '✕', warning: '!', info: 'i', ok: '✓' };

  function renderSecurity() {
    const r = state.scan;
    const [title, sub, icon] = SEC_TEXT[r.verdict];
    $('sec-shield').className = `shield ${r.verdict}`;
    $('sec-shield').textContent = icon;
    $('sec-verdict').textContent = title;
    $('sec-sub').textContent = sub;
    const badge = $('sec-badge');
    badge.className = `badge ${r.verdict}`;
    badge.textContent = icon;
    badge.setAttribute('aria-label', title);
    const items = r.findings.length ? r.findings : [{ severity: 'ok', title: 'Clean', detail: `The content is real ${r.detected.name}. There are no hidden programs, archives, scripts or malformed headers, and the name matches the content.` }];
    $('sec-findings').replaceChildren(...items.map((f) => el('li', { class: `issue ${f.severity}` },
      el('span', { class: 'icon', 'aria-label': f.severity }, SEC_ICON[f.severity]),
      el('div', {}, el('b', {}, f.title), el('p', {}, f.detail)))));
    const MARK = { pass: '✓', warn: '!', fail: '✕', skip: '–' };
    $('sec-checks').replaceChildren(...(r.checks || []).map((c) => el('li', { class: c.status },
      el('span', { class: 'mark', 'aria-label': c.status }, MARK[c.status]),
      el('b', {}, c.label), el('span', { class: 'detail' }, c.detail))));
    const passed = (r.checks || []).filter((c) => c.status === 'pass').length;
    const total = (r.checks || []).filter((c) => c.status !== 'skip').length;
    const SAFETY = {
      clean: ['Safe: no threats found', `Passed all ${total} security checks. The contents are real ${r.detected.name}.`],
      suspicious: ['Suspicious: check the details', `Passed ${passed} of ${total} security checks. Something unusual was found.`],
      danger: ['Dangerous: do not open this file', `Failed ${total - passed} of ${total} security checks.`],
    }[r.verdict];
    $('safety').className = `safety ${r.verdict}`;
    $('safety-icon').textContent = icon;
    $('safety-title').textContent = SAFETY[0];
    $('safety-text').textContent = SAFETY[1];
    $('safety').hidden = false;
    $('sec-type').textContent = r.detected.name;
    $('sec-size').textContent = `${r.size.toLocaleString('en-US')} bytes`;
    $('sec-hash').textContent = r.sha256 || 'Unavailable (needs https or localhost)';
    $('sec-vt').hidden = !r.virusTotalUrl;
    if (r.virusTotalUrl) $('sec-vt').href = r.virusTotalUrl;
    $('sec-copy').hidden = !r.sha256;
  }
  $('safety').addEventListener('click', () => { selectTab('security'); document.querySelector('.tabs').scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  // -------------------------------------------------------- google drive ---

  async function loadFromDrive(getFile) {
    showError('');
    try {
      setStatus('Connecting to Google Drive…');
      const file = await getFile((loaded, total) => setStatus(`Downloading from Google Drive… ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`, loaded / total));
      setStatus('');
      if (file) await loadFile(file);
    } catch (e) {
      console.error(e);
      setStatus('');
      showError(e.message || String(e));
    }
  }

  /** Text dragged or pasted from Google Drive arrives as a link rather than a file. */
  function driveLinkFrom(dt) {
    for (const type of ['text/uri-list', 'text/plain', 'text/html']) {
      const v = dt.getData(type);
      if (v && GD.extractId(v)) return v;
    }
    return null;
  }

  // -------------------------------------------------------------- header ---

  function renderHeader() {
    const { info } = state.report;
    const f = state.format;
    $('file-name').textContent = state.file.name;
    const parts = [
      fmtDur(info.duration),
      `${(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 ? 1 : 0)} kHz`,
      info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels} ch`,
      f.codec || f.container,
      f.bitDepth ? `${f.bitDepth}-bit` : null,
      f.bitrateKbps ? `${f.bitrateKbps} kbps` : null,
      fmtSize(state.file.size),
    ].filter(Boolean);
    if (state.resampled) parts.push('sample rate set by browser');
    $('file-meta').textContent = parts.join(' · ');
  }

  // -------------------------------------------------------------- health ---

  const ICON = { error: '✕', warning: '!', info: 'i', ok: '✓' };
  const SEV_LABEL = { error: 'Problem', warning: 'Warning', info: 'Note', ok: 'OK' };

  function renderHealth() {
    const r = state.report;
    $('score').textContent = r.score;
    $('score-box').style.borderColor = r.score >= 90 ? css('--good') : r.score >= 70 ? css('--warning') : r.score >= 40 ? css('--serious') : css('--critical');
    $('verdict').textContent = r.verdict;
    const errors = r.issues.filter((i) => i.severity === 'error').length;
    const warns = r.issues.filter((i) => i.severity === 'warning').length;
    $('verdict-sub').textContent = errors + warns === 0
      ? 'No technical problems found.'
      : `${errors} problem${errors === 1 ? '' : 's'} and ${warns} warning${warns === 1 ? '' : 's'}.`;

    const list = $('issues');
    list.replaceChildren();
    const items = r.issues.length ? r.issues : [{ severity: 'ok', title: 'Everything looks healthy', detail: 'No clipping, dropouts, hum, phase or level problems were detected.' }];
    for (const i of items) {
      list.append(el('li', { class: `issue ${i.severity}` },
        el('span', { class: 'icon', 'aria-label': SEV_LABEL[i.severity] }, ICON[i.severity]),
        el('div', {}, el('b', {}, i.title), el('p', {}, i.detail))));
    }

    const L = r.levels, LU = r.loudness, F = r.frequency, S = r.stereo, I = r.info;
    const X = AE.metrics(r);
    const fmtInfo = I.format || {};
    const rows = [
      ['peak', 'Peak level', fmt(L.peakDb, 1, ' dBFS')],
      ['loudness', 'Integrated loudness', fmt(LU.integrated, 1, ' LUFS')],
      ['range', 'Loudness range', fmt(LU.range, 1, ' LU')],
      ['shortTerm', 'Max short-term loudness', fmt(LU.maxShortTerm, 1, ' LUFS')],
      ['crest', 'Crest factor', fmt(L.crestDb, 1, ' dB')],
      ['rms', 'RMS level', fmt(L.rmsDb, 1, ' dBFS')],
      ['clipping', 'Clipping', L.clipEvents ? `${L.clipEvents} events` : 'None'],
      ['noise', 'Noise floor', fmt(L.noiseFloorDb, 1, ' dBFS')],
      ['silence', 'Silence & dropouts', `${fmt(r.silence.percent, 1, ' %')} · ${r.silence.dropouts.length} dropout${r.silence.dropouts.length === 1 ? '' : 's'}`],
      ['bandwidth', 'Bandwidth', F.bandwidthHz ? fmtHz(F.bandwidthHz) : '—'],
      ['hum', 'Mains hum', F.hum.detected ? `${F.hum.frequency} Hz` : 'None'],
      ['dc', 'DC offset', fmt(Math.max(...L.perChannel.map((c) => Math.abs(c.dcOffset))) * 100, 3, ' %')],
    ];
    if (S) {
      rows.push(['correlation', 'Stereo correlation', fmt(S.correlation, 2)]);
      rows.push(['balance', 'Channel balance', S.balanceDb === null ? '—' : `${S.balanceDb > 0 ? 'L' : 'R'} +${Math.abs(S.balanceDb).toFixed(1)} dB`]);
    }
    rows.push(
      ['bitDepth', 'Effective bit depth', `${I.effectiveBitDepth}-bit`],
      ['sampleRate', 'Sample rate', `${(I.sampleRate / 1000).toFixed(I.sampleRate % 1000 ? 1 : 0)} kHz`],
      ['format', 'Format', [fmtInfo.codec || fmtInfo.container || 'Unknown', fmtInfo.bitrateKbps ? `${fmtInfo.bitrateKbps} kbps` : null].filter(Boolean).join(' · ')],
    );
    $('metrics').replaceChildren(...rows.map(([id, label, value]) => explained(label, value, X[id])));

    const notes = AE.charts(r);
    $('wave-note').textContent = notes.wave;
    $('spectrum-note').textContent = notes.spectrum;
    $('spectrogram-note').textContent = notes.spectrogram;
    $('bands-note').textContent = notes.bands;

    const maxPct = Math.max(...F.bands.map((b) => b.percent), 1);
    $('bands').replaceChildren(...F.bands.map((b) => {
      const x = AE.band(b);
      return el('div', { class: `band status-${x.status}` },
        el('div', {}, b.name, el('div', { class: 'range' }, `${fmtHz(b.lo)}–${fmtHz(b.hi)}`)),
        el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(100 * b.percent) / maxPct}%` })),
        el('div', { class: 'pct' }, `${b.percent.toFixed(1)}%`),
        el('p', { class: 'band-note' }, el('span', { class: 'what' }, x.what), ' ', statusChip(x.status), ' ', x.meaning));
    }));

    drawHealthCharts();
  }

  const STATUS_LABEL = { good: 'Good', warn: 'Check', bad: 'Problem', neutral: 'Info' };
  const statusChip = (status) => el('span', { class: `chip ${status}` }, STATUS_LABEL[status]);

  /** A measurement card: value, what it is, and what it means for this file. */
  function explained(label, value, x) {
    return el('div', { class: `metric status-${x.status}` },
      el('div', { class: 'metric-top' }, el('div', { class: 'k' }, label), statusChip(x.status)),
      el('div', { class: 'v' }, value),
      el('p', { class: 'meaning' }, x.meaning),
      el('p', { class: 'what' }, x.what));
  }

  /** Min/max per column plus a clipping flag, computed once per file. */
  function envelope(channels, cols, report) {
    const n = channels[0].length;
    const min = new Float32Array(cols), max = new Float32Array(cols), clip = new Uint8Array(cols);
    const peak = Math.pow(10, report.levels.peakDb / 20);
    const thr = report.levels.clipEvents ? peak * 0.9999 : Infinity;
    for (let c = 0; c < cols; c++) {
      const a = Math.floor((c * n) / cols), b = Math.max(a + 1, Math.floor(((c + 1) * n) / cols));
      let lo = 0, hi = 0;
      for (const ch of channels) for (let i = a; i < b && i < n; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        if (Math.abs(v) >= thr) clip[c] = 1;
      }
      min[c] = lo; max[c] = hi;
    }
    return { min, max, clip, cols };
  }

  // -------------------------------------------------------------- charts ---

  function prepCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = Number(canvas.getAttribute('height'));
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';
    return { ctx, w, h };
  }

  const PAD = { l: 44, r: 10, t: 8, b: 22 };
  const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000];
  const freqLabel = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

  function drawWave() {
    const { ctx, w, h } = prepCanvas($('wave'));
    const e = state.envelope;
    const plotW = w - PAD.l - PAD.r, mid = PAD.t + (h - PAD.t - PAD.b) / 2, amp = (h - PAD.t - PAD.b) / 2;
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.l, mid); ctx.lineTo(w - PAD.r, mid); ctx.stroke();
    ctx.fillStyle = css('--muted'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText('+1', PAD.l - 6, PAD.t + 4); ctx.fillText('0', PAD.l - 6, mid); ctx.fillText('-1', PAD.l - 6, h - PAD.b - 4);
    const color = css('--s1'), clipColor = css('--critical');
    for (let x = 0; x < plotW; x++) {
      const a = Math.floor((x / plotW) * e.cols), b = Math.max(a + 1, Math.floor(((x + 1) / plotW) * e.cols));
      let lo = 0, hi = 0, clip = 0;
      for (let c = a; c < b && c < e.cols; c++) { lo = Math.min(lo, e.min[c]); hi = Math.max(hi, e.max[c]); clip |= e.clip[c]; }
      ctx.fillStyle = color;
      ctx.fillRect(PAD.l + x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
      if (clip) { ctx.fillStyle = clipColor; ctx.fillRect(PAD.l + x, PAD.t, 1, 4); ctx.fillRect(PAD.l + x, h - PAD.b - 4, 1, 4); }
    }
    timeAxis(ctx, w, h, state.report.info.duration);
  }

  function timeAxis(ctx, w, h, duration) {
    const plotW = w - PAD.l - PAD.r;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600];
    const step = steps.find((s) => (duration / s) <= Math.max(2, Math.floor(plotW / 80))) || 3600;
    ctx.fillStyle = css('--muted'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let t = 0; t <= duration; t += step) ctx.fillText(fmtDur(t), PAD.l + (t / duration) * plotW, h - PAD.b + 6);
  }

  /** Log-frequency spectrum chart with one or more series. Returns a hover handler. */
  function drawSpectra(canvas, series, hoverX = null) {
    const { ctx, w, h } = prepCanvas(canvas);
    const nyq = series[0].sampleRate / 2;
    const fMin = 20, fMax = Math.min(nyq, 48000);
    const plotW = w - PAD.l - PAD.r, plotH = h - PAD.t - PAD.b;
    const xOf = (f) => PAD.l + (Math.log(f / fMin) / Math.log(fMax / fMin)) * plotW;
    const fOf = (x) => fMin * Math.pow(fMax / fMin, (x - PAD.l) / plotW);
    let top = -Infinity;
    for (const s of series) for (let k = 1; k < s.dB.length; k++) if (k * s.binHz >= fMin) top = Math.max(top, s.dB[k]);
    top = Math.min(10, Math.ceil(top / 10) * 10 + 10);
    const bottom = top - 110;
    const yOf = (d) => PAD.t + ((top - Math.max(bottom, Math.min(top, d))) / (top - bottom)) * plotH;

    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1; ctx.fillStyle = css('--muted');
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let d = top; d >= bottom; d -= 20) {
      ctx.beginPath(); ctx.moveTo(PAD.l, yOf(d)); ctx.lineTo(w - PAD.r, yOf(d)); ctx.stroke();
      ctx.fillText(`${d}`, PAD.l - 6, yOf(d));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const f of FREQ_TICKS) if (f >= fMin && f <= fMax) {
      ctx.beginPath(); ctx.moveTo(xOf(f), PAD.t); ctx.lineTo(xOf(f), h - PAD.b); ctx.stroke();
      ctx.fillText(freqLabel(f), xOf(f), h - PAD.b + 6);
    }
    ctx.save(); ctx.translate(10, PAD.t + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('dB', 0, 0); ctx.restore();

    // One point per pixel: average power of the bins that fall in it.
    const curves = series.map((s) => {
      const pts = [];
      for (let x = 0; x < plotW; x++) {
        const k0 = Math.max(1, Math.floor(fOf(PAD.l + x) / s.binHz)), k1 = Math.max(k0 + 1, Math.floor(fOf(PAD.l + x + 1) / s.binHz));
        let p = 0, n = 0;
        for (let k = k0; k < k1 && k < s.dB.length; k++) { p += Math.pow(10, s.dB[k] / 10); n++; }
        pts.push(n ? 10 * Math.log10(Math.max(p / n, 1e-20)) : null);
      }
      return pts;
    });
    ctx.lineWidth = 2; ctx.lineJoin = 'round';
    series.forEach((s, i) => {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      let started = false;
      curves[i].forEach((d, x) => {
        if (d === null) return;
        if (!started) { ctx.moveTo(PAD.l + x, yOf(d)); started = true; } else ctx.lineTo(PAD.l + x, yOf(d));
      });
      ctx.stroke();
    });

    if (hoverX !== null && hoverX >= PAD.l && hoverX < w - PAD.r) {
      const x = Math.floor(hoverX - PAD.l);
      ctx.strokeStyle = css('--text-2'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hoverX, PAD.t); ctx.lineTo(hoverX, h - PAD.b); ctx.stroke();
      series.forEach((s, i) => {
        const d = curves[i][x];
        if (d === null) return;
        ctx.fillStyle = css('--surface'); ctx.beginPath(); ctx.arc(hoverX, yOf(d), 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(hoverX, yOf(d), 4, 0, Math.PI * 2); ctx.fill();
      });
      return { f: fOf(hoverX), values: series.map((s, i) => ({ name: s.name, dB: curves[i][x] })) };
    }
    return null;
  }

  function hoverable(canvas, readout, draw) {
    const update = (x) => {
      const hit = draw(x);
      readout.textContent = hit
        ? `${fmtHz(hit.f)}  ·  ${hit.values.map((v) => `${v.name ? v.name + ' ' : ''}${fmt(v.dB, 1, ' dB')}`).join('  ·  ')}`
        : 'Hover for values';
    };
    canvas.onpointermove = (e) => update(e.clientX - canvas.getBoundingClientRect().left);
    canvas.onpointerleave = () => update(null);
  }

  function rampColors() {
    // Sequential single-hue ramp (blue), from the surface to full intensity.
    const light = ['#fcfcfb', '#cde2fb', '#6da7ec', '#256abf', '#0d366b'];
    const dark = ['#1a1a19', '#104281', '#2a78d6', '#86b6ef', '#cde2fb'];
    const stops = (isDark() ? dark : light).map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (stops.length - 1), a = Math.floor(t), b = Math.min(stops.length - 1, a + 1), u = t - a;
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[a][c] + (stops[b][c] - stops[a][c]) * u;
    }
    return lut;
  }

  function drawSpectrogram() {
    const canvas = $('spectrogram');
    const { ctx, w, h } = prepCanvas(canvas);
    const sg = state.sgram;
    const nyq = state.sampleRate / 2, fMin = 20, fMax = Math.min(nyq, 48000);
    const plotW = w - PAD.l - PAD.r, plotH = h - PAD.t - PAD.b;
    const rows = Math.round(plotH * (window.devicePixelRatio || 1));
    let max = -Infinity;
    for (let i = 0; i < sg.data.length; i++) if (sg.data[i] > max) max = sg.data[i];
    const range = 90, lut = rampColors();
    const off = document.createElement('canvas');
    off.width = sg.columns; off.height = rows;
    const octx = off.getContext('2d');
    const img = octx.createImageData(sg.columns, rows);
    const binOfRow = new Int32Array(rows);
    for (let r = 0; r < rows; r++) binOfRow[r] = Math.min(sg.bins - 1, Math.round((fMin * Math.pow(fMax / fMin, 1 - r / (rows - 1))) / sg.binHz));
    for (let c = 0; c < sg.columns; c++) for (let r = 0; r < rows; r++) {
      const v = sg.data[c * sg.bins + binOfRow[r]];
      const i = Math.max(0, Math.min(255, Math.round(((v - (max - range)) / range) * 255)));
      const o = (r * sg.columns + c) * 4;
      img.data[o] = lut[i * 3]; img.data[o + 1] = lut[i * 3 + 1]; img.data[o + 2] = lut[i * 3 + 2]; img.data[o + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, PAD.l, PAD.t, plotW, plotH);
    const yOf = (f) => PAD.t + (1 - Math.log(f / fMin) / Math.log(fMax / fMin)) * plotH;
    ctx.fillStyle = css('--muted'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const f of [50, 200, 1000, 5000, 20000]) if (f <= fMax) ctx.fillText(freqLabel(f), PAD.l - 6, yOf(f));
    timeAxis(ctx, w, h, state.report.info.duration);
  }

  function drawHealthCharts() {
    if (!state.report) return;
    if (state.envelope) drawWave();
    const spec = state.report.spectrum;
    const s = [{ dB: spec.dB, binHz: spec.binHz, sampleRate: spec.sampleRate, color: css('--s1'), name: '' }];
    drawSpectra($('spectrum'), s);
    hoverable($('spectrum'), $('spec-readout'), (x) => drawSpectra($('spectrum'), s, x));
    if (state.sgram) drawSpectrogram();
  }

  // -------------------------------------------------------------- layers ---

  const LAYER_COLOR = { harmonic: '--s1', percussive: '--s2', residual: '--s3', mid: '--s4', side: '--s5' };

  function resetLayers() {
    $('layers-out').hidden = true;
    $('run-layers').disabled = false;
    $('run-layers').textContent = 'Dissect layers';
  }

  async function runLayers() {
    const btn = $('run-layers');
    btn.disabled = true;
    showError('');
    try {
      setStatus('Separating layers…', 0);
      await tick();
      const res = await AL.dissect(state.channels, state.sampleRate, { onProgress: (p) => setStatus('Separating layers…', p) });
      state.layers = res.layers;
      state.tones = res.tones;
      setStatus('');
      renderLayers();
      btn.textContent = 'Layers ready';
      saveHistory();
    } catch (e) {
      console.error(e);
      setStatus('');
      showError(`Layer separation failed: ${e.message}`);
      btn.disabled = false;
    }
  }

  function renderLayers() {
    $('layers-out').hidden = false;
    const tones = state.tones;
    $('tones').replaceChildren(tones.length
      ? el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Frequency'), el('th', {}, 'Level'), el('th', {}, 'Present'), el('th', {}, 'Likely source'), el('th', {}, 'What it means'))),
        el('tbody', {}, tones.map((t) => {
          const x = AE.tone(t);
          return el('tr', {},
            el('td', { class: 'num' }, t.frequency >= 1000 ? `${(t.frequency / 1000).toFixed(3)} kHz` : `${t.frequency.toFixed(1)} Hz`),
            el('td', { class: 'num' }, `${t.level.toFixed(1)} dBFS`),
            el('td', { class: 'num' }, `${Math.round(t.presence * 100)} %`),
            el('td', { class: 'wrap' }, el('b', {}, t.label), el('div', { class: 'muted small' }, x.what)),
            el('td', { class: 'wrap' }, x.meaning));
        }))))
      : el('p', { class: 'muted' }, 'No steady tones found. Nothing seems to have been added at a fixed frequency.'));

    const series = state.layers.map((l) => ({
      dB: l.spectrum.dB, binHz: l.spectrum.binHz, sampleRate: l.spectrum.sampleRate, color: css(LAYER_COLOR[l.id]), name: l.name.split(' ')[0],
    }));
    $('layer-legend').replaceChildren(...state.layers.map((l) => el('span', { style: `--c: var(${LAYER_COLOR[l.id]})` }, l.name)));
    const canvas = $('layer-spectrum');
    drawSpectra(canvas, series);
    hoverable(canvas, $('layer-readout'), (x) => drawSpectra(canvas, series, x));

    $('layer-cards').replaceChildren(...state.layers.map((l) => {
      const top = [...l.bands].sort((a, b) => b.percent - a.percent).slice(0, 2).filter((b) => b.percent >= 5);
      const x = AE.layer(l);
      let actions;
      if (l.signal) {
        const playBtn = el('button', { class: 'btn small' }, '▶ Play');
        playBtn.onclick = () => play([l.signal], 0, playBtn);
        const dl = el('button', { class: 'btn ghost small' }, 'Download WAV');
        dl.onclick = () => download(`${state.file.name.replace(/\.[^.]+$/, '')}-${l.id}.wav`, encodeWav([l.signal], state.sampleRate));
        actions = el('div', { class: 'player' }, playBtn, dl);
      } else {
        actions = el('p', { class: 'muted small' }, 'Audio isn\'t stored in history. Open the file again to play this layer.');
      }
      return el('article', { class: 'layer', style: `--c: var(${LAYER_COLOR[l.id]})` },
        el('h4', {}, l.name),
        el('p', { class: 'hint' }, l.hint),
        el('p', { class: 'meaning' }, statusChip(x.status), ' ', x.meaning),
        el('dl', {},
          el('dt', {}, 'Share of energy'), el('dd', {}, `${l.sharePercent.toFixed(1)} %`),
          el('dt', {}, 'Level'), el('dd', {}, fmt(l.levelDb, 1, ' dBFS')),
          el('dt', {}, 'Main range'), el('dd', {}, `${fmtHz(l.rangeHz[0])} – ${fmtHz(l.rangeHz[1])}`),
          el('dt', {}, 'Strongest at'), el('dd', {}, fmtHz(l.dominantHz)),
          el('dt', {}, 'Brightness centre'), el('dd', {}, fmtHz(l.centroidHz)),
          el('dt', {}, 'Mostly'), el('dd', {}, top.map((b) => `${b.name} ${b.percent.toFixed(0)}%`).join(', ') || '—')),
        actions);
    }));
  }

  // ---------------------------------------------------------- transcript ---

  function resetTranscript() {
    $('transcript-out').hidden = true;
    $('run-asr').disabled = false;
    const stereo = state.channels && state.channels.length >= 2;
    $('asr-source').querySelector('option[value="mid"]').disabled = !stereo;
    if (!stereo) $('asr-source').value = 'mix';
  }

  async function runTranscript() {
    const btn = $('run-asr');
    btn.disabled = true;
    showError('');
    try {
      const source = $('asr-source').value;
      const signal = source === 'mid' && state.channels.length >= 2 ? AL.midSide(state.channels).mid : AH.mixToMono(state.channels);
      const result = await AT.transcribe(signal, state.sampleRate, {
        model: $('asr-model').value,
        language: $('asr-lang').value,
        onStatus: (text, f) => setStatus(text, f),
      });
      state.transcript = result;
      setStatus('');
      renderTranscript();
      saveHistory();
    } catch (e) {
      console.error(e);
      setStatus('');
      showError(`Transcription failed: ${e.message.replace(/\.$/, '')}. The speech model downloads from the internet the first time, so check your connection.`);
    } finally {
      btn.disabled = false;
    }
  }

  function renderTranscript() {
    $('transcript-out').hidden = false;
    const chunks = (state.transcript.chunks || []).filter((c) => c.text.trim());
    const list = $('segments');
    if (!chunks.length) {
      list.replaceChildren(el('li', {}, el('time', {}, ''), el('span', { class: 'muted' }, 'No speech detected.')));
      return;
    }
    list.replaceChildren(...chunks.map((c) => el('li', {
      title: state.channels ? 'Play from here' : '',
      onclick: () => state.channels && play(state.channels, c.timestamp[0] || 0, $('play-all'), false),
    }, el('time', {}, `${AT.fmtTime(c.timestamp[0])} – ${AT.fmtTime(c.timestamp[1] ?? state.report.info.duration)}`), el('span', {}, c.text.trim()))));
  }

  const transcriptText = () => (state.transcript.chunks || []).map((c) => `[${AT.fmtTime(c.timestamp[0])}] ${c.text.trim()}`).join('\n');

  // ------------------------------------------------------------- history ---

  async function saveHistory() {
    if (state.saved || !HI.enabled()) return;
    try {
      await HI.save(state);
      renderHistory();
    } catch (e) {
      console.warn('History not saved:', e);
    }
  }

  const SEC_CHIP = { clean: ['good', 'Safe'], suspicious: ['warn', 'Suspicious'], danger: ['bad', 'Dangerous'] };

  async function renderHistory() {
    $('history-toggle').checked = HI.enabled();
    let items = [];
    try { items = await HI.list(); } catch (e) { console.warn(e); }
    $('history-clear').hidden = !items.length;
    const list = $('history-list');
    if (!items.length) {
      list.replaceChildren(el('li', { class: 'muted small empty' }, HI.enabled()
        ? 'Nothing yet. Every file you check is saved here (results only, not the audio) so you can come back to it.'
        : 'History is off. Turn it on to keep results of the files you check.'));
      return;
    }
    list.replaceChildren(...items.map((h) => {
      const sec = SEC_CHIP[h.security];
      const meta = [
        new Date(h.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
        h.duration !== null ? fmtDur(h.duration) : h.detected,
        fmtSize(h.size),
      ].filter(Boolean).join(' · ');
      const del = el('button', { class: 'icon-btn', title: `Remove ${h.name} from history`, 'aria-label': `Remove ${h.name} from history` }, '✕');
      del.onclick = async (e) => { e.stopPropagation(); await HI.remove(h.id); renderHistory(); };
      return el('li', { class: state.saved && state.saved.id === h.id ? 'current' : '' },
        el('button', { class: 'history-open', onclick: () => openSaved(h.id) },
          el('span', { class: 'history-name' }, h.name),
          el('span', { class: 'history-meta' }, meta),
          el('span', { class: 'history-chips' },
            h.score !== null ? el('span', { class: `chip ${h.score >= 90 ? 'good' : h.score >= 40 ? 'warn' : 'bad'}` }, `Health ${h.score}`) : null,
            sec ? el('span', { class: `chip ${sec[0]}` }, sec[1]) : null,
            h.hasLayers ? el('span', { class: 'chip neutral' }, 'Layers') : null,
            h.hasTranscript ? el('span', { class: 'chip neutral' }, 'Transcript') : null)),
        del);
    }));
  }

  async function openSaved(id) {
    stop();
    showError('');
    let rec;
    try { rec = await HI.load(id); } catch (e) { showError(`Could not open saved result: ${e.message}`); return; }
    if (!rec) { showError('That saved result no longer exists.'); renderHistory(); return; }
    Object.assign(state, {
      file: { name: rec.summary.name, size: rec.summary.size }, saved: rec.summary,
      scan: rec.scan, report: rec.report, format: rec.format || {}, resampled: rec.resampled,
      envelope: rec.envelope, sgram: rec.sgram, layers: rec.layers, tones: rec.tones, transcript: rec.transcript,
      channels: null, sampleRate: rec.report ? rec.report.info.sampleRate : 0,
    });
    const when = new Date(rec.summary.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    $('saved-banner').textContent = `Saved result from ${when}. The audio isn't stored, so playback, layer separation and transcription need the file. Drop it again to use them.`;
    $('saved-banner').hidden = false;
    if (state.scan) renderSecurity(); else $('safety').hidden = true;
    if (!rec.report) {
      securityOnly('');
    } else {
      renderHeader();
      renderHealth();
      if (state.layers) { renderLayers(); $('run-layers').textContent = 'Saved layers'; } else { resetLayers(); $('run-layers').textContent = 'Needs the audio file'; }
      $('run-layers').disabled = true;
      resetTranscript();
      if (state.transcript) renderTranscript();
      $('run-asr').disabled = true;
      showTabs(true);
      $('results').hidden = false;
      selectTab('health');
    }
    renderHistory();
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // -------------------------------------------------------------- export ---

  function exportReport() {
    const { spectrum, loudness = {}, ...rest } = state.report || {};
    const { shortTermCurve, ...loud } = loudness;
    const out = {
      file: state.file.name,
      generated: new Date().toISOString(),
      security: state.scan,
      ...rest,
      loudness: state.report ? loud : undefined,
      layers: state.layers && state.layers.map(({ signal, spectrum: s, ...l }) => l),
      steadyTones: state.tones,
      transcript: state.transcript && { text: state.transcript.text, segments: state.transcript.chunks },
    };
    download(`${state.file.name.replace(/\.[^.]+$/, '')}-report.json`, JSON.stringify(out, null, 2), 'application/json');
  }

  // ---------------------------------------------------------------- tabs ---

  function selectTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    redraw();
  }

  function redraw() {
    const tab = document.querySelector('.tabs [aria-selected="true"]').dataset.tab;
    if (tab === 'health') drawHealthCharts();
    if (tab === 'layers' && state.layers) renderLayers();
  }

  // --------------------------------------------------------------- wire up ---

  const drop = $('drop');
  $('file').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer.files[0]) return loadFile(e.dataTransfer.files[0]);
    const link = driveLinkFrom(e.dataTransfer);
    if (link) loadFromDrive((p) => GD.fromLink(link, p));
    else showError('That drop did not contain a file. Drag the file itself, or paste a Google Drive link below.');
  });
  $('gdrive').addEventListener('click', () => loadFromDrive((p) => GD.fromPicker(p)));
  $('link-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('link').value.trim();
    if (v) loadFromDrive((p) => GD.fromLink(v, p));
  });
  document.addEventListener('paste', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.clipboardData.files[0]) return loadFile(e.clipboardData.files[0]);
    const link = driveLinkFrom(e.clipboardData);
    if (link) { $('link').value = link; loadFromDrive((p) => GD.fromLink(link, p)); }
  });
  $('sec-copy').addEventListener('click', () => navigator.clipboard.writeText(state.scan.sha256));
  $('history-toggle').addEventListener('change', (e) => { HI.setEnabled(e.target.checked); renderHistory(); });
  $('history-clear').addEventListener('click', async () => {
    if (!confirm('Remove all saved results from this browser?')) return;
    await HI.clear();
    renderHistory();
  });
  renderHistory();
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  $('play-all').addEventListener('click', (e) => play(state.channels, 0, e.currentTarget));
  $('export').addEventListener('click', exportReport);
  $('run-layers').addEventListener('click', runLayers);
  $('run-asr').addEventListener('click', runTranscript);
  $('copy-txt').addEventListener('click', () => navigator.clipboard.writeText(transcriptText()));
  $('dl-txt').addEventListener('click', () => download(`${state.file.name.replace(/\.[^.]+$/, '')}-transcript.txt`, transcriptText(), 'text/plain'));
  $('dl-srt').addEventListener('click', () => download(`${state.file.name.replace(/\.[^.]+$/, '')}.srt`, AT.toSrt(state.transcript.chunks || [], state.report.info.duration), 'text/plain'));

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state.report && redraw(), 150); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.report && redraw());
})();
