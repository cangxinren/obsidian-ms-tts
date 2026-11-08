import type { App } from 'obsidian';
import type { MsTtsSettings, ReadableDoc } from './types';
import type { TtsService } from './tts-service';
import type { AudioCache } from './cache';
import { sanitizeFileName, timestampSuffix } from './util';

export interface ExportOptions {
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export async function exportDocAudio(
  app: App,
  doc: ReadableDoc,
  settings: MsTtsSettings,
  tts: TtsService,
  cache: AudioCache,
  options: ExportOptions = {},
): Promise<string> {
  if (!doc.chunks.length) throw new Error('没有可导出的文本');
  if (settings.provider === 'system') {
    throw new Error('Windows 系统语音不支持导出音频文件，请切换到 Edge / 豆包 / OpenAI 兼容语音');
  }
  if (!tts.isConfigured()) {
    throw new Error(`${tts.providerLabel()}尚未配置，无法导出`);
  }

  const buffers: ArrayBuffer[] = [];

  for (let i = 0; i < doc.chunks.length; i++) {
    if (options.isCancelled?.()) throw new Error('导出已取消');

    const text = doc.chunks[i].text;
    const key = await tts.cacheKey(text);
    let buffer: ArrayBuffer | null = null;

    if (settings.cacheEnabled) {
      const hit = await cache.get(key);
      if (hit) buffer = await hit.arrayBuffer();
    }

    if (!buffer) {
      buffer = await tts.synthesize(text);
      if (settings.cacheEnabled) {
        await cache.put(key, new Blob([buffer], { type: 'audio/mpeg' }));
      }
    }

    buffers.push(buffer);
    options.onProgress?.(i + 1, doc.chunks.length);
  }

  const allRiff = buffers.every(isRiffWave);
  const data = allRiff ? concatWav(buffers) : concatMp3(buffers);
  const extension = allRiff ? 'wav' : 'mp3';

  return saveBinary(app, doc.title, data, extension);
}

function isRiffWave(buffer: ArrayBuffer): boolean {
  const data = new Uint8Array(buffer);
  return (
    data.length > 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x41 &&
    data[10] === 0x56 &&
    data[11] === 0x45
  );
}

export function concatMp3(buffers: ArrayBuffer[]): ArrayBuffer {
  const parts = buffers.map((buffer) => stripId3(new Uint8Array(buffer)));
  for (const part of parts) {
    if (part.length < 4) throw new Error('音频数据为空');
    if (!(part[0] === 0xff && (part[1] & 0xe0) === 0xe0)) throw new Error('音频数据不是 MPEG 帧');
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out.buffer;
}

function stripId3(data: Uint8Array): Uint8Array {
  let start = 0;
  let end = data.length;

  if (data.length > 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    const size =
      ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
    start = 10 + size + (data[5] & 0x10 ? 10 : 0);
  }

  if (end - start > 128 && data[end - 128] === 0x54 && data[end - 127] === 0x41 && data[end - 126] === 0x47) {
    end -= 128;
  }

  return data.subarray(start, end);
}

export function concatWav(buffers: ArrayBuffer[]): ArrayBuffer {
  const pcms = buffers.map((buffer) => {
    const data = new Uint8Array(buffer);
    if (
      data.length > 44 &&
      data[0] === 0x52 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x46
    ) {
      return data.subarray(44);
    }
    return data;
  });

  const totalPcm = pcms.reduce((sum, pcm) => sum + pcm.length, 0);
  const out = new Uint8Array(44 + totalPcm);
  writeWavHeader(out, totalPcm, 24000, 1, 16);

  let offset = 44;
  for (const pcm of pcms) {
    out.set(pcm, offset);
    offset += pcm.length;
  }
  return out.buffer;
}

function writeWavHeader(view: Uint8Array, pcmLength: number, sampleRate: number, channels: number, bits: number): void {
  const bytesPerSample = bits / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;

  writeAscii(view, 0, 'RIFF');
  writeUint32(view, 4, 36 + pcmLength);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  writeUint32(view, 16, 16);
  writeUint16(view, 20, 1);
  writeUint16(view, 22, channels);
  writeUint32(view, 24, sampleRate);
  writeUint32(view, 28, byteRate);
  writeUint16(view, 32, blockAlign);
  writeUint16(view, 34, bits);
  writeAscii(view, 36, 'data');
  writeUint32(view, 40, pcmLength);
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i);
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
  target[offset + 2] = (value >> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

async function saveBinary(app: App, title: string, data: ArrayBuffer, extension: string): Promise<string> {
  const configured = (app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.(
    'attachmentFolderPath',
  );
  let folder = typeof configured === 'string' ? configured.trim() : '附件';
  if (folder === './' || folder === '.' || folder === '/') folder = '';
  folder = folder.replace(/^\.\//, '').replace(/\/+$/, '');

  if (folder && !app.vault.getAbstractFileByPath(folder)) {
    try {
      await app.vault.createFolder(folder);
    } catch {
      // 可能已由其他窗口创建
    }
  }

  const base = `${sanitizeFileName(title)}-朗读-${timestampSuffix()}`;
  const buildPath = (suffix: string) =>
    folder ? `${folder}/${base}${suffix}.${extension}` : `${base}${suffix}.${extension}`;

  let path = buildPath('');
  let index = 2;
  while (app.vault.getAbstractFileByPath(path)) {
    path = buildPath(`-${index}`);
    index++;
  }

  await app.vault.createBinary(path, data);
  return path;
}
