import { requestUrl } from 'obsidian';
import type { MsTtsSettings, VoiceOption } from '../types';
import { TtsError, errorFromStatus } from '../errors';
import { openAiVoiceOptions } from '../voices';
import type { RateLimiter } from '../rate-limiter';
import { clamp } from '../util';

export class OpenAiProvider {
  constructor(
    private readonly getSettings: () => MsTtsSettings,
    private readonly getKey: () => string,
    private readonly limiter: RateLimiter,
  ) {}

  listVoices(): VoiceOption[] {
    return openAiVoiceOptions(this.getSettings().openaiModel);
  }

  async synthesize(text: string): Promise<ArrayBuffer> {
    const settings = this.getSettings();
    const key = this.getKey().trim();
    if (!key) throw new TtsError('config', '请先填写 OpenAI 兼容接口的 API Key');

    const baseUrl = normalizeBaseUrl(settings.openaiBaseUrl);
    const voice = settings.openaiVoice.trim();
    const model = settings.openaiModel.trim();
    if (!model) throw new TtsError('config', '请先填写语音模型');
    if (!voice) throw new TtsError('config', '请先填写或选择语音');

    await this.limiter.acquire();

    let response;
    try {
      response = await requestUrl({
        url: `${baseUrl}/audio/speech`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          response_format: 'mp3',
          speed: clamp(settings.rate, 0.25, 4),
          stream: false,
        }),
        throw: false,
      });
    } catch (error) {
      throw new TtsError('network', `无法连接语音接口：${errorMessage(error)}`);
    }

    if (response.status !== 200) {
      if (response.status === 429) this.limiter.noteCooldown(5000);
      throw errorFromStatus(response.status, response.text);
    }

    const contentType = headerValue(response.headers, 'content-type');
    if (contentType.includes('application/json')) {
      throw new TtsError('bad-request', `语音接口返回错误：${response.text.slice(0, 200)}`);
    }
    if (!response.arrayBuffer || response.arrayBuffer.byteLength === 0) {
      throw new TtsError('server', '语音接口返回了空音频');
    }

    return response.arrayBuffer;
  }
}

function normalizeBaseUrl(value: string): string {
  let base = (value || '').trim();
  if (!base) throw new TtsError('config', '请先填写接口 Base URL');
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, '');
}

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return '';
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? headers[key] : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
