import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import WebSocket from 'ws';

const OUTPUT_FILE = join(tmpdir(), 'edge-tts-test.mp3');
const OUTPUT_FILE_NEW = join(tmpdir(), 'edge-tts-test-new.mp3');

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600;
const COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';
const COEF = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const MIX1 = [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83];
const MIX2 = [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69];
const imul = Math.imul;
const ror16 = (x) => ((x << 16) | (x >>> 16)) >>> 0;

function swapTerm(w, key, K, S, P) {
  const sum = (imul(w, key) + imul(ror16(w), K)) >>> 0;
  const prod = imul(ror16(sum), S) >>> 0;
  return (imul(ror16(prod), P) + prod) >>> 0;
}
function mix4(v, ks) {
  for (const k of ks) v = imul(ror16(v), k) >>> 0;
  return v;
}
function cs64(msg, digest) {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const padded = Buffer.alloc(Math.ceil(msg.length / 8) * 8);
  msg.copy(padded);
  let swapSum = 0, lastSwap = 0, mix = 0, mixSum = 0;
  for (let o = 0; o < padded.length; o += 8) {
    const w1 = padded.readUInt32LE(o), w2 = padded.readUInt32LE(o + 4);
    const s1 = swapTerm(w1, keyA, 0xef0569fb, 0x76f50f34, 0xc3efea97);
    lastSwap = swapTerm(w2, keyB, 0xc31713db, 0x1881ce3c, 0x35bd1ec9);
    swapSum = (swapSum + s1 + lastSwap) >>> 0;
    mix = mix4(imul(mix + w1, keyA) >>> 0, MIX1);
    mixSum = (mixSum + mix) >>> 0;
    mix = mix4(imul(mix + w2, keyB) >>> 0, MIX2);
    mixSum = (mixSum + mix) >>> 0;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE((lastSwap ^ mix) >>> 0, 0);
  out.writeUInt32LE((swapSum ^ mixSum) >>> 0, 4);
  return out;
}
export function secMsGecV2(unixSeconds = Date.now() / 1000, skew = 0) {
  let t = unixSeconds + skew + WIN_EPOCH;
  t -= t % 300;
  const ticks = Math.round(t * 1e7);
  const msg = Buffer.from(COPYRIGHT + String(ticks) + TRUSTED, 'ascii');
  const digest = createHash('sha256').update(msg).digest();
  return `${cs64(msg, digest).toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

const expected = '492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876';
const actual = secMsGecV2(1791888000);
console.log('golden vector:', actual === expected ? 'PASS' : `FAIL\n  got ${actual}\n  exp ${expected}`);

function uuidHex() {
  return randomBytes(16).toString('hex');
}
function edgeDate() {
  return new Date().toUTCString();
}

const voice = process.argv[2] || 'zh-CN-XiaoxiaoNeural';
const text = process.argv[3] || '你好，这是微软 Edge 免费语音的测试。';
const rate = process.argv[4] || '+0%';
const pitch = process.argv[5] || '+0%';
const volume = process.argv[6] || '+0%';

function buildUrl(host, skew) {
  const id = uuidHex();
  const token = secMsGecV2(Date.now() / 1000, skew);
  if (host === 'classic') {
    return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=2-143.0.3650.75&ConnectionId=${id}`;
  }
  return `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=${TRUSTED}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=2-143.0.3650.75&ConnectionId=${id}`;
}

const headers = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
};

function synthesize(host, skew = 0) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildUrl(host, skew), { headers, handshakeTimeout: 10000 });
    const chunks = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(Buffer.concat(chunks));
    };
    ws.on('unexpected-response', (_req, res) => {
      const date = res.headers.date;
      finish(new Error(`handshake ${res.statusCode} date=${date}`));
    });
    ws.on('open', () => {
      const config =
        `X-Timestamp:${edgeDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n';
      ws.send(config);
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
        `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${text}</prosody></voice></speak>`;
      const frame =
        `X-RequestId:${uuidHex()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${edgeDate()}Z\r\nPath:ssml\r\n\r\n` +
        ssml;
      ws.send(frame);
    });
    let loggedBinary = false;
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary) {
        const headerLen = buf.readUInt16BE(0);
        const header = buf.subarray(2, 2 + headerLen).toString('utf8');
        if (!loggedBinary) {
          loggedBinary = true;
          console.log('FIRST_BINARY', { frameBytes: buf.length, headerLen, header: JSON.stringify(header) });
          console.log('FIRST_BINARY_HEX', buf.subarray(0, 64).toString('hex'));
        }
        if (!/Path:\s*audio/i.test(header)) return;
        const payload = buf.subarray(2 + headerLen);
        if (payload.length) chunks.push(payload);
        return;
      }
      const head = buf.toString('utf8', 0, Math.min(buf.length, 200));
      if (/Path:\s*turn\.end/i.test(head)) finish();
    });
    ws.on('error', (err) => finish(err));
    ws.on('close', (code) => {
      if (!done) finish(new Error(`closed ${code} with ${chunks.length} chunks`));
    });
  });
}

try {
  const audio = await synthesize('classic');
  console.log(`synthesized ${audio.length} bytes for ${voice}`);
  writeFileSync(OUTPUT_FILE, audio);
  console.log(`saved ${OUTPUT_FILE}`);
} catch (error) {
  console.error('classic failed:', error.message);
  try {
    const audio = await synthesize('new');
    console.log(`new host synthesized ${audio.length} bytes`);
    writeFileSync(OUTPUT_FILE_NEW, audio);
    console.log(`saved ${OUTPUT_FILE_NEW}`);
  } catch (error2) {
    console.error('new host failed:', error2.message);
    process.exitCode = 1;
  }
}

https.get(
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED}`,
  { headers: { 'User-Agent': headers['User-Agent'], Cookie: headers.Cookie, Accept: '*/*' } },
  (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      try {
        const voices = JSON.parse(body);
        const zh = voices.filter((v) => v.Locale === 'zh-CN');
        console.log(`voices total=${voices.length} zh-CN=${zh.length}`);
        for (const v of zh) {
          console.log(`  ${v.ShortName} | ${v.Gender} | ${(v.VoiceTag?.ContentCategories || []).join(',')} | ${(v.VoiceTag?.VoicePersonalities || []).join(',')}`);
        }
      } catch (error) {
        console.error('voices parse failed', res.statusCode, error.message, body.slice(0, 200));
      }
    });
  },
).on('error', (error) => console.error('voices request failed', error.message));
