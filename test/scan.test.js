const test = require('node:test');
const assert = require('node:assert/strict');
const AS = require('../scan.js');
const { GDrive } = require('../gdrive.js');

const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);

function wav(seconds = 0.5) {
  const n = Math.round(8000 * seconds), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 3)), 44 + i * 2);
  return b;
}
function exe() {
  const b = Buffer.alloc(1024);
  b.write('MZ', 0); b.writeUInt32LE(0x80, 0x3c); b.write('PE\0\0', 0x80, 'latin1');
  return b;
}
function zip(name) {
  const b = Buffer.alloc(30 + name.length + 40);
  b.write('PK\x03\x04', 0, 'latin1'); b.writeUInt16LE(20, 4); b.writeUInt16LE(name.length, 26); b.write(name, 30);
  return b;
}

test('a normal WAV is clean and gets a SHA-256 and VirusTotal link', async () => {
  const r = await AS.scan(ab(wav()), 'take1.wav');
  assert.equal(r.verdict, 'clean', JSON.stringify(r.findings));
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.virusTotalUrl, `https://www.virustotal.com/gui/file/${r.sha256}`);
});

test('a Windows program renamed to .mp3 is dangerous', async () => {
  const r = await AS.scan(ab(exe()), 'song.mp3');
  assert.equal(r.verdict, 'danger');
  assert.match(r.findings[0].title, /Windows program/);
});

test('double extension .mp3.exe is dangerous', async () => {
  const r = await AS.scan(ab(wav()), 'song.mp3.exe');
  assert.equal(r.verdict, 'danger');
  assert.ok(r.findings.some((f) => /Disguised/.test(f.title)));
});

test('right-to-left override in the name is dangerous', async () => {
  const r = await AS.scan(ab(wav()), 'track‮gnp.exe.wav');
  assert.equal(r.verdict, 'danger');
});

test('a program appended after the audio is found', async () => {
  const r = await AS.scan(ab(Buffer.concat([wav(), exe()])), 'mix.wav');
  assert.equal(r.verdict, 'danger');
  assert.ok(r.findings.some((f) => /Hidden Windows program .*after the end/.test(f.title)), JSON.stringify(r.findings.map((f) => f.title)));
  assert.ok(r.findings.some((f) => /Embedded Windows program/.test(f.title)));
});

test('a ZIP hidden inside audio is suspicious', async () => {
  const w = wav();
  const r = await AS.scan(ab(Buffer.concat([w.subarray(0, 100), zip('payload.vbs'), w.subarray(100)])), 'a.wav');
  assert.equal(r.verdict, 'suspicious');
  assert.ok(r.findings.some((f) => /payload\.vbs/.test(f.title)));
});

test('script text and links are reported', async () => {
  const w = wav();
  w.write('<SCRIPT>PowerShell -enc x</script> see https://example.com/x', 2000, 'latin1'); // inside the audio data
  const r = await AS.scan(ab(w), 'a.wav');
  assert.equal(r.verdict, 'suspicious');
  assert.ok(r.findings.some((f) => /"<script"/.test(f.title)));
  assert.ok(r.findings.some((f) => /"powershell"/.test(f.title)));
  assert.ok(r.findings.some((f) => f.urls && f.urls.includes('https://example.com/x')));
});

test('oversized chunk lengths are flagged as malformed', async () => {
  const w = wav();
  const bad = Buffer.concat([w.subarray(0, 36), Buffer.from('LIST'), Buffer.from([0xff, 0xff, 0xff, 0x7f]), w.subarray(36)]);
  bad.writeUInt32LE(bad.length - 8, 4);
  const r = await AS.scan(ab(bad), 'a.wav');
  assert.ok(r.findings.some((f) => /claims more data/.test(f.title)), JSON.stringify(r.findings));
});

test('a renamed but genuine audio file is only a note', async () => {
  const r = await AS.scan(ab(wav()), 'track.mp3');
  assert.equal(r.verdict, 'clean');
  assert.ok(r.findings.some((f) => f.severity === 'info' && /Extension says \.mp3/.test(f.title)));
});

test('random data with an audio header gives no false alarms', async () => {
  const b = Buffer.alloc(8 * 1048576);
  let x = 12345;
  for (let i = 0; i < b.length; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  b.write('ID3', 0); b[3] = 3; b[4] = 0; b[5] = 0; b[6] = b[7] = b[8] = 0; b[9] = 10;
  const r = await AS.scan(ab(b), 'noise.mp3');
  assert.equal(r.verdict, 'clean', JSON.stringify(r.findings));
});

test('Drive link parsing', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  for (const link of [
    `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/uc?export=download&id=${id}`,
    `https://drive.usercontent.google.com/download?id=${id}&export=download`,
    id,
  ]) assert.equal(GDrive.extractId(link), id, link);
  assert.equal(GDrive.extractId('https://example.com/song.mp3'), null);
});
