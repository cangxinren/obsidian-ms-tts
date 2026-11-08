import { createHash, randomBytes } from 'crypto';
import WebSocket from 'ws';
import { Platform, requestUrl } from 'obsidian';
import type { MsTtsSettings, VoiceOption } from '../types';
import { TtsError } from '../errors';
import { buildSSML } from '../ssml';
import type { RateLimiter } from '../rate-limiter';
import { normalizeEdgeVoices } from '../voices';
import { clamp, splitTextForBytes } from '../util';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const SEC_MS_GEC_VERSION = '2-143.0.3650.75';
const WIN_EPOCH = 11644473600;
const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';
const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;

const MIX1 = [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83];
const MIX2 = [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69];

const imul = Math.imul;
const ror16 = (value: number) => ((value << 16) | (value >>> 16)) >>> 0;

function swapTerm(word: number, key: number, k: number, s: number, p: number): number {
  const sum = (imul(word, key) + imul(ror16(word), k)) >>> 0;
  const prod = imul(ror16(sum), s) >>> 0;
  return (imul(ror16(prod), p) + prod) >>> 0;
}

function mix4(value: number, keys: number[]): number {
  let result = value;
  for (const key of keys) result = imul(ror16(result), key) >>> 0;
  return result;
}

function cs64(message: Buffer, digest: Buffer): Buffer {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const padded = Buffer.alloc(Math.ceil(message.length / 8) * 8);
  message.copy(padded);

  let swapSum = 0;
  let lastSwap = 0;
  let mix = 0;
  let mixSum = 0;

  for (let offset = 0; offset < padded.length; offset += 8) {
    const first = padded.readUInt32LE(offset);
    const second = padded.readUInt32LE(offset + 4);

    const firstSwap = swapTerm(first, keyA, 0xef0569fb, 0x76f50f34, 0xc3efea97);
    lastSwap = swapTerm(second, keyB, 0xc31713db, 0x1881ce3c, 0x35bd1ec9);
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0;

    mix = mix4(imul(mix + first, keyA) >>> 0, MIX1);
    mixSum = (mixSum + mix) >>> 0;
    mix = mix4(imul(mix + second, keyB) >>> 0, MIX2);
    mixSum = (mixSum + mix) >>> 0;
  }

  const out = Buffer.alloc(8);
  out.writeUInt32LE((lastSwap ^ mix) >>> 0, 0);
  out.writeUInt32LE((swapSum ^ mixSum) >>> 0, 4);
  return out;
}

