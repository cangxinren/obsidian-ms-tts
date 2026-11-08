import { Platform } from 'obsidian';
import type { MsTtsSettings, ProviderId, SecretName, VoiceOption } from './types';
import { EdgeProvider } from './providers/edge';
import { DoubaoProvider } from './providers/doubao';
import { OpenAiProvider } from './providers/openai';
import { RateLimiter } from './rate-limiter';
import { SystemTts } from './system-tts';
import { DOUBAO_VOICES, EDGE_FALLBACK_VOICES, EDGE_NAMES, openAiVoiceOptions } from './voices';
import { TtsError } from './errors';
import { hashText } from './util';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  edge: '微软 Edge 免费语音',
  doubao: '豆包语音',
  openai: 'OpenAI 兼容语音',
  system: 'Windows 系统语音',
};

export class TtsService {
  private readonly limiter = new RateLimiter({ perMinute: 25, minIntervalMs: 1200 });
  private readonly edge: EdgeProvider;
  private readonly doubao: DoubaoProvider;
  private readonly openai: OpenAiProvider;
  private limiterProvider: ProviderId | null = null;

  constructor(
    private readonly getSettings: () => MsTtsSettings,
    private readonly getSecret: (name: SecretName) => string,
  ) {
    this.edge = new EdgeProvider(getSettings, this.limiter);
    this.doubao = new DoubaoProvider(getSettings, () => this.getSecret('doubao'), this.limiter);
    this.openai = new OpenAiProvider(getSettings, () => this.getSecret('openai'), this.limiter);
  }

  provider(): ProviderId {
    return this.getSettings().provider;
  }

  providerLabel(provider: ProviderId = this.provider()): string {
    return PROVIDER_LABELS[provider];
  }

  isSystem(): boolean {
    return this.provider() === 'system';
  }

  isConfigured(): boolean {
    const settings = this.getSettings();
    switch (settings.provider) {
      case 'edge':
        return Platform.isDesktopApp && !!settings.edgeVoice;
      case 'doubao':
        return (
          !!settings.doubaoAppId.trim() &&
          !!this.getSecret('doubao').trim() &&
          !!settings.doubaoVoice
        );
      case 'openai':
        return (
          !!this.getSecret('openai').trim() &&
          !!settings.openaiBaseUrl.trim() &&
          !!settings.openaiModel.trim() &&
          !!settings.openaiVoice.trim()
        );
      case 'system':
        return SystemTts.isAvailable();
    }
  }

  async listVoices(): Promise<VoiceOption[]> {
    switch (this.provider()) {
      case 'edge':
        return this.edge.listVoices();
      case 'doubao':
        return this.doubao.listVoices();
      case 'openai':
        return this.openai.listVoices();
      case 'system':
        return [];
    }
  }

  fallbackVoices(): VoiceOption[] {
    switch (this.provider()) {
      case 'edge':
        return EDGE_FALLBACK_VOICES;
      case 'doubao':
        return DOUBAO_VOICES;
      case 'openai':
        return openAiVoiceOptions(this.getSettings().openaiModel);
      case 'system':
        return [];
    }
  }

  async synthesize(text: string): Promise<ArrayBuffer> {
    this.syncLimiter();
    switch (this.provider()) {
      case 'edge':
        return this.edge.synthesize(text);
      case 'doubao':
        return this.doubao.synthesize(text);
      case 'openai':
        return this.openai.synthesize(text);
      case 'system':
        throw new TtsError('config', '系统语音不通过 TTS 服务合成');
    }
  }

  async cacheKey(text: string): Promise<string> {
    const settings = this.getSettings();
    const parts: Array<string | number> = [settings.provider, text];

    switch (settings.provider) {
      case 'edge':
        parts.push(settings.edgeVoice, settings.rate, settings.pitch, settings.volume);
        break;
      case 'doubao':
        parts.push(settings.doubaoVoice, settings.doubaoCluster, settings.rate, settings.volume);
        break;
      case 'openai':
        parts.push(settings.openaiBaseUrl, settings.openaiModel, settings.openaiVoice, settings.rate);
        break;
      case 'system':
        parts.push(settings.systemVoiceURI, settings.systemRate, settings.systemPitch);
        break;
    }

    return hashText(parts.join('|'));
  }

  describeVoice(): string {
    const settings = this.getSettings();
    const rate = `${settings.rate.toFixed(2)}x`;

    switch (settings.provider) {
      case 'edge': {
        const name = EDGE_NAMES[settings.edgeVoice] ?? settings.edgeVoice;
        const pitch = `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}st`;
        return `${name} · ${rate} · ${pitch}`;
      }
      case 'doubao': {
        const voice = DOUBAO_VOICES.find((item) => item.id === settings.doubaoVoice);
        return `${voice?.name ?? settings.doubaoVoice} · ${rate}`;
      }
      case 'openai': {
        const short = settings.openaiVoice.split(':').pop() ?? settings.openaiVoice;
        return `${short} · ${settings.openaiModel} · ${rate}`;
      }
      case 'system':
        return 'Windows 系统语音';
    }
  }

  private syncLimiter(): void {
    const provider = this.provider();
    if (provider === this.limiterProvider) return;
    this.limiterProvider = provider;

    if (provider === 'edge') {
      this.limiter.configure({ perMinute: 25, minIntervalMs: 1200 });
    } else if (provider === 'doubao') {
      this.limiter.configure({ perMinute: 55, minIntervalMs: 250 });
    } else {
      this.limiter.configure({ perMinute: 60, minIntervalMs: 200 });
    }
  }
}
