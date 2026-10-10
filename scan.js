/*
 * CheckAudio security scan.
 *
 * Audio data itself can't run. Malware that travels as "audio" works by:
 *  - being a program with an audio-looking name (song.mp3.exe, or a renamed .exe)
 *  - hiding a program, script or archive inside or after the audio data
 *  - malformed headers built to exploit bugs in media players
 *  - scripts or links stashed in metadata tags
 * This module checks for those, and computes a SHA-256 fingerprint that can be
 * looked up on VirusTotal (70+ antivirus engines) without uploading the file.
 *
 * Works in the browser (window.AudioScan) and in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AudioScan = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const AUDIO_EXT = ['wav', 'wave', 'flac', 'mp3', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'aac', 'aif', 'aiff', 'aifc', 'webm', 'weba', 'wma', 'caf', 'mka'];
  const DANGEROUS_EXT = {
    exe: 'Windows program', scr: 'Windows screensaver (a program)', com: 'DOS program', pif: 'Windows program shortcut',
    msi: 'Windows installer', dll: 'Windows library', cpl: 'Control Panel program', bat: 'Windows batch script',
    cmd: 'Windows command script', vbs: 'VBScript', vbe: 'encoded VBScript', js: 'JavaScript file', jse: 'encoded JScript',
    wsf: 'Windows Script file', wsh: 'Windows Script settings', ps1: 'PowerShell script', hta: 'HTML application',
    jar: 'Java program', lnk: 'Windows shortcut', apk: 'Android app', app: 'macOS app', dmg: 'macOS disk image',
    pkg: 'macOS installer', command: 'macOS shell script', sh: 'shell script', reg: 'Windows registry file',
    iso: 'disk image', img: 'disk image', vhd: 'virtual disk', docm: 'Word file with macros', xlsm: 'Excel file with macros',
  };

  const u16le = (u8, o) => u8[o] | (u8[o + 1] << 8);
  const u32le = (u8, o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  const u32be = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const ascii = (u8, o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  const startsWith = (u8, bytes, o = 0) => bytes.every((b, i) => u8[o + i] === b);
  const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  /** What the bytes really are, regardless of the file name. */
  function identify(u8) {
    if (u8.length < 4) return { kind: 'unknown', name: 'Empty or tiny file' };
    const s4 = ascii(u8, 0, 4);
    if (s4 === 'RIFF' && ascii(u8, 8, 4) === 'WAVE') return { kind: 'audio', name: 'WAV audio', ext: ['wav', 'wave'] };
    if (s4 === 'fLaC') return { kind: 'audio', name: 'FLAC audio', ext: ['flac'] };
    if (s4 === 'OggS') return { kind: 'audio', name: 'Ogg audio', ext: ['ogg', 'oga', 'opus'] };
    if (s4 === 'FORM' && /^AIF[FC]$/.test(ascii(u8, 8, 4))) return { kind: 'audio', name: 'AIFF audio', ext: ['aif', 'aiff', 'aifc'] };
    if (ascii(u8, 0, 3) === 'ID3' || (u8[0] === 0xff && (u8[1] & 0xe6) === 0xe2)) return { kind: 'audio', name: 'MP3 audio', ext: ['mp3'] };
    if (u8[0] === 0xff && (u8[1] & 0xf6) === 0xf0) return { kind: 'audio', name: 'AAC audio (ADTS)', ext: ['aac'] };
    if (ascii(u8, 4, 4) === 'ftyp') return { kind: 'audio', name: 'MP4/M4A audio', ext: ['m4a', 'mp4', 'aac'] };
    if (startsWith(u8, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'audio', name: 'WebM/Matroska audio', ext: ['webm', 'weba', 'mka'] };
    if (startsWith(u8, [0x30, 0x26, 0xb2, 0x75])) return { kind: 'audio', name: 'WMA audio', ext: ['wma'] };
    if (s4 === 'caff') return { kind: 'audio', name: 'Core Audio file', ext: ['caf'] };

    if (ascii(u8, 0, 2) === 'MZ') return { kind: 'executable', name: 'Windows program (EXE/DLL)' };
    if (startsWith(u8, [0x7f, 0x45, 0x4c, 0x46])) return { kind: 'executable', name: 'Linux program (ELF)' };
    if ([[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((m) => startsWith(u8, m))) {
      return { kind: 'executable', name: 'macOS or Java program' };
    }
    if (startsWith(u8, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return { kind: 'executable', name: 'Windows shortcut (LNK)' };
    if (startsWith(u8, [0xd0, 0xcf, 0x11, 0xe0])) return { kind: 'document', name: 'Office document or Windows installer (OLE)' };
    if (s4 === 'PK\x03\x04') return { kind: 'archive', name: 'ZIP archive (or APK/JAR/Office file)' };
    if (s4 === 'Rar!') return { kind: 'archive', name: 'RAR archive' };
    if (startsWith(u8, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: 'archive', name: '7-Zip archive' };
    if (startsWith(u8, [0x1f, 0x8b])) return { kind: 'archive', name: 'GZIP archive' };
    if (s4 === '%PDF') return { kind: 'document', name: 'PDF document' };
    if (ascii(u8, 0, 2) === '#!') return { kind: 'script', name: 'Shell script' };
    const head = ascii(u8, 0, Math.min(u8.length, 512)).replace(/^﻿?\s+/, '').toLowerCase();
    if (/^<(!doctype html|html|script|svg|\?xml)/.test(head)) return { kind: 'script', name: 'HTML/XML/script text' };
    if (/^(@echo|powershell|set |dim |function |var |const |import )/.test(head)) return { kind: 'script', name: 'Script text' };
    return { kind: 'unknown', name: 'Unrecognised format' };
  }

  /** Programs, archives and script keywords hidden anywhere in the file. */
  function findEmbedded(u8, startAt = 1) {
    const hits = [];
    const add = (type, offset, detail) => { if (hits.filter((h) => h.type === type).length < 5) hits.push({ type, offset, detail }); };
    const n = u8.length;
    for (let i = startAt; i < n - 64; i++) {
      const b = u8[i];
      if (b === 0x4d && u8[i + 1] === 0x5a) {
        // MZ header whose e_lfanew points at a "PE\0\0" signature: a real Windows executable.
        const pe = u32le(u8, i + 0x3c);
        if (pe >= 0x40 && pe <= 0x400 && i + pe + 4 <= n && u8[i + pe] === 0x50 && u8[i + pe + 1] === 0x45 && u8[i + pe + 2] === 0 && u8[i + pe + 3] === 0) {
          add('pe', i, 'Windows program (EXE/DLL)');
        }
      } else if (b === 0x7f && u8[i + 1] === 0x45 && u8[i + 2] === 0x4c && u8[i + 3] === 0x46) {
        if ((u8[i + 4] === 1 || u8[i + 4] === 2) && (u8[i + 5] === 1 || u8[i + 5] === 2) && u8[i + 6] === 1) add('elf', i, 'Linux program (ELF)');
      } else if (b === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 3 && u8[i + 3] === 4) {
        // ZIP local file header with a sane version and a printable file name.
        const version = u16le(u8, i + 4), nameLen = u16le(u8, i + 26);
        if (version <= 63 && nameLen >= 1 && nameLen <= 255 && i + 30 + nameLen <= n) {
          const name = ascii(u8, i + 30, nameLen);
          if (/^[\x20-\x7e]+$/.test(name)) add('zip', i, `ZIP archive containing "${name}"`);
        }
      } else if (b === 0x52 && u8[i + 1] === 0x61 && u8[i + 2] === 0x72 && u8[i + 3] === 0x21 && u8[i + 4] === 0x1a && u8[i + 5] === 0x07) {
        add('rar', i, 'RAR archive');
      }
    }
    return hits;
  }

  const KEYWORDS = [
    ['<script', 'HTML script tag'], ['javascript:', 'JavaScript link'], ['powershell', 'PowerShell command'],
    ['cmd.exe', 'Windows command prompt'], ['wscript.shell', 'Windows Script Host'], ['mshta', 'HTML application runner'],
    ['frombase64string', 'encoded payload loader'], ['invoke-expression', 'PowerShell code execution'],
    ['/bin/sh', 'Unix shell'], ['/bin/bash', 'Unix shell'], ['eval(', 'code evaluation'],
    ['this program cannot be run in dos mode', 'Windows program text'], ['createobject(', 'VBScript object creation'],
  ];

  const KEYWORD_LABEL = new Map(KEYWORDS);
  const KEYWORD_RE = new RegExp(KEYWORDS.map(([k]) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|'), 'gi');

  /** Search the file as Latin-1 text, in overlapping chunks, for script keywords and URLs. */
  function findText(u8) {
    const latin1 = new TextDecoder('latin1');
    const found = new Map();
    const urls = new Set();
    const CHUNK = 1 << 22, OVERLAP = 256;
    for (let start = 0; start < u8.length; start += CHUNK) {
      const end = Math.min(u8.length, start + CHUNK + OVERLAP);
      const text = latin1.decode(u8.subarray(start, end));
      for (const m of text.matchAll(KEYWORD_RE)) {
        const kw = m[0].toLowerCase();
        if (!found.has(kw)) found.set(kw, { keyword: kw, label: KEYWORD_LABEL.get(kw), offset: start + m.index });
      }
      for (const m of text.matchAll(/(?:https?|ftp):\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}[^\s\x00-\x1f"'<>\x7f-\xff]{0,120}/g)) {
        if (urls.size < 10) urls.add(m[0]);
      }
    }
    return { keywords: [...found.values()], urls: [...urls] };
  }

  /** Container structure checks: sizes that lie, and data hidden after the end. */
  function checkStructure(u8, kind) {
    const out = [];
    const n = u8.length;
    const s4 = ascii(u8, 0, 4);
    const trailing = (end, what) => {
      const extra = n - end;
      if (extra < 16) return;
      const tail = identify(u8.subarray(end));
      if (tail.kind === 'executable' || tail.kind === 'script' || tail.kind === 'archive') {
        out.push({ check: 'appended', severity: 'critical', title: `Hidden ${tail.name} after the end of the ${what} (${kb(extra)})`, detail: 'Something was attached after the audio, where players never look. Hiding a payload there is a known way to smuggle malware.', offset: end });
      } else if (ascii(u8, end, 3) === 'ID3' || ascii(u8, end, 3) === 'TAG') {
        out.push({ check: 'appended', severity: 'info', title: `Tag data after the end of the ${what}`, detail: 'Some tagging tools append MP3-style tags to other formats. This is harmless.' });
      } else if (extra > 1024) {
        out.push({ check: 'appended', severity: 'warning', title: `Hidden data after the end of the ${what} (${kb(extra)})`, detail: 'Players ignore these bytes, so they could hold anything. It is sometimes harmless (badly written editors), but it is also how payloads are hidden.', offset: end });
      }
    };

    if (s4 === 'RIFF' || s4 === 'FORM') {
      const le = s4 === 'RIFF';
      const declared = (le ? u32le(u8, 4) : u32be(u8, 4)) + 8;
      if (declared > n + 1) {
        out.push({ check: 'headers', severity: 'info', title: 'File is shorter than its header says', detail: `The header promises ${kb(declared)} but the file is ${kb(n)}. It is probably truncated (an interrupted download or copy).` });
      } else {
        trailing(declared + (declared & 1), le ? 'WAV data' : 'AIFF data');
      }
      for (let o = 12, guard = 0; o + 8 <= Math.min(n, declared) && guard < 10000; guard++) {
        const id = ascii(u8, o, 4), size = le ? u32le(u8, o + 4) : u32be(u8, o + 4);
        if (!/^[\x20-\x7e]{4}$/.test(id)) {
          out.push({ check: 'headers', severity: 'warning', title: 'Malformed chunk structure', detail: `Unreadable chunk ID at byte ${o}. Damaged or deliberately malformed headers can crash or exploit media players.`, offset: o });
          break;
        }
        if (o + 8 + size > n && !(id === 'data' || id === 'SSND')) {
          out.push({ check: 'headers', severity: 'warning', title: `Chunk "${id.trim()}" claims more data than the file has`, detail: `It says ${kb(size)} but only ${kb(n - o - 8)} remain. Oversized length fields are a classic way of attacking media players.`, offset: o });
          break;
        }
        o += 8 + size + (size & 1);
      }
    } else if (s4 === 'fLaC') {
      let o = 4, last = false, guard = 0;
      while (!last && o + 4 <= n && guard++ < 1000) {
        last = (u8[o] & 0x80) !== 0;
        const type = u8[o] & 0x7f, len = (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3];
        if (type === 127 || o + 4 + len > n) {
          out.push({ check: 'headers', severity: 'warning', title: 'Malformed FLAC metadata', detail: `Metadata block at byte ${o} is invalid or runs past the end of the file. Damaged or deliberately malformed headers can crash or exploit media players.`, offset: o });
          break;
        }
        if (type === 6 && len > 20 * 1048576) out.push({ check: 'headers', severity: 'info', title: 'Very large embedded picture', detail: `The cover art block is ${kb(len)}.` });
        o += 4 + len;
      }
    }

    if (ascii(u8, 0, 3) === 'ID3') {
      const ver = u8[3];
      const size = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
      if (ver < 2 || ver > 4 || [6, 7, 8, 9].some((i) => u8[i] & 0x80)) {
        out.push({ check: 'headers', severity: 'warning', title: 'Malformed ID3 tag header', detail: 'The MP3 tag header has invalid values. Damaged or deliberately malformed tags can crash or exploit media players.' });
      } else if (10 + size > n) {
        out.push({ check: 'headers', severity: 'warning', title: 'ID3 tag claims more data than the file has', detail: `The tag says ${kb(size)} but the file is ${kb(n)}. Oversized length fields are a classic way of attacking media players.` });
      }
    }
    return out;
  }

  /** Problems with the file name itself. */
  function checkName(name, real) {
    const out = [];
    if (/[‪-‮⁦-⁩]/.test(name)) {
      out.push({ check: 'name', severity: 'critical', title: 'Hidden text-direction characters in the name', detail: 'The name contains invisible right-to-left characters, a trick used to make "song3pm.exe" display as "songexe.mp3". The real extension is not what you see.' });
    }
    const parts = name.trim().toLowerCase().split('.');
    const ext = parts.length > 1 ? parts[parts.length - 1].trim() : '';
    const prev = parts.length > 2 ? parts[parts.length - 2].trim() : '';
    if (DANGEROUS_EXT[ext]) {
      out.push({
        check: 'name',
        severity: 'critical',
        title: AUDIO_EXT.includes(prev) ? `Disguised ${DANGEROUS_EXT[ext]} (.${prev}.${ext})` : `This is a ${DANGEROUS_EXT[ext]} (.${ext}), not audio`,
        detail: 'Opening this file runs code on your computer. A double extension like ".mp3.exe" is a common way of passing a program off as a song.',
      });
    }
    if (real.kind === 'audio' && ext && AUDIO_EXT.includes(ext) && real.ext && !real.ext.includes(ext)) {
      out.push({ check: 'name', severity: 'info', title: `Extension says .${ext} but the file is ${real.name}`, detail: 'This is harmless: most players open it either way. It just means the file was renamed or mislabelled.' });
    }
    return { findings: out, ext };
  }

  const CHECKS = [
    ['type', 'Contents are really audio', (real) => `Detected: ${real.name}`],
    ['name', 'File name is honest', () => 'No fake, double or hidden extension'],
    ['programs', 'No hidden programs', () => 'No Windows or Linux executables inside'],
    ['archives', 'No hidden archives', () => 'No ZIP or RAR files tucked inside'],
    ['appended', 'Nothing attached after the audio', () => 'The file ends where the audio ends'],
    ['headers', 'Headers are well-formed', () => 'Size fields match the file, nothing built to crash a player'],
    ['scripts', 'No script or command text', () => 'No PowerShell, JavaScript, cmd or similar'],
  ];

  /** One pass/fail line per check, so a clean result shows what was verified. */
  function summarizeChecks(findings, real, ext) {
    const notAudio = real.kind !== 'audio';
    return CHECKS.map(([id, label, passDetail]) => {
      if (notAudio && (id === 'appended' || id === 'headers')) return { id, label, status: 'skip', detail: 'Not applicable: the file is not audio' };
      if (notAudio && id === 'name' && AUDIO_EXT.includes(ext)) return { id, label, status: 'fail', detail: `Named .${ext} but it is a ${real.name}` };
      const hits = findings.filter((f) => f.check === id && f.severity !== 'info');
      const worst = hits.some((f) => f.severity === 'critical') ? 'fail' : hits.length ? 'warn' : 'pass';
      return { id, label, status: worst, detail: worst === 'pass' ? passDetail(real) : hits.map((f) => f.title).join('; ') };
    });
  }

  async function sha256(buffer) {
    const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
    if (!subtle) return null;
    const hash = await subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Scan a file.
   * @param {ArrayBuffer} buffer
   * @param {string} name file name
   */
  async function scan(buffer, name = '') {
    const u8 = new Uint8Array(buffer);
    const real = identify(u8);
    const findings = [];
    const nameCheck = checkName(name, real);
    findings.push(...nameCheck.findings);

    if (real.kind === 'executable' || real.kind === 'script') {
      findings.push({ check: 'type', severity: 'critical', title: `This file is a ${real.name}`, detail: `The content is not audio${nameCheck.ext ? `, despite the .${nameCheck.ext} name` : ''}. Opening it could run code on your computer. Delete it unless you know exactly where it came from.` });
    } else if (real.kind === 'archive' || real.kind === 'document') {
      findings.push({ check: 'type', severity: 'warning', title: `This file is a ${real.name}, not audio`, detail: 'It may contain other files, including programs. Don\'t open it unless you trust the source.' });
    } else if (real.kind === 'unknown') {
      findings.push({ check: 'type', severity: 'warning', title: 'Unrecognised file format', detail: 'The content does not match any known audio format. It could be damaged, or something else with an audio name.' });
    }

    if (real.kind === 'audio') findings.push(...checkStructure(u8, real.kind));

    for (const h of findEmbedded(u8, real.kind === 'executable' ? 2 : 1)) {
      const sev = h.type === 'zip' || h.type === 'rar' ? 'warning' : 'critical';
      findings.push({
        check: sev === 'critical' ? 'programs' : 'archives',
        severity: sev,
        title: `Embedded ${h.detail} at byte ${h.offset.toLocaleString('en-US')}`,
        detail: sev === 'critical'
          ? 'A complete program is hidden inside this file. Audio files have no reason to contain one, so this is a strong sign of malware.'
          : 'An archive is hidden inside this file. It can be harmless, but it is also how malware is smuggled inside media files.',
        offset: h.offset,
      });
    }

    const text = findText(u8);
    for (const k of text.keywords) {
      findings.push({ check: 'scripts', severity: 'warning', title: `Script text found: "${k.keyword}"`, detail: `Text typical of a ${k.label} appears at byte ${k.offset.toLocaleString('en-US')}. Audio has no use for it, so it may be part of a payload or an attempt to attack a player.`, offset: k.offset });
    }
    if (text.urls.length) {
      findings.push({ check: 'links', severity: 'info', title: `Links in the file (${text.urls.length})`, detail: `Usually artist or label websites in the tags. Don't open links you don't recognise: ${text.urls.join(', ')}`, urls: text.urls });
    }

    const order = { critical: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    const verdict = findings.some((f) => f.severity === 'critical') ? 'danger' : findings.some((f) => f.severity === 'warning') ? 'suspicious' : 'clean';
    const hash = await sha256(buffer);
    return {
      verdict,
      findings,
      checks: summarizeChecks(findings, real, nameCheck.ext),
      detected: real,
      size: u8.length,
      sha256: hash,
      virusTotalUrl: hash ? `https://www.virustotal.com/gui/file/${hash}` : null,
    };
  }

  return { scan, identify, findEmbedded, findText, checkStructure, checkName, sha256 };
});
