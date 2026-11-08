import { charWeight } from './segmenter';
import { clamp } from './util';

export interface AudioMeta {
  format: 'mp3' | 'wav';
  durationMs: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  bitrate?: number;
}

export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

const MP3_BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];
const MP3_BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0];
const MP3_BITRATES_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

const MP3_SAMPLE_RATES: Record<number, number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
};

interface Mp3Frame {
  frameLength: number;
  samples: number;
  sampleRate: number;
  bitrate: number;
}

/** 解析 RIFF/WAVE，支持 fmt/data 不在固定偏移的 PCM 文件 */
export function parseWav(buffer: ArrayBuffer): WavInfo | null {
  const data = new Uint8Array(buffer);
  if (data.length < 12) return null;
  if (!isAscii(data, 0, 'RIFF') || !isAscii(data, 8, 'WAVE')) return null;

  let offset = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataLength'> | null = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= data.length) {
    const id = readAscii(data, offset, 4);
    const size = readUint32LE(data, offset + 4);
    const body = offset + 8;
    const available = Math.max(0, data.length - body);

    if (id === 'fmt ' && available >= 16) {
      const audioFormat = readUint16LE(data, body);
      const channels = readUint16LE(data, body + 2);
      const sampleRate = readUint32LE(data, body + 4);
      const byteRate = readUint32LE(data, body + 8);
      const blockAlign = readUint16LE(data, body + 12);
      const bitsPerSample = readUint16LE(data, body + 14);
      // 1 = PCM；0xFFFE = WAVE_FORMAT_EXTENSIBLE，按 PCM 处理（子格式校验从简）
      if (audioFormat === 1 || audioFormat === 0xfffe) {
        fmt = { audioFormat, channels, sampleRate, byteRate, blockAlign, bitsPerSample };
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, available);
    }

    if (size > available) break;
    offset = body + size + (size & 1);
  }

  if (!fmt || dataOffset < 0 || !dataLength || !fmt.sampleRate || !fmt.byteRate) return null;
  return { ...fmt, dataOffset, dataLength };
}

/** 识别音频格式并计算精确时长；无法识别时返回 null */
export function inspectAudio(buffer: ArrayBuffer): AudioMeta | null {
  const wav = parseWav(buffer);
  if (wav) {
    return {
      format: 'wav',
      durationMs: Math.round((wav.dataLength / wav.byteRate) * 1000),
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      bitsPerSample: wav.bitsPerSample,
      bitrate: wav.byteRate * 8,
    };
  }

  const mp3 = parseMp3(buffer);
  if (mp3) {
    return {
      format: 'mp3',
      durationMs: mp3.durationMs,
      sampleRate: mp3.sampleRate,
      bitrate: mp3.bitrate,
    };
  }

  return null;
}

interface Mp3Info {
  durationMs: number;
  sampleRate: number;
  bitrate: number;
  frameCount: number;
}

/** 逐帧扫描 MP3，累计每帧时长；对 VBR 同样有效 */
export function parseMp3(buffer: ArrayBuffer): Mp3Info | null {
  const data = new Uint8Array(buffer);
  let start = id3v2Length(data);
  let end = data.length;

  if (
    end - start > 128 &&
    data[end - 128] === 0x54 &&
    data[end - 127] === 0x41 &&
    data[end - 126] === 0x47
  ) {
    end -= 128;
  }

  let offset = start;
  let frameCount = 0;
  let duration = 0;
  let sampleRate = 0;
  let bitrateSum = 0;
  let firstFrameStart = -1;
  let firstFrameEnd = -1;

  while (offset + 4 <= end) {
    const frame = parseMp3Frame(data, offset);
    if (!frame) {
      offset++;
      continue;
    }

    if (frameCount === 0) {
      firstFrameStart = offset;
      firstFrameEnd = offset + frame.frameLength;
    }
    frameCount++;
    duration += frame.samples / frame.sampleRate;
    if (!sampleRate) sampleRate = frame.sampleRate;
    bitrateSum += frame.bitrate;
    offset += frame.frameLength;
  }

  if (!frameCount || !duration) return null;

  // Xing/Info/VBRI 头帧本身不含可听音频，扣除以避免总时长偏长
  if (
    firstFrameStart >= 0 &&
    firstFrameEnd > firstFrameStart &&
    hasVbrHeader(data, firstFrameStart, firstFrameEnd) &&
    frameCount > 1
  ) {
    const first = parseMp3Frame(data, firstFrameStart);
    if (first) {
      duration -= first.samples / first.sampleRate;
      frameCount--;
      bitrateSum -= first.bitrate;
    }
  }

  return {
    durationMs: Math.round(duration * 1000),
    sampleRate,
    bitrate: Math.round(bitrateSum / Math.max(1, frameCount)),
    frameCount,
  };
}

