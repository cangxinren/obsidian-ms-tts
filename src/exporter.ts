import { App, TFile } from 'obsidian';
import type { MsTtsSettings, ReadableDoc, Sentence } from './types';
import type { TtsService } from './tts-service';
import type { AudioCache } from './cache';
import { sanitizeFileName, timestampSuffix } from './util';
import { buildReadableDoc } from './text-extract';
import { estimateDurationMs, inspectAudio, parseWav } from './audio-meta';
import { buildId3Tag, buildLrc, prependId3, type LyricLine } from './lyrics';

export interface ExportOptions {
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export interface ExportSource {
  kind: 'note' | 'custom';
  title: string;
  path?: string;
  text?: string;
}

export interface PreparedExportUnit {
  title: string;
  doc: ReadableDoc;
  /** 标题单元：有声音朗读《标题》，歌词显示【标题】 */
  isTitle?: boolean;
  /** 非标题单元的章节标记：不产生音频，只在歌词该单元开始处插入【标题】 */
  chapterLabel?: string;
}

export interface PrepareOptions {
  announceTitles: boolean;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

export interface MergedExportOptions extends ExportOptions {
  fileName?: string;
  /** undefined=附件目录；'' 或 '/'=库根目录；其他=指定目录 */
  folder?: string;
  includeLyrics: boolean;
  embedLyrics: boolean;
  /** 由调用方统计后回传，用于结果汇总 */
  skipped?: string[];
}

export interface ExportResult {
  audioPath: string;
  lyricsPath: string | null;
  lyricsError?: string;
  durationMs: number;
  size: number;
  skipped: string[];
}

/** 旧命令使用：导出单篇笔记（仅音频） */
export async function exportDocAudio(
  app: App,
  doc: ReadableDoc,
  settings: MsTtsSettings,
  tts: TtsService,
  cache: AudioCache,
  options: ExportOptions = {},
): Promise<string> {
  if (!doc.chunks.length) throw new Error('没有可导出的文本');
  assertExportable(settings, tts);

  const result = await exportMergedAudio(
    app,
    [{ title: doc.title, doc }],
    settings,
    tts,
    cache,
    {
      onProgress: options.onProgress,
      isCancelled: options.isCancelled,
      includeLyrics: false,
      embedLyrics: false,
      fileName: doc.title,
    },
  );
  return result.audioPath;
}

/** 读取来源队列并构建导出单元；多来源时按需插入标题/章节 */
export async function prepareExportUnits(
  app: App,
  sources: ExportSource[],
  settings: MsTtsSettings,
  options: PrepareOptions,
): Promise<{ units: PreparedExportUnit[]; skipped: string[] }> {
  const prepared: Array<{ title: string; doc: ReadableDoc }> = [];
  const skipped: string[] = [];

  for (let i = 0; i < sources.length; i++) {
    if (options.isCancelled?.()) throw new Error('导出已取消');
    const source = sources[i];
    const title = cleanTitle(source.title);
    let doc: ReadableDoc | null = null;

    if (source.kind === 'custom') {
      doc = buildReadableDoc(source.text ?? '', {
        chunkChars: settings.chunkChars,
        perSentence: settings.perSentence,
        title,
      });
    } else if (source.path) {
      const file = app.vault.getAbstractFileByPath(source.path);
      if (file instanceof TFile && file.extension.toLowerCase() === 'md') {
        try {
          const text = await app.vault.cachedRead(file);
          doc = buildReadableDoc(text, {
            chunkChars: settings.chunkChars,
            perSentence: settings.perSentence,
            title: title || file.basename,
          });
        } catch {
          doc = null;
        }
      }
    }

    if (doc && doc.chunks.length) {
      prepared.push({ title: title || doc.title, doc });
    } else {
      skipped.push(title || source.path || '未命名');
    }
    options.onProgress?.(i + 1, sources.length);
  }

  const multi = prepared.length > 1;
  const units: PreparedExportUnit[] = [];

  for (const item of prepared) {
    if (!multi) {
      units.push({ title: item.title, doc: item.doc });
      continue;
    }

    if (options.announceTitles) {
      const titleDoc = buildReadableDoc(`《${item.title}》`, {
        chunkChars: Math.max(120, Math.min(300, settings.chunkChars)),
        perSentence: false,
        title: item.title,
      });
      if (titleDoc.chunks.length) {
        units.push({ title: item.title, doc: titleDoc, isTitle: true });
      }
    } else {
      units.push({ title: item.title, doc: item.doc, chapterLabel: item.title });
      continue;
    }
    units.push({ title: item.title, doc: item.doc });
  }

  return { units, skipped };
}

export async function exportMergedAudio(
  app: App,
  units: PreparedExportUnit[],
  settings: MsTtsSettings,
  tts: TtsService,
  cache: AudioCache,
  options: MergedExportOptions,
): Promise<ExportResult> {
  if (!units.length) throw new Error('没有可导出的文本');
  assertExportable(settings, tts);

  const synthesized: Array<{ buffer: ArrayBuffer; format: 'mp3' | 'wav'; durationMs: number }> = [];
  const lyricLines: LyricLine[] = [];
  let cursorMs = 0;
  let done = 0;
  const total = units.reduce((sum, unit) => sum + unit.doc.chunks.length, 0);

  for (const unit of units) {
    if (unit.chapterLabel) {
      lyricLines.push({ timeMs: cursorMs, text: `【${cleanTitle(unit.chapterLabel)}】` });
    }
    let titleLineAdded = false;

    for (const chunk of unit.doc.chunks) {
      if (options.isCancelled?.()) throw new Error('导出已取消');

      const buffer = await synthesizeChunk(tts, cache, settings, chunk.text);
      const meta = inspectAudio(buffer);
      const fallback = estimateDurationMs(chunk.text, settings.rate);
      const durationMs =
        meta && Number.isFinite(meta.durationMs) && meta.durationMs > 0 ? meta.durationMs : fallback;
      const format: 'mp3' | 'wav' = meta?.format ?? (isRiffWave(buffer) ? 'wav' : 'mp3');

      if (unit.isTitle) {
        if (!titleLineAdded) {
          lyricLines.push({ timeMs: cursorMs, text: `【${cleanTitle(unit.title)}】` });
          titleLineAdded = true;
        }
      } else {
        appendChunkLyrics(lyricLines, chunk.sentences, chunk.text, cursorMs, durationMs);
      }

      synthesized.push({ buffer, format, durationMs });
      cursorMs += durationMs;
      done++;
      options.onProgress?.(done, total);
    }
  }

  if (!synthesized.length) throw new Error('没有可导出的音频');

  const formats = new Set(synthesized.map((item) => item.format));
  if (formats.size > 1) {
    throw new Error('本次导出返回了混合音频格式（MP3/WAV），无法合并，请重试或更换引擎');
  }

  const format = synthesized[0].format;
  const buffers = synthesized.map((item) => item.buffer);
  const audio = format === 'wav' ? concatWav(buffers) : concatMp3(buffers);

  const baseName = cleanTitle(options.fileName || deriveFileName(units));
  const lyrics = options.includeLyrics
    ? buildLrc(lyricLines, { title: baseName, lengthMs: cursorMs })
    : null;

  let audioData = audio;
  if (format === 'mp3' && options.embedLyrics && lyricLines.length) {
    const tag = buildId3Tag(lyricLines, { title: baseName, lengthMs: cursorMs });
    audioData = prependId3(audio, tag);
  }

  const saved = await saveExportFiles(app, baseName, audioData, format, lyrics, options.folder);

  return {
    audioPath: saved.audioPath,
    lyricsPath: saved.lyricsPath,
    lyricsError: saved.lyricsError,
    durationMs: cursorMs,
    size: audioData.byteLength,
    skipped: options.skipped ?? [],
  };
}

function appendChunkLyrics(
  target: LyricLine[],
  sentences: Sentence[],
  fallbackText: string,
  startMs: number,
  durationMs: number,
): void {
  if (!sentences.length) {
    target.push({ timeMs: startMs, text: fallbackText });
    return;
  }

  const weights = sentences.map((sentence) => Math.max(0.1, sentence.weight || 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let accumulated = 0;

  for (let i = 0; i < sentences.length; i++) {
    const offset = Math.round((durationMs * accumulated) / total);
    target.push({ timeMs: startMs + offset, text: sentences[i].text });
    accumulated += weights[i];
  }
}

async function synthesizeChunk(
  tts: TtsService,
  cache: AudioCache,
  settings: MsTtsSettings,
  text: string,
): Promise<ArrayBuffer> {
  const key = await tts.cacheKey(text);

  if (settings.cacheEnabled) {
    const hit = await cache.get(key);
    if (hit) return hit.arrayBuffer();
  }

  const buffer = await tts.synthesize(text);
  if (settings.cacheEnabled) {
    const type = isRiffWave(buffer) ? 'audio/wav' : 'audio/mpeg';
    await cache.put(key, new Blob([buffer], { type }));
  }
  return buffer;
}

function assertExportable(settings: MsTtsSettings, tts: TtsService): void {
  if (settings.provider === 'system') {
    throw new Error('Windows 系统语音不支持导出音频文件，请切换到 Edge / 豆包 / OpenAI 兼容语音');
  }
  if (!tts.isConfigured()) {
    throw new Error(`${tts.providerLabel()}尚未配置，无法导出`);
  }
}

function deriveFileName(units: PreparedExportUnit[]): string {
  const titles = units.filter((unit) => !unit.isTitle).map((unit) => unit.title);
  if (titles.length === 1) return titles[0];
  if (titles.length > 1) return `${titles[0]}等${titles.length}篇`;
  return units[0]?.title ?? '朗读音频';
}

function cleanTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim() || '未命名';
}

export function isRiffWave(buffer: ArrayBuffer): boolean {
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
  if (!buffers.length) throw new Error('音频数据为空');

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
  if (!buffers.length) throw new Error('音频数据为空');

  const infos = buffers.map((buffer) => {
    const info = parseWav(buffer);
    if (!info) throw new Error('音频数据不是受支持的 PCM WAV');
    return info;
  });

  const first = infos[0];
  for (const info of infos) {
    if (
      info.sampleRate !== first.sampleRate ||
      info.channels !== first.channels ||
      info.bitsPerSample !== first.bitsPerSample ||
      info.blockAlign !== first.blockAlign
    ) {
      throw new Error('各段 WAV 的采样率/声道/位深不一致，无法合并');
    }
  }

  const totalPcm = infos.reduce((sum, info) => sum + info.dataLength, 0);
  const out = new Uint8Array(44 + totalPcm);
  writeWavHeader(out, totalPcm, first.sampleRate, first.channels, first.bitsPerSample);

  let offset = 44;
  for (let i = 0; i < buffers.length; i++) {
    const pcm = new Uint8Array(buffers[i], infos[i].dataOffset, infos[i].dataLength);
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

interface SavedFiles {
  audioPath: string;
  lyricsPath: string | null;
  lyricsError?: string;
}

async function saveExportFiles(
  app: App,
  title: string,
  data: ArrayBuffer,
  extension: string,
  lyrics: string | null,
  folderOverride: string | undefined,
): Promise<SavedFiles> {
  const folder = folderOverride === undefined ? attachmentFolder(app) : normalizeFolder(folderOverride);
  if (folder) {
    try {
      if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    } catch {
      // 可能已由其他窗口创建
    }
  }

  const base = `${sanitizeFileName(title)}-朗读-${timestampSuffix()}`;
  const buildPath = (suffix: string, ext: string) =>
    folder ? `${folder}/${base}${suffix}.${ext}` : `${base}${suffix}.${ext}`;

  let suffix = '';
  let index = 2;
  while (true) {
    const audioPath = buildPath(suffix, extension);
    const lyricsPath = buildPath(suffix, 'lrc');
    if (!app.vault.getAbstractFileByPath(audioPath) && !app.vault.getAbstractFileByPath(lyricsPath)) {
      await app.vault.createBinary(audioPath, data);
      if (lyrics === null) return { audioPath, lyricsPath: null };

      const bytes = new TextEncoder().encode(lyrics);
      try {
        await app.vault.createBinary(lyricsPath, bytes.buffer as ArrayBuffer);
        return { audioPath, lyricsPath };
      } catch (error) {
        return {
          audioPath,
          lyricsPath: null,
          lyricsError: error instanceof Error ? error.message : String(error),
        };
      }
    }
    suffix = `-${index}`;
    index++;
  }
}

function attachmentFolder(app: App): string {
  const configured = (app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.(
    'attachmentFolderPath',
  );
  const folder = typeof configured === 'string' ? configured : '附件';
  return normalizeFolder(folder);
}

function normalizeFolder(value: string): string {
  const trimmed = (value || '').trim().replace(/\\/g, '/');
  if (!trimmed || trimmed === '/' || trimmed === '.') return '';
  const parts = trimmed
    .replace(/^\.\//, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..');
  return parts.join('/');
}
