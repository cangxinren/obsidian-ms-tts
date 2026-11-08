const CJK_RE = /[㐀-鿿豈-﫿]/;

export interface TextPart {
  text: string;
  /** 相对于所在清理后文本的起始偏移 */
  start: number;
  /** 相对于所在清理后文本的结束偏移 */
  end: number;
}

/** 估算朗读时长用的字符权重：中文 1，拉丁字符 0.45，标点略加权 */
export function charWeight(text: string): number {
  let weight = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) weight += 1;
    else if (/[A-Za-z0-9]/.test(ch)) weight += 0.45;
    else if (/\s/.test(ch)) weight += 0.05;
    else if (/[，,、：:]/.test(ch)) weight += 0.6;
    else weight += 0.5;
  }
  return Math.max(0.5, weight);
}

/** 按中文/英文句末标点与换行切句，保留句末标点 */
export function splitSentences(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let start = 0;

  const push = (end: number) => {
    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed) {
      const leading = raw.length - raw.trimStart().length;
      parts.push({
        text: trimmed,
        start: start + leading,
        end: start + leading + trimmed.length,
      });
    }
    start = end;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if ('。！？!?；;'.includes(ch)) {
      let j = i + 1;
      while (j < text.length && '”’」』）)]】》'.includes(text[j])) j++;
      push(j);
      i = j - 1;
    } else if (ch === '\n') {
      push(i + 1);
    } else if (ch === '.' && (next === undefined || /\s/.test(next)) && i > start + 1) {
      push(i + 1);
    }
  }
  push(text.length);
  return parts;
}

/** 合并过短的句子，避免逐句高亮时频繁闪动 */
export function mergeShortParts(parts: TextPart[], minLen = 8, maxLen = 120): TextPart[] {
  const out: TextPart[] = [];
  let buffer: TextPart | null = null;

  for (const part of parts) {
    if (!buffer) {
      buffer = { ...part };
      continue;
    }
    const canMerge = buffer.text.length < minLen || part.text.length < minLen;
    if (canMerge && buffer.text.length + part.text.length + 1 <= maxLen) {
      buffer.text = `${buffer.text}${needsSpace(buffer.text, part.text) ? ' ' : ''}${part.text}`;
      buffer.end = part.end;
    } else {
      out.push(buffer);
      buffer = { ...part };
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

/** 在逗号/空格处切分超长句，保证单块不超过接口限制 */
export function splitLongPart(part: TextPart, maxLen: number): TextPart[] {
  if (part.text.length <= maxLen) return [part];

  const out: TextPart[] = [];
  const text = part.text;
  let cursor = 0;

  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + maxLen);
    if (end < text.length) {
      const windowText = text.slice(cursor, end);
      const index = Math.max(
        windowText.lastIndexOf('，'),
        windowText.lastIndexOf(','),
        windowText.lastIndexOf('、'),
        windowText.lastIndexOf(' '),
      );
      if (index > maxLen * 0.5) end = cursor + index + 1;
    }
    const slice = text.slice(cursor, end);
    const trimmed = slice.trim();
    if (trimmed) {
      const leading = slice.length - slice.trimStart().length;
      out.push({
        text: trimmed,
        start: part.start + cursor + leading,
        end: part.start + cursor + leading + trimmed.length,
      });
    }
    cursor = end;
  }
  return out;
}

function needsSpace(a: string, b: string): boolean {
  if (!a || !b) return false;
  return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
}
