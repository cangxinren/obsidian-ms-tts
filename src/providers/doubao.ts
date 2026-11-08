import { requestUrl } from 'obsidian';
import type { MsTtsSettings, VoiceOption } from '../types';
import { TtsError, errorFromStatus } from '../errors';
import { DOUBAO_VOICES } from '../voices';
import type { RateLimiter } from '../rate-limiter';
import { base64ToArrayBuffer, clamp, concatArrayBuffers, randomUuid, splitTextForBytes } from '../util';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v1/tts';

export class DoubaoProvider {
  constructor(
    private readonly getSettings: () => MsTtsSettings,
    private readonly getToken: () => string,
    private readonly limiter: RateLimiter,
  ) {}

  listVoices(): VoiceOption[] {
    return DOUBAO_VOICES;
  }

  async synthesize(text: string): Promise<ArrayBuffer> {
    const settings = this.getSettings();
    const appId = settings.doubaoAppId.trim();
    const token = this.getToken().trim();

    if (!appId) throw new TtsError('config', '请先填写火山引擎 AppID');
    if (!token) throw new TtsError('config', '请先填写火山引擎 Access Token');

    const pieces = splitTextForBytes(text, 900);
    const buffers: ArrayBuffer[] = [];

    for (const piece of pieces) {
      await this.limiter.acquire();
      buffers.push(await this.request(piece, settings, appId, token));
    }

    return concatArrayBuffers(buffers);
  }

  private async request(
    text: string,
    settings: MsTtsSettings,
    appId: string,
    token: string,
  ): Promise<ArrayBuffer> {
    const body = {
      app: {
        appid: appId,
        token: 'obsidian',
        cluster: settings.doubaoCluster.trim() || 'volcano_tts',
      },
      user: { uid: 'obsidian' },
      audio: {
        voice_type: settings.doubaoVoice || 'BV011_streaming',
        encoding: 'mp3',
        speed_ratio: clamp(settings.rate, 0.1, 2),
        loudness_ratio: clamp(settings.volume / 100, 0.5, 2),
        rate: 24000,
      },
      request: {
        reqid: randomUuid(),
        text,
        operation: 'query',
      },
    };

    let response;
    try {
      response = await requestUrl({
        url: ENDPOINT,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer;${token}`,
        },
        body: JSON.stringify(body),
        throw: false,
      });
    } catch (error) {
      throw new TtsError('network', `无法连接豆包语音：${errorMessage(error)}`);
    }

    if (response.status !== 200) {
      if (response.status === 429) this.limiter.noteCooldown(5000);
      throw errorFromStatus(response.status, response.text);
    }

    let json: { code?: number; message?: string; data?: string };
    try {
      json = response.json as typeof json;
    } catch {
      throw new TtsError('unknown', '豆包返回了非 JSON 响应');
    }

    if (json.code !== 3000) {
      throw mapDoubaoError(json.code ?? -1, json.message ?? '');
    }
    if (typeof json.data !== 'string' || !json.data) {
      throw new TtsError('server', '豆包未返回音频数据');
    }

    return base64ToArrayBuffer(json.data);
  }
}

function mapDoubaoError(code: number, message: string): TtsError {
  const detail = `${code}${message ? `：${message}` : ''}`;
  if (code === 3003 || code === 3005) {
    return new TtsError('rate-limit', `豆包服务繁忙或并发超限（${detail}）`);
  }
  if (code === 3030) {
    return new TtsError('server', `豆包合成超时（${detail}）`);
  }
  if (code === 3001 || code === 3010 || code === 3011 || code === 3050) {
    return new TtsError('bad-request', `豆包参数或音色不可用（${detail}）`);
  }
  if (/authenticate|access denied|quota|grant not found|鉴权|额度/i.test(message)) {
    return new TtsError('auth', `豆包鉴权失败或额度不足（${detail}）`);
  }
  return new TtsError('unknown', `豆包返回错误（${detail}）`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
