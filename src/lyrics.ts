export interface LyricLine {
  timeMs: number;
  text: string;
}

export interface LyricMeta {
  title: string;
  artist?: string;
  album?: string;
  lengthMs?: number;
}

const DEFAULT_ARTIST = '微软语音朗读';
const DEFAULT_ALBUM = 'Obsidian 笔记';

/** 生成 LRC 文本（UTF-8，无 BOM） */
export function buildLrc(lines: LyricLine[], meta: LyricMeta): string {
  const out: string[] = [];
  const pushMeta = (key: string, value: string | undefined) => {
    if (!value) return;
    const clean = value.replace(/[\r\n\]]+/g, ' ').trim();
    if (clean) out.push(`[${key}:${clean}]`);
  };

  pushMeta('ti', meta.title);
  pushMeta('ar', meta.artist ?? DEFAULT_ARTIST);
  pushMeta('al', meta.album ?? DEFAULT_ALBUM);
  out.push('[by:obsidian-ms-tts]');
  if (meta.lengthMs && meta.lengthMs > 0) {
    out.push(`[length:${formatLrcDuration(meta.lengthMs)}]`);
  }
  out.push('[offset:0]');

  for (const line of lines) {
    const text = normalizeLine(line.text);
    if (!text) continue;
    out.push(`[${formatLrcTime(line.timeMs)}]${text}`);
  }
  return `${out.join('\n')}\n`;
}

export function formatLrcTime(timeMs: number): string {
  const totalCs = Math.max(0, Math.floor(timeMs / 10));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  return `${pad2(minutes)}:${pad2(seconds)}.${pad2(cs)}`;
}

export function formatLrcDuration(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.round(timeMs / 1000));
  return `${pad2(Math.floor(totalSeconds / 60))}:${pad2(totalSeconds % 60)}`;
}

/** 生成 ID3v2.3 标签（含 USLT 与 SYLT），供 MP3 内嵌歌词 */
export function buildId3Tag(lines: LyricLine[], meta: LyricMeta): Uint8Array {
  const frames: Uint8Array[] = [];
  frames.push(textFrame('TIT2', meta.title || '朗读音频'));
  frames.push(textFrame('TPE1', meta.artist ?? DEFAULT_ARTIST));
  frames.push(textFrame('TALB', meta.album ?? DEFAULT_ALBUM));
  if (meta.lengthMs && meta.lengthMs > 0) {
    frames.push(asciiFrame('TLEN', String(Math.round(meta.lengthMs))));
  }
  frames.push(asciiFrame('TYER', String(new Date().getFullYear())));

  const validLines = lines
    .map((line) => ({ timeMs: Math.max(0, Math.round(line.timeMs)), text: normalizeLine(line.text) }))
    .filter((line) => line.text);

  if (validLines.length) {
    frames.push(unsynchronizedLyricsFrame(validLines.map((line) => line.text).join('\n')));
    frames.push(synchronizedLyricsFrame(validLines));
  }

  const framesLength = frames.reduce((sum, frame) => sum + frame.length, 0);
  const padding = 1024;
  const tagSize = framesLength + padding;
  const tag = new Uint8Array(10 + tagSize);

  writeAscii(tag, 0, 'ID3');
  tag[3] = 0x03; // ID3v2.3
  tag[4] = 0x00;
  tag[5] = 0x00;
  writeSynchsafe(tag, 6, tagSize);

  let offset = 10;
  for (const frame of frames) {
    tag.set(frame, offset);
    offset += frame.length;
  }
  return tag;
}

/** 在音频前写入 ID3v2 标签；若已有旧标签先剥离 */
export function prependId3(audio: ArrayBuffer, tag: Uint8Array): ArrayBuffer {
  const data = new Uint8Array(audio);
  const start = id3v2Length(data);
  let end = data.length;
  if (
    end - start > 128 &&
    data[end - 128] === 0x54 &&
    data[end - 127] === 0x41 &&
    data[end - 126] === 0x47
  ) {
    end -= 128;
  }

  const out = new Uint8Array(tag.length + (end - start));
  out.set(tag, 0);
  out.set(data.subarray(start, end), tag.length);
  return out.buffer;
}

function textFrame(id: string, text: string): Uint8Array {
  return frame(id, [0x01, ...utf16Bytes(text)]);
}

function asciiFrame(id: string, text: string): Uint8Array {
  const bytes: number[] = [0x00];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0x7f);
  return frame(id, bytes);
}

function unsynchronizedLyricsFrame(lyrics: string): Uint8Array {
  // encoding=UTF-16, language=chi, 空内容描述符, 歌词
  return frame('USLT', [0x01, 0x63, 0x68, 0x69, 0x00, 0x00, ...utf16Bytes(lyrics)]);
}

function synchronizedLyricsFrame(lines: LyricLine[]): Uint8Array {
  const bytes: number[] = [
    0x01, // UTF-16
    0x63,
    0x68,
    0x69, // chi
    0x02, // 时间格式：毫秒
    0x01, // 内容类型：歌词
    0x00,
    0x00, // 空内容描述符
  ];

  for (const line of lines) {
    bytes.push(...utf16Bytes(line.text), 0x00, 0x00);
    const time = Math.max(0, Math.round(line.timeMs));
    bytes.push((time >>> 24) & 0xff, (time >>> 16) & 0xff, (time >>> 8) & 0xff, time & 0xff);
  }
  return frame('SYLT', bytes);
}

function frame(id: string, body: number[]): Uint8Array {
  const out = new Uint8Array(10 + body.length);
  writeAscii(out, 0, id);
  writeUint32BE(out, 4, body.length);
  out[8] = 0x00;
  out[9] = 0x00;
  out.set(body, 10);
  return out;
}

function utf16Bytes(text: string): number[] {
  const bytes: number[] = [0xff, 0xfe];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes.push(code & 0xff, (code >> 8) & 0xff);
  }
  return bytes;
}

function writeSynchsafe(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >> 21) & 0x7f;
  target[offset + 1] = (value >> 14) & 0x7f;
  target[offset + 2] = (value >> 7) & 0x7f;
  target[offset + 3] = value & 0x7f;
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) target[offset + i] = text.charCodeAt(i);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
