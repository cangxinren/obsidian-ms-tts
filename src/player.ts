import type {
  MsTtsSettings,
  PlayerSnapshot,
  PlayerState,
  ProviderId,
  ReadableDoc,
  Sentence,
} from './types';
import type { TtsService } from './tts-service';
import type { AudioCache } from './cache';
import { TtsError, describeError } from './errors';
import { SystemTts } from './system-tts';
import { clamp } from './util';

export interface PlayerDeps {
  settings: () => MsTtsSettings;
  tts: TtsService;
  cache: AudioCache;
}

type EmitterMap = {
  snapshot: (snapshot: PlayerSnapshot) => void;
  sentence: (sentence: Sentence | null) => void;
  notice: (message: string) => void;
  error: (error: Error) => void;
};

class Emitter {
  private listeners = new Map<string, Set<(value: unknown) => void>>();

  on<K extends keyof EmitterMap>(event: K, callback: EmitterMap[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback as (value: unknown) => void);
    return () => this.off(event, callback);
  }

  off<K extends keyof EmitterMap>(event: K, callback: EmitterMap[K]): void {
    this.listeners.get(event)?.delete(callback as (value: unknown) => void);
  }

  emit<K extends keyof EmitterMap>(event: K, value: Parameters<EmitterMap[K]>[0]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const callback of set) {
      try {
        (callback as (value: unknown) => void)(value);
      } catch (error) {
        console.error(`[ms-tts] listener error on ${event}`, error);
      }
    }
  }
}

export class Player {
  private readonly emitter = new Emitter();
  private readonly audio: HTMLAudioElement;
  private readonly system = new SystemTts();

  private state: PlayerState = 'idle';
  private doc: ReadableDoc | null = null;
  private chunkIndex = 0;
  private sentenceIndex = 0;
  private gen = 0;
  private currentUrl: string | null = null;
  private timer: number | null = null;
  private blobCache = new Map<number, Promise<Blob>>();
  private playResolve: (() => void) | null = null;
  private cacheHits = 0;
  private requests = 0;
  private usingSystem = false;
  private errorMessage: string | undefined;
  private onDocEnded: (() => boolean | Promise<boolean>) | null = null;

  constructor(private readonly deps: PlayerDeps) {
    this.audio = new Audio();
    this.audio.preload = 'auto';
  }

  on<K extends keyof EmitterMap>(event: K, callback: EmitterMap[K]): () => void {
    return this.emitter.on(event, callback);
  }

  /** 文档自然播完时回调；返回 true 表示已由外部接管（例如播放列表续播），不再进入 idle。 */
  setDocEndHandler(handler: (() => boolean | Promise<boolean>) | null): void {
    this.onDocEnded = handler;
  }

  getSnapshot(): PlayerSnapshot {
    const chunk = this.doc?.chunks[this.chunkIndex];
    const sentence = chunk?.sentences[this.sentenceIndex];
    const duration = this.audio.duration;
    return {
      state: this.state,
      title: this.doc?.title ?? '',
      chunkIndex: this.chunkIndex,
      chunkCount: this.doc?.chunks.length ?? 0,
      sentenceIndex: this.sentenceIndex,
      sentenceText: sentence?.text ?? '',
      progress: duration && isFinite(duration) ? clamp(this.audio.currentTime / duration, 0, 1) : 0,
      cacheHits: this.cacheHits,
      requests: this.requests,
      provider: this.currentProvider(),
      error: this.errorMessage,
    };
  }