/** Sec-MS-GEC v2：SHA-256(版权前缀 + ticks + token) + CS64 */
export function secMsGecV2(unixSeconds = Date.now() / 1000, clockSkewSeconds = 0): string {
  let time = unixSeconds + clockSkewSeconds + WIN_EPOCH;
  time -= time % 300;
  const ticks = Math.round(time * 1e7);
  const message = Buffer.from(
    `${EDGE_COPYRIGHT}${String(ticks)}${TRUSTED_CLIENT_TOKEN}`,
    'ascii',
  );
  const digest = createHash('sha256').update(message).digest();
  return `${cs64(message, digest).toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

class EdgeHandshakeError extends Error {
  constructor(readonly status: number, readonly serverDate?: number) {
    super(`Edge handshake failed: ${status}`);
    this.name = 'EdgeHandshakeError';
  }
}

export class EdgeProvider {
  constructor(
    private readonly getSettings: () => MsTtsSettings,
    private readonly limiter: RateLimiter,
  ) {}

  async listVoices(): Promise<VoiceOption[]> {
    if (!Platform.isDesktopApp) {
      throw new TtsError('config', 'Edge 免费语音只支持 Obsidian 桌面版');
    }

    let response;
    try {
      response = await requestUrl({
        url: VOICES_URL,
        method: 'GET',
        headers: { Accept: '*/*' },
        throw: false,
      });
    } catch (error) {
      throw new TtsError('network', `无法连接 Edge 语音列表：${errorMessage(error)}`);
    }

    if (response.status !== 200) {
      throw new TtsError('network', `获取 Edge 语音列表失败（${response.status}）`);
    }

    const data = response.json;
    if (!Array.isArray(data)) {
      throw new TtsError('unknown', 'Edge 语音列表格式异常');
    }
    return normalizeEdgeVoices(data as unknown[]);
  }

  async synthesize(text: string): Promise<ArrayBuffer> {
    if (!Platform.isDesktopApp) {
      throw new TtsError('config', 'Edge 免费语音需要 Obsidian 桌面版');
    }

    const settings = this.getSettings();
    const voice = settings.edgeVoice || 'zh-CN-XiaoxiaoNeural';
    const prosody = {
      rate: signedPercent((clamp(settings.rate, 0.5, 2) - 1) * 100),
      pitch: `${settings.pitch >= 0 ? '+' : ''}${Math.round(clamp(settings.pitch, -12, 12))}st`,
      volume: signedPercent(clamp(settings.volume, 0, 100) - 100),
    };
    const pieces = splitTextForBytes(text, 3000);
    const buffers: ArrayBuffer[] = [];

    for (const piece of pieces) {
      await this.limiter.acquire();
      const ssml = buildSSML({ text: piece, voice, rate: prosody.rate, pitch: prosody.pitch, volume: prosody.volume });
      const buffer = await this.synthesizePiece(ssml);
      buffers.push(new Uint8Array(buffer).buffer as ArrayBuffer);
    }

    return concat(buffers);
  }

  private async synthesizePiece(ssml: string): Promise<Buffer> {
    let skew = 0;
    let lastError: Error | null = null;

    for (const host of ['classic', 'new'] as const) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.once(host, ssml, skew);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (error instanceof EdgeHandshakeError) {
            if (error.status === 429) {
              this.limiter.noteCooldown(5000);
              throw new TtsError('rate-limit', 'Edge 语音请求过于频繁，请稍后重试');
            }
            if (error.status === 403 && error.serverDate && attempt === 0) {
              const nextSkew = error.serverDate - Date.now() / 1000;
              if (Math.abs(nextSkew - skew) > 1) {
                skew = nextSkew;
                continue;
              }
            }
          }
          break;
        }
      }
    }

    if (lastError instanceof EdgeHandshakeError) {
      if (lastError.status === 401 || lastError.status === 403) {
        throw new TtsError('auth', 'Edge 语音鉴权失败，接口可能已变更，请更新插件');
      }
      throw new TtsError('server', `Edge 语音握手失败（${lastError.status}）`);
    }
    throw lastError ?? new TtsError('unknown', 'Edge 语音合成失败');
  }

  private once(
    host: 'classic' | 'new',
    ssml: string,
    skew: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const connectionId = randomBytes(16).toString('hex');
      const token = secMsGecV2(Date.now() / 1000, skew);
      const url =
        host === 'classic'
          ? `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`
          : `wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;

      const socket = new WebSocket(url, {
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
        },
        handshakeTimeout: 15000,
      });

      const chunks: Buffer[] = [];
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        try {
          socket.removeAllListeners();
          socket.terminate();
        } catch {
          // ignore
        }
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!chunks.length) {
          reject(new TtsError('server', 'Edge 未返回音频，请重试或更换语音'));
          return;
        }
        resolve(Buffer.concat(chunks));
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      timer = setTimeout(() => fail(new TtsError('server', 'Edge 语音合成超时')), 30000);

      socket.on('unexpected-response', (_request, response) => {
        response.resume();
        const dateHeader = response.headers.date;
        const dateValue = Array.isArray(dateHeader) ? dateHeader[0] : dateHeader;
        const parsedDate = dateValue ? Date.parse(dateValue) / 1000 : NaN;
        fail(
          new EdgeHandshakeError(
            response.statusCode ?? 0,
            Number.isFinite(parsedDate) ? parsedDate : undefined,
          ),
        );
      });

      socket.on('open', () => {
        const timestamp = new Date().toUTCString();
        const config =
          `X-Timestamp:${timestamp}\r\n` +
          'Content-Type:application/json; charset=utf-8\r\n' +
          'Path:speech.config\r\n\r\n' +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n';
        socket.send(config);

        const requestId = randomBytes(16).toString('hex');
        const frame =
          `X-RequestId:${requestId}\r\n` +
          'Content-Type:application/ssml+xml\r\n' +
          `X-Timestamp:${timestamp}Z\r\n` +
          'Path:ssml\r\n\r\n' +
          ssml;
        socket.send(frame);
      });

      socket.on('message', (data, isBinary) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (isBinary) {
          if (buffer.length < 2) return;
          const headerLength = buffer.readUInt16BE(0);
          if (buffer.length < headerLength + 2) return;
          const header = buffer.subarray(2, 2 + headerLength).toString('utf8');
          if (!/Path:\s*audio/i.test(header)) return;
          // 前 2 字节是大端 header 长度；headerLength 已包含 header 末尾的 CRLF
          const payload = buffer.subarray(2 + headerLength);
          if (payload.length) chunks.push(Buffer.from(payload));
          return;
        }
        const textFrame = buffer.toString('utf8', 0, Math.min(buffer.length, 400));
        if (/Path:\s*turn\.end/i.test(textFrame)) succeed();
      });

      socket.on('error', (error) => {
        fail(new TtsError('network', `Edge 连接失败：${error.message}`));
      });

      socket.on('close', (code) => {
        if (!settled) fail(new TtsError('network', `Edge 连接中断（${code}）`));
      });
    });
  }
}

function signedPercent(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : ''}${rounded}%`;
}

function concat(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    out.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return out.buffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
