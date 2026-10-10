# CheckAudio

A browser app that scans an audio file for threats, checks its health, dissects it into layers and frequencies, and transcribes the speech in it. Files can come from your computer or from Google Drive. All processing happens on your own computer, and the file is never uploaded anywhere.

## Run it

Use any static web server from this folder:

```sh
npm start            # python3 -m http.server 8000, then open http://localhost:8000
```

Opening `index.html` directly also works. Drop in a WAV, FLAC, MP3, OGG/Opus or M4A file, click **Google Drive**, or paste or drop a Drive link.

## What it does

### Security scan
Runs first on every file. Audio data can't run on its own, so malware that travels as "audio" depends on tricks. The scan looks for each of them:

| Check | What it finds |
|---|---|
| Real file type | What the bytes actually are, whatever the name says. A program renamed to `.mp3` is caught |
| Dangerous names | Double extensions (`song.mp3.exe`), program extensions, hidden right-to-left characters that disguise the real extension |
| Embedded programs | Windows (PE) or Linux (ELF) executables hidden anywhere in the file |
| Hidden archives | ZIP/RAR archives tucked inside the audio |
| Appended payloads | Data attached after the end of the audio, where players never look |
| Malformed headers | Chunk or tag sizes that lie, which is the classic way of attacking media players |
| Script text | PowerShell, `<script>`, `cmd.exe`, encoded loaders and similar |
| Links | URLs in the tags, listed so you can judge them |

You get a verdict (no threats found, suspicious, or dangerous) and the file's **SHA-256 fingerprint**, with a one-click **VirusTotal** lookup that checks it against 70+ antivirus engines. Only the fingerprint is sent, never the file. Dangerous files are not decoded at all.

This targets the ways malware hides in media files. It is not a full antivirus program.

### 1. Health check
A score out of 100, a list of findings in plain language, and the measurements behind them.

| Check | What it finds |
|---|---|
| Clipping | Waveform tops flattened at the peak level, even when the file was turned down afterwards |
| Headroom / level | Peaks at 0 dBFS (risky for encoding), or a recording that is far too quiet |
| Loudness | Integrated loudness (LUFS), loudness range (LU) and max short-term level (ITU-R BS.1770 / EBU R128). Flags over-loud or over-compressed masters |
| Dropouts | Short gaps of pure digital silence inside the audio |
| Noise floor | Pauses that don't get quiet (hiss, room noise) |
| Mains hum | 50/60 Hz hum and its harmonics |
| Added steady tones | Fixed-frequency tones that run through the whole file: whine, test tones, carriers, watermarks |
| Bandwidth | Where the real content stops. A sharp cliff means a lossy source (for example an MP3 converted to WAV), and empty high frequencies in a 96 kHz file mean it was upsampled |
| Stereo | Phase problems (cancels in mono), a silent channel, left/right imbalance, fake stereo |
| DC offset, subsonic rumble | Wasted headroom below 20 Hz |
| Bit depth | 16-bit audio padded into a 24-bit file |

Charts: waveform with clipping marks, frequency spectrum, spectrogram, and energy per band (sub-bass up to brilliance).

### 2. Layers & frequencies
Splits the audio into layers you can **play on their own and download as WAV**:

- **Tonal / harmonic**: sustained pitched sound (voice, chords, bass notes)
- **Percussive / transients**: drums, plucks, consonants, clicks
- **Noise / residual**: hiss, breath, room tone, reverb tails
- **Centre** and **Sides** (stereo files): vocals usually sit in the centre, wide instruments and reverb in the sides

For each layer it reports the share of total energy, level, the main frequency range, the strongest frequency, the brightness centre, and which bands it mostly occupies. It also overlays all the layer spectra on one chart, and lists the **steady tones** that look added to the recording.

The separation uses signal processing (median-filter harmonic/percussive separation and mid/side decoding), not AI. The tonal, percussive and noise layers always add back up exactly to the original, but the split is rough. For true vocal, drum and bass stems you need an AI separator such as [Demucs](https://github.com/adefossez/demucs).

### 3. Transcript
Speech-to-text with OpenAI's Whisper model, run in the browser through [transformers.js](https://github.com/huggingface/transformers.js) (WebGPU when available, otherwise WebAssembly). Pick the tiny, base or small model, set the language or let it auto-detect, and choose the source: the full mix, or the centre channel, which is better for vocals over music. Each line has a timestamp, and clicking it plays from that point. You can copy the text or download it as .txt or .srt subtitles.

The model downloads from the internet the first time (about 40 to 250 MB), and the browser caches it after that.

### Export
**Export report** saves everything (security scan, findings, measurements, layers, tones, transcript) as JSON.

## Google Drive setup

To open files straight from Drive, the app needs a free Google Cloud project. This takes about 10 minutes, once.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library**: enable the **Google Drive API** and the **Google Picker API**.
3. **APIs & Services → OAuth consent screen**: choose *External*, fill in the app name and your email, and add yourself under **Test users**.
4. **APIs & Services → Credentials**:
   - **Create credentials → API key.** Under *Application restrictions* choose *Websites* and add your site's address (for example `http://localhost:8000/*`).
   - **Create credentials → OAuth client ID → Web application.** Under *Authorised JavaScript origins* add the same address without the path (for example `http://localhost:8000`).
5. Copy the API key, the client ID and the **project number** (on the Cloud console home page) into `config.js`.

How it behaves:
- **Google Drive button:** sign in with Google, pick a file, and it downloads straight into the browser.
- **Pasted or dropped Drive link:** files shared as *Anyone with the link* load without sign-in. For private files the picker opens so you can grant access to that one file.
- The app only asks for access to files you pick (the `drive.file` scope). It never sees the rest of your Drive.

Without this setup, you can still use files synced by **Google Drive for desktop**: drag them in from your Drive folder like any other file.

## Project layout

| File | Purpose |
|---|---|
| `scan.js` | Security scan: real-type detection, embedded payloads, malformed headers, SHA-256 |
| `gdrive.js`, `config.js` | Google Drive import (Picker, sign-in, link download) and its settings |
| `analysis.js` | Health-check engine: FFT, loudness, clipping, hum, tones, bandwidth, format sniffing. Pure functions, works in Node and the browser |
| `layers.js` | Layer separation (HPSS, mid/side) and per-layer frequency profiles |
| `transcribe.js` | Whisper transcription in a Web Worker |
| `app.js`, `index.html`, `style.css` | User interface |
| `test/` | Unit tests (`npm test`, Node 18+) |

## Notes and limits

- Levels are **sample peak**, not true peak (no oversampling).
- The browser decoder sets the sample rate for formats whose header the app can't read (for example M4A). The header line shows a note when this happens.
- Whisper can invent words over music with no speech in it. Use the centre-channel source, or trust only the timestamps where speech exists.
- Very long files (over about 30 minutes) take longer to process and use a lot of memory, because everything runs in the browser.
