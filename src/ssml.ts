export interface SpeechSsmlOptions {
  text: string;
  voice: string;
  /** 例如 "+10%"、"-50%" */
  rate: string;
  /** 例如 "+2st"、"+50Hz" */
  pitch: string;
  /** 例如 "+0%"、"-50%" */
  volume: string;
}

export function xmlEscape(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 从语音 ShortName 推导 locale，例如 zh-CN-XiaoxiaoNeural -> zh-CN */
export function voiceLocale(voice: string): string {
  const parts = voice.split('-');
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return 'zh-CN';
}

export function buildSSML(options: SpeechSsmlOptions): string {
  const locale = voiceLocale(options.voice);
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}">` +
    `<voice name="${xmlEscape(options.voice)}">` +
    `<prosody rate="${options.rate}" pitch="${options.pitch}" volume="${options.volume}">` +
    `${xmlEscape(options.text)}` +
    `</prosody></voice></speak>`
  );
}