  async playDoc(doc: ReadableDoc, startChunk = 0): Promise<void> {
    if (!doc.chunks.length) {
      this.emitter.emit('notice', '没有可朗读的文本');
      return;
    }

    this.stopInternal();
    const myGen = ++this.gen;

    this.doc = doc;
    this.chunkIndex = clamp(startChunk, 0, doc.chunks.length - 1);
    this.sentenceIndex = 0;
    this.cacheHits = 0;
    this.requests = 0;
    this.errorMessage = undefined;
    this.blobCache.clear();
    this.usingSystem = false;

    const settings = this.deps.settings();
    let useSystem = settings.provider === 'system';

    if (!useSystem && !this.deps.tts.isConfigured()) {
      if (settings.autoFallbackSystem && SystemTts.isAvailable()) {
        useSystem = true;
        this.emitter.emit(
          'notice',
          `${this.deps.tts.providerLabel()}当前不可用，已改用 Windows 系统语音`,
        );
      } else {
        this.fail(
          new TtsError('config', `${this.deps.tts.providerLabel()}当前不可用，请检查设置`),
          myGen,
        );
        return;
      }
    }

    this.usingSystem = useSystem;
    if (useSystem) {
      await this.runSystem(myGen);
    } else {
      await this.runProvider(myGen);
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    if (this.usingSystem) this.system.pause();
    else this.audio.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    if (this.usingSystem) {
      this.system.resume();
      this.setState('playing');
      return;
    }
    void this.audio.play().then(
      () => this.setState('playing'),
      (error) => this.fail(new TtsError('playback', `无法继续播放：${describeError(error)}`), this.gen),
    );
  }

  stop(): void {
    this.stopInternal();
    this.doc = null;
    this.chunkIndex = 0;
    this.sentenceIndex = 0;
    this.errorMessage = undefined;
    this.state = 'stopped';
    this.emitter.emit('sentence', null);
    this.emitSnapshot();
  }

  next(): void {
    this.jump(1);
  }

  prev(): void {
    this.jump(-1);
  }

  dispose(): void {
    this.stop();
  }

  private jump(delta: number): void {
    if (!this.doc) return;
    const target = clamp(this.chunkIndex + delta, 0, this.doc.chunks.length - 1);
    if (target === this.chunkIndex) return;
    void this.playDoc(this.doc, target);
  }

  private async runProvider(myGen: number): Promise<void> {
    try {
      while (this.gen === myGen && this.chunkIndex < (this.doc?.chunks.length ?? 0)) {
        const chunk = this.doc!.chunks[this.chunkIndex];
        this.sentenceIndex = 0;
        this.setState('loading', myGen);
        this.emitter.emit('sentence', chunk.sentences[0] ?? null);

        const blob = await this.getBlob(this.chunkIndex);
        if (this.gen !== myGen) return;

        await this.playBlob(blob, myGen);
        if (this.gen !== myGen) return;

        this.advance();
      }
      if (this.gen === myGen) await this.finish(myGen);
    } catch (error) {
      if (this.gen !== myGen) return;
      const ttsError = error instanceof TtsError ? error : new TtsError('unknown', describeError(error));
      const canFallback =
        ['network', 'config', 'auth', 'forbidden'].includes(ttsError.kind) &&
        this.deps.settings().autoFallbackSystem &&
        SystemTts.isAvailable();

      if (canFallback) {
        this.emitter.emit('notice', `${ttsError.message}，已改用 Windows 系统语音`);
        this.usingSystem = true;
        await this.runSystem(myGen);
        return;
      }
      this.fail(ttsError, myGen);
    }
  }

  private async runSystem(myGen: number): Promise<void> {
    try {
      this.setState('playing', myGen);
      while (this.gen === myGen && this.chunkIndex < (this.doc?.chunks.length ?? 0)) {
        const chunk = this.doc!.chunks[this.chunkIndex];
        this.sentenceIndex = 0;
        this.emitter.emit('sentence', chunk.sentences[0] ?? null);

        const settings = this.deps.settings();
        await this.system.speakChunk(chunk.sentences, {
          voiceURI: settings.systemVoiceURI,
          rate: settings.systemRate,
          pitch: settings.systemPitch,
          volume: 1,
          onSentence: (index) => {
            if (this.gen !== myGen) return;
            this.sentenceIndex = index;
            this.emitter.emit('sentence', chunk.sentences[index] ?? null);
            this.emitSnapshot();
          },
        });

        if (this.gen !== myGen) return;
        this.advance();
      }
      if (this.gen === myGen) await this.finish(myGen);
    } catch (error) {
      if (this.gen !== myGen) return;
      this.fail(new TtsError('playback', describeError(error)), myGen);
    }
  }

  private getBlob(index: number): Promise<Blob> {
    const cached = this.blobCache.get(index);
    if (cached) return cached;

    const promise = this.synthesizeChunk(index).catch((error) => {
      this.blobCache.delete(index);
      throw error;
    });
    this.blobCache.set(index, promise);

    for (const key of Array.from(this.blobCache.keys())) {
      if (key < index - 1) this.blobCache.delete(key);
    }

    const chunkCount = this.doc?.chunks.length ?? 0;
    if (this.deps.settings().prefetch && index + 1 < chunkCount && !this.blobCache.has(index + 1)) {
      const next = this.synthesizeChunk(index + 1).catch((error) => {
        this.blobCache.delete(index + 1);
        throw error;
      });
      next.catch(() => undefined);
      this.blobCache.set(index + 1, next);
    }

    return promise;
  }

  private async synthesizeChunk(index: number): Promise<Blob> {
    const settings = this.deps.settings();
    const chunk = this.doc!.chunks[index];
    const key = await this.deps.tts.cacheKey(chunk.text);

    if (settings.cacheEnabled) {
      const hit = await this.deps.cache.get(key);
      if (hit) {
        this.cacheHits++;
        this.emitSnapshot();
        return hit;
      }
    }

    const buffer = await this.deps.tts.synthesize(chunk.text);
    this.requests++;

    const header = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4));
    const isWav =
      header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46;
    const blob = new Blob([buffer], { type: isWav ? 'audio/wav' : 'audio/mpeg' });
    if (settings.cacheEnabled) await this.deps.cache.put(key, blob);
    this.emitSnapshot();
    return blob;
  }

  private playBlob(blob: Blob, myGen: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      this.revokeCurrentUrl();
      this.currentUrl = url;
      this.audio.src = url;

      this.playResolve = resolve;

      this.audio.onended = () => {
        this.clearAudioHandlers();
        this.playResolve = null;
        resolve();
      };
      this.audio.onerror = () => {
        this.clearAudioHandlers();
        this.playResolve = null;
        reject(new TtsError('playback', '音频播放失败'));
      };

      this.startSentenceTimer(myGen);

      this.audio.play().then(
        () => {
          if (this.gen !== myGen) {
            this.audio.pause();
            this.playResolve = null;
            resolve();
            return;
          }
          this.setState('playing', myGen);
        },
        (error) => {
          this.clearAudioHandlers();
          this.playResolve = null;
          reject(new TtsError('playback', `无法播放音频：${describeError(error)}`));
        },
      );
    });
  }

  private startSentenceTimer(myGen: number): void {
    this.stopSentenceTimer();
    const chunk = this.doc?.chunks[this.chunkIndex];
    if (!chunk) return;

    const weights = chunk.sentences.map((sentence) => sentence.weight);
    const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;

    this.timer = window.setInterval(() => {
      if (this.gen !== myGen) return;
      const duration = this.audio.duration;
      if (!duration || !isFinite(duration)) return;

      const ratio = clamp(this.audio.currentTime / duration, 0, 1);
      let accumulated = 0;
      let index = chunk.sentences.length - 1;
      for (let i = 0; i < weights.length; i++) {
        accumulated += weights[i] / total;
        if (ratio <= accumulated + 1e-6) {
          index = i;
          break;
        }
      }

      if (index !== this.sentenceIndex) {
        this.sentenceIndex = index;
        this.emitter.emit('sentence', chunk.sentences[index] ?? null);
      }
      this.emitSnapshot();
    }, 120);
  }

  private stopSentenceTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private advance(): void {
    this.stopSentenceTimer();
    this.chunkIndex++;
    this.sentenceIndex = 0;
    const nextChunk = this.doc?.chunks[this.chunkIndex];
    if (nextChunk) this.emitter.emit('sentence', nextChunk.sentences[0] ?? null);
  }

  private async finish(myGen: number): Promise<void> {
    if (this.gen !== myGen) return;
    this.stopInternal();

    if (this.onDocEnded) {
      // 补间期先显示 loading，避免用户误点暂停或看到旧标题仍为“正在播放”
      this.setState('loading');
      let handled = false;
      try {
        handled = await this.onDocEnded();
      } catch (error) {
        this.emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
        handled = false;
      }
      if (handled) return;
    }

    // 等待续播期间用户可能已经 stop() 或开始新的朗读，此时不要覆盖最新状态
    if (this.gen !== myGen + 1) return;

    this.state = 'idle';
    this.emitter.emit('sentence', null);
    this.emitSnapshot();
  }

  private fail(error: Error, myGen: number): void {
    if (this.gen !== myGen) return;
    this.stopInternal();
    this.errorMessage = error instanceof TtsError ? error.message : describeError(error);
    this.state = 'error';
    this.emitter.emit('sentence', null);
    this.emitter.emit('error', error);
    this.emitSnapshot();
  }

  private stopInternal(): void {
    this.gen++;
    this.stopSentenceTimer();
    this.clearAudioHandlers();
    const pending = this.playResolve;
    this.playResolve = null;
    pending?.();
    this.audio.pause();
    this.audio.removeAttribute('src');
    try {
      this.audio.load();
    } catch {
      // ignore
    }
    this.revokeCurrentUrl();
    this.system.stop();
    this.blobCache.clear();
    this.usingSystem = false;
  }

  private clearAudioHandlers(): void {
    this.audio.onended = null;
    this.audio.onerror = null;
  }

  private revokeCurrentUrl(): void {
    if (!this.currentUrl) return;
    try {
      URL.revokeObjectURL(this.currentUrl);
    } catch {
      // ignore
    }
    this.currentUrl = null;
  }

  private setState(state: PlayerState, myGen?: number): void {
    if (myGen !== undefined && this.gen !== myGen) return;
    this.state = state;
    this.emitSnapshot();
  }

  private currentProvider(): ProviderId {
    return this.usingSystem ? 'system' : this.deps.settings().provider;
  }

  private emitSnapshot(): void {
    this.emitter.emit('snapshot', this.getSnapshot());
  }
}
