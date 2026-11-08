import type { Sentence } from './types';
import { clamp } from './util';

export interface SystemSpeakOptions {
  voiceURI: string;
  rate: number;
  pitch: number;
  volume: number;
  onSentence?: (index: number) => void;
}

export class SystemTts {
  private readonly synth: SpeechSynthesis | undefined =
    typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  private token = 0;

  static isAvailable(): boolean {
    return typeof window !== 'undefined' && !!window.speechSynthesis;
  }

  voices(): SpeechSynthesisVoice[] {
    try {
      return this.synth?.getVoices() ?? [];
    } catch {
      return [];
    }
  }

  async speakChunk(sentences: Sentence[], options: SystemSpeakOptions): Promise<void> {
    if (!this.synth) throw new Error('当前环境不支持系统语音');
    const myToken = ++this.token;
    this.synth.cancel();

    for (let i = 0; i < sentences.length; i++) {
      if (myToken !== this.token) return;
      options.onSentence?.(i);
      for (const piece of splitForSpeech(sentences[i].text, 200)) {
        if (myToken !== this.token) return;
        await this.speakOne(piece, options);
      }
    }
  }

  pause(): void {
    try {
      this.synth?.pause();
    } catch {
      // 部分平台不支持暂停
    }
  }

  resume(): void {
    try {
      this.synth?.resume();
    } catch {
      // ignore
    }
  }

  stop(): void {
    this.token++;
    try {
      this.synth?.cancel();
    } catch {
      // ignore
    }
  }

  private speakOne(text: string, options: SystemSpeakOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = this.voices().find((item) => item.voiceURI === options.voiceURI);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || 'zh-CN';
      utterance.rate = clamp(options.rate, 0.1, 10);
      utterance.pitch = clamp(1 + options.pitch / 24, 0.1, 2);
      utterance.volume = clamp(options.volume, 0, 1);

      utterance.onend = () => resolve();
      utterance.onerror = (event) => {
        const code = (event as SpeechSynthesisErrorEvent).error;
        if (code === 'interrupted' || code === 'canceled') resolve();
        else reject(new Error(`系统语音合成失败：${code}`));
      };

      this.synth!.speak(utterance);
    });
  }
}

function splitForSpeech(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = Math.max(
      rest.lastIndexOf('，', max),
      rest.lastIndexOf(',', max),
      rest.lastIndexOf('。', max),
      rest.lastIndexOf(' ', max),
    );
    if (cut < max * 0.4) cut = max;
    pieces.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) pieces.push(rest);
  return pieces;
}
