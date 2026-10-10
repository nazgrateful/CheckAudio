/*
 * CheckAudio Google Drive import.
 *
 * Two ways in:
 *  - "Google Drive" button: Google sign-in + the Google Picker, then the file
 *    is downloaded straight into the browser with the Drive API.
 *  - Drop or paste a Drive link: the file ID is pulled out of the link and
 *    downloaded (public "anyone with the link" files work without sign-in;
 *    private ones fall back to the Picker).
 *
 * Needs a Google Cloud API key and OAuth client ID in config.js (see README).
 */
(function (root) {
  'use strict';

  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const AUDIO_MIMES = [
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/x-flac', 'audio/ogg',
    'audio/opus', 'audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/aiff', 'audio/x-aiff', 'audio/webm', 'video/mp4', 'application/octet-stream',
  ].join(',');

  const cfg = () => root.CHECKAUDIO_CONFIG || {};
  const configured = () => Boolean(cfg().googleApiKey && cfg().googleClientId);

  const scripts = new Map();
  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => { scripts.delete(src); reject(new Error('Could not reach Google. Check your internet connection.')); };
        document.head.append(s);
      }));
    }
    return scripts.get(src);
  }

  /** Pull a Drive file ID out of a share link, an "open?id=" link, or a bare ID. */
  function extractId(text) {
    if (!text) return null;
    const t = String(text).trim();
    const patterns = [
      /drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})/,
      /drive\.google\.com\/(?:open|uc)\?(?:[^#]*&)?id=([A-Za-z0-9_-]{20,})/,
      /docs\.google\.com\/[^?#]*\/d\/([A-Za-z0-9_-]{20,})/,
      /drive\.usercontent\.google\.com\/[^?#]*\?(?:[^#]*&)?id=([A-Za-z0-9_-]{20,})/,
    ];
    for (const p of patterns) {
      const m = t.match(p);
      if (m) return m[1];
    }
    return /^[A-Za-z0-9_-]{25,}$/.test(t) ? t : null;
  }

  let token = null, tokenExpiry = 0;
  async function signIn() {
    if (token && Date.now() < tokenExpiry) return token;
    await loadScript('https://accounts.google.com/gsi/client');
    return new Promise((resolve, reject) => {
      const client = root.google.accounts.oauth2.initTokenClient({
        client_id: cfg().googleClientId,
        scope: SCOPE,
        callback: (r) => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          token = r.access_token;
          tokenExpiry = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
          resolve(token);
        },
        error_callback: (e) => reject(new Error(e && e.type === 'popup_closed' ? 'Google sign-in was closed.' : 'Google sign-in failed or was blocked by a pop-up blocker.')),
      });
      client.requestAccessToken();
    });
  }

  async function pick() {
    const accessToken = await signIn();
    await loadScript('https://apis.google.com/js/api.js');
    await new Promise((resolve) => root.gapi.load('picker', resolve));
    const P = root.google.picker;
    return new Promise((resolve) => {
      const view = new P.DocsView(P.ViewId.DOCS).setMimeTypes(AUDIO_MIMES).setIncludeFolders(true).setSelectFolderEnabled(false);
      const builder = new P.PickerBuilder()
        .addView(view)
        .addView(new P.DocsView(P.ViewId.DOCS).setMimeTypes(AUDIO_MIMES).setOwnedByMe(false).setLabel('Shared with me'))
        .setOAuthToken(accessToken)
        .setDeveloperKey(cfg().googleApiKey)
        .setTitle('Choose an audio file')
        .setCallback((d) => {
          if (d.action === P.Action.PICKED) resolve(d.docs[0]);
          else if (d.action === P.Action.CANCEL) resolve(null);
        });
      if (cfg().googleAppId) builder.setAppId(cfg().googleAppId);
      builder.build().setVisible(true);
    });
  }

  async function api(path, withToken) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://www.googleapis.com/drive/v3/${path}${sep}supportsAllDrives=true${withToken ? '' : `&key=${encodeURIComponent(cfg().googleApiKey)}`}`;
    return fetch(url, withToken ? { headers: { Authorization: `Bearer ${token}` } } : {});
  }

  async function readWithProgress(res, total, onProgress) {
    if (!res.body || !total) return res.blob();
    const reader = res.body.getReader();
    const parts = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      onProgress && onProgress(loaded, total);
    }
    return new Blob(parts);
  }

  /** Download a Drive file as a File. Tries without sign-in first if we have no token. */
  async function download(id, onProgress, known = {}) {
    let withToken = Boolean(token && Date.now() < tokenExpiry);
    let meta = await api(`files/${encodeURIComponent(id)}?fields=name,mimeType,size`, withToken);
    if (!meta.ok && !withToken) {
      const err = new Error('private');
      err.code = meta.status;
      throw err;
    }
    if (!meta.ok) throw new Error(meta.status === 404 ? 'File not found, or this app has no access to it.' : `Google Drive error ${meta.status}.`);
    const info = { ...known, ...(await meta.json()) };
    if (info.mimeType && info.mimeType.startsWith('application/vnd.google-apps')) {
      throw new Error('That is a Google Docs/Sheets file, not an audio file.');
    }
    const res = await api(`files/${encodeURIComponent(id)}?alt=media`, withToken);
    if (!res.ok) throw new Error(res.status === 403 ? 'Google Drive refused the download (the file may be too large, or downloads are disabled by its owner).' : `Google Drive download failed (${res.status}).`);
    const blob = await readWithProgress(res, Number(info.size || res.headers.get('content-length') || 0), onProgress);
    return new File([blob], info.name || `drive-${id}`, { type: info.mimeType || blob.type || '' });
  }

  /** Pick a file with the Google Picker and download it. Resolves null if cancelled. */
  async function fromPicker(onProgress) {
    if (!configured()) throw notConfigured();
    const doc = await pick();
    if (!doc) return null;
    return download(doc.id, onProgress, { name: doc.name, mimeType: doc.mimeType, size: doc.sizeBytes });
  }

  /** Download from a pasted/dropped link. Private files open the Picker so the user can grant access. */
  async function fromLink(text, onProgress) {
    if (!configured()) throw notConfigured();
    const id = extractId(text);
    if (!id) throw new Error('That does not look like a Google Drive file link.');
    try {
      return await download(id, onProgress);
    } catch (e) {
      if (e.message !== 'private') throw e;
      // Not public: the drive.file scope only covers files picked in the Picker, so ask the user to pick it.
      return fromPicker(onProgress);
    }
  }

  function notConfigured() {
    const e = new Error('Google Drive isn\'t set up yet. Add your Google API key and OAuth client ID to config.js (steps in the README). You can also download the file from Drive and drop it here, or use Google Drive for desktop and drag the file from your Drive folder.');
    e.code = 'not-configured';
    return e;
  }

  root.GDrive = { configured, extractId, fromPicker, fromLink };
})(typeof self !== 'undefined' ? self : this);