function parseMp3Frame(data: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > data.length) return null;
  if (data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) return null;

  const versionBits = (data[offset + 1] >> 3) & 0x03;
  const layerBits = (data[offset + 1] >> 1) & 0x03;
  if (versionBits === 1 || layerBits === 0) return null;

  const bitrateIndex = (data[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (data[offset + 2] >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const padding = (data[offset + 2] >> 1) & 1;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer = 4 - layerBits;
  const sampleRate = MP3_SAMPLE_RATES[version][sampleRateIndex];

  const table =
    version === 1
      ? layer === 1
        ? MP3_BITRATES_V1_L1
        : layer === 2
          ? MP3_BITRATES_V1_L2
          : MP3_BITRATES_V1_L3
      : layer === 1
        ? MP3_BITRATES_V2_L1
        : MP3_BITRATES_V2_L23;

  const bitrate = table[bitrateIndex] * 1000;
  if (!bitrate) return null;

  const samples = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576;

  let frameLength: number;
  if (layer === 1) {
    frameLength = Math.floor((12 * bitrate) / sampleRate + padding) * 4;
  } else if (layer === 3 && version !== 1) {
    frameLength = Math.floor((72 * bitrate) / sampleRate + padding);
  } else {
    frameLength = Math.floor((144 * bitrate) / sampleRate + padding);
  }

  if (frameLength < 4) return null;
  return { frameLength, samples, sampleRate, bitrate };
}

function hasVbrHeader(data: Uint8Array, frameStart: number, frameEnd: number): boolean {
  const limit = Math.min(frameEnd, frameStart + 200);
  for (let i = frameStart + 4; i + 4 <= limit; i++) {
    if (
      (data[i] === 0x58 && data[i + 1] === 0x69 && data[i + 2] === 0x6e && data[i + 3] === 0x67) || // Xing
      (data[i] === 0x49 && data[i + 1] === 0x6e && data[i + 2] === 0x66 && data[i + 3] === 0x6f) // Info
    ) {
      return true;
    }
  }
  return false;
}

function id3v2Length(data: Uint8Array): number {
  if (data.length < 10 || data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return 0;
  const size =
    ((data[6] & 0x7f) << 21) |
    ((data[7] & 0x7f) << 14) |
    ((data[8] & 0x7f) << 7) |
    (data[9] & 0x7f);
  const total = 10 + size + (data[5] & 0x10 ? 10 : 0);
  return total < data.length ? total : 0;
}

/** 解析失败时的兜底：按字符权重与语速估算 */
export function estimateDurationMs(text: string, rate: number): number {
  const speed = clamp(rate || 1, 0.5, 2);
  const weight = charWeight(text);
  // 中文约 4.2 字/秒（1x），加上少量起播延迟
  return Math.max(300, Math.round((weight / (4.2 * speed)) * 1000));
}

function readUint16LE(data: Uint8Array, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8)) >>> 0;
}

function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

function isAscii(data: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > data.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (data[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function readAscii(data: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length && offset + i < data.length; i++) {
    text += String.fromCharCode(data[offset + i]);
  }
  return text;
}
