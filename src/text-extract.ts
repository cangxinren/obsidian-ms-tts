import type { Chunk, ReadableDoc, Sentence } from './types';
import { charWeight, mergeShortParts, splitLongPart, splitSentences } from './segmenter';

export interface ReadableDocOptions {
  chunkChars: number;
  perSentence: boolean;
  baseOffset?: number;
  title?: string;
}

interface Segment {
  text: string;
  srcStart: number;
  srcEnd: number;
}

export function buildReadableDoc(markdown: string, opts: ReadableDocOptions): ReadableDoc {
  const base = opts.baseOffset ?? 0;
  const maxChars = Math.max(120, Math.min(800, opts.chunkChars || 350));
  const segments = extractSegments(markdown);
  const sentences: Sentence[] = [];

  for (const segment of segments) {
    const parts = mergeShortParts(splitSentences(segment.text));
    for (const part of parts) {
      for (const piece of splitLongPart(part, maxChars)) {
        const ratioStart = segment.text.length ? piece.start / segment.text.length : 0;
        const ratioEnd = segment.text.length ? piece.end / segment.text.length : 1;
        const srcStart = base + segment.srcStart + Math.floor(ratioStart * (segment.srcEnd - segment.srcStart));
        const srcEnd = base + segment.srcStart + Math.ceil(ratioEnd * (segment.srcEnd - segment.srcStart));
        sentences.push({
          text: piece.text,
          srcStart,
          srcEnd: Math.max(srcStart, srcEnd),
          weight: charWeight(piece.text),
        });
      }
    }
  }

  const chunks = buildChunks(sentences, opts.perSentence, maxChars);
  const totalChars = sentences.reduce((sum, sentence) => sum + sentence.text.length, 0);

  return {
    title: opts.title ?? '未命名',
    chunks,
    totalChars,
  };
}

function buildChunks(sentences: Sentence[], perSentence: boolean, maxChars: number): Chunk[] {
  if (!sentences.length) return [];

  if (perSentence) {
    return sentences.map((sentence) => ({
      text: sentence.text,
      sentences: [sentence],
      srcStart: sentence.srcStart,
      srcEnd: sentence.srcEnd,
    }));
  }

  const chunks: Chunk[] = [];
  let current: Sentence[] = [];
  let length = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      text: joinSentences(current),
      sentences: current,
      srcStart: current[0].srcStart,
      srcEnd: current[current.length - 1].srcEnd,
    });
    current = [];
    length = 0;
  };

  for (const sentence of sentences) {
    if (length > 0 && length + sentence.text.length > maxChars) flush();
    current.push(sentence);
    length += sentence.text.length + 1;
  }
  flush();
  return chunks;
}

function joinSentences(sentences: Sentence[]): string {
  return sentences
    .map((sentence) => sentence.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSegments(markdown: string): Segment[] {
  const lines = markdown.split('\n');
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  let startLine = 0;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < Math.min(lines.length, 200); i++) {
      const trimmed = lines[i].trim();
      if (trimmed === '---' || trimmed === '...') {
        startLine = i + 1;
        break;
      }
    }
  }

  const segments: Segment[] = [];
  let inFence = false;
  let fenceChar = '';
  let inComment = false;

  for (let i = startLine; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (inComment) {
      if (trimmed.includes('-->')) inComment = false;
      continue;
    }

    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      continue;
    }
    if (inFence) continue;

    if (!trimmed) continue;
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inComment = true;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(trimmed)) continue;
    if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(trimmed) && trimmed.includes('-')) continue;
    if (/^\[\^[^\]]+\]:/.test(trimmed)) continue;
    if (/^!\[\[[^\]]*\]\]$/.test(trimmed)) continue;
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(trimmed)) continue;

    const text = cleanInline(raw);
    if (!text) continue;

    const leading = raw.length - raw.trimStart().length;
    segments.push({
      text,
      srcStart: lineStarts[i] + leading,
      srcEnd: lineStarts[i] + raw.trimEnd().length,
    });
  }

  return segments;
}

function cleanInline(raw: string): string {
  let text = raw;

  text = text.replace(/%%[\s\S]*?%%/g, '');
  text = text.replace(/<!--.*?-->/g, '');
  text = text.replace(/<[^>]*>/g, '');
  text = text.replace(/!\[\[[^\]]*\]\]/g, '');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
    const target = inner.split('|')[0].trim();
    const base = target.split('/').pop() ?? target;
    return base.replace(/\.md$/i, '');
  });
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/<https?:\/\/[^>]+>/g, '');
  text = text.replace(/`+([^`]*)`+/g, '');
  text = text.replace(/\$\$[\s\S]*?\$\$/g, '');
  text = text.replace(/\$[^$\n]+\$/g, '');
  text = text.replace(/\[\^[^\]]+\]/g, '');

  text = text.replace(/^\s*>\s*\[![^\]]+\]\s*/, '');
  text = text.replace(/^\s*>+\s?/, '');
  text = text.replace(/^\s*#{1,6}\s+/, '');
  text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
  text = text.replace(/^\[[ xX]\]\s*/, '');

  text = text.replace(/(\*\*\*|\*\*|\*|___|__|~~|==)/g, '');
  text = text.replace(/(^|\s)#[\w㐀-鿿/-]+/g, ' ');
  text = text.replace(/\|/g, ' ');
  text = text.replace(/[​﻿]/g, '');
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}
