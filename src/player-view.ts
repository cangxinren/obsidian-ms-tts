import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type { Player } from './player';
import type { PlayerSnapshot } from './types';
import type MsTtsPlugin from './main';

export const VIEW_TYPE_MS_TTS_PLAYER = 'ms-tts-player';

export class PlayerView extends ItemView {
  private unsubscribers: Array<() => void> = [];
  private titleEl!: HTMLElement;
  private sentenceEl!: HTMLElement;
  private progressFill!: HTMLElement;
  private counterEl!: HTMLElement;
  private metaEl!: HTMLElement;
  private playButton!: HTMLButtonElement;
  private prevButton!: HTMLButtonElement;
  private nextButton!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly player: Player,
    private readonly plugin: MsTtsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_MS_TTS_PLAYER;
  }

  getDisplayText(): string {
    return '微软语音朗读';
  }

  getIcon(): string {
    return 'volume-2';
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('ms-tts-player');

    this.titleEl = root.createDiv({ cls: 'ms-tts-title' });
    this.sentenceEl = root.createDiv({ cls: 'ms-tts-sentence' });

    const progress = root.createDiv({ cls: 'ms-tts-progress' });
    this.progressFill = progress.createDiv({ cls: 'ms-tts-progress-fill' });

    const controls = root.createDiv({ cls: 'ms-tts-controls' });
    this.prevButton = controls.createEl('button', { attr: { 'aria-label': '上一段' } });
    setIcon(this.prevButton, 'skip-back');

    this.playButton = controls.createEl('button', {
      cls: 'ms-tts-primary',
      attr: { 'aria-label': '播放或暂停' },
    });
    setIcon(this.playButton, 'play');

    const stopButton = controls.createEl('button', { attr: { 'aria-label': '停止' } });
    setIcon(stopButton, 'square');

    this.nextButton = controls.createEl('button', { attr: { 'aria-label': '下一段' } });
    setIcon(this.nextButton, 'skip-forward');

    this.counterEl = root.createDiv({ cls: 'ms-tts-counter' });
    this.metaEl = root.createDiv({ cls: 'ms-tts-meta' });

    this.prevButton.onclick = () => this.player.prev();
    this.nextButton.onclick = () => this.player.next();
    stopButton.onclick = () => this.player.stop();
    this.playButton.onclick = () => this.togglePlay();

    this.unsubscribers.push(
      this.player.on('snapshot', (snapshot) => this.render(snapshot)),
      this.player.on('sentence', () => this.render(this.player.getSnapshot())),
    );

    this.render(this.player.getSnapshot());
  }

  async onClose(): Promise<void> {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }

  private togglePlay(): void {
    const snapshot = this.player.getSnapshot();
    if (snapshot.state === 'playing') {
      this.player.pause();
    } else if (snapshot.state === 'paused') {
      this.player.resume();
    } else {
      void this.plugin.readActiveDocument();
    }
  }

  private render(snapshot: PlayerSnapshot): void {
    const hasDocument = snapshot.chunkCount > 0;
    this.titleEl.setText(snapshot.title || '未在朗读');
    this.sentenceEl.setText(snapshot.sentenceText || '选择一篇笔记，然后点击播放。');

    this.progressFill.style.width = `${Math.round(snapshot.progress * 100)}%`;

    this.counterEl.setText(
      hasDocument
        ? `第 ${Math.min(snapshot.chunkIndex + 1, snapshot.chunkCount)} / ${snapshot.chunkCount} 段` +
            (snapshot.state === 'paused' ? ' · 已暂停' : '') +
            (snapshot.state === 'loading' ? ' · 合成中…' : '') +
            (snapshot.state === 'error' ? ' · 出错' : '')
        : '',
    );

    const engineLabel = this.plugin.providerLabel(snapshot.provider);
    const detail = this.plugin.describeCurrentVoice();
    this.metaEl.setText(
      `${engineLabel}${detail ? ` · ${detail}` : ''} · 缓存命中 ${snapshot.cacheHits} · 请求 ${snapshot.requests}`,
    );

    this.prevButton.disabled = !hasDocument;
    this.nextButton.disabled = !hasDocument;
    this.playButton.disabled = false;

    const icon = snapshot.state === 'playing' ? 'pause' : 'play';
    setIcon(this.playButton, icon);
    this.playButton.setAttribute('aria-label', snapshot.state === 'playing' ? '暂停' : '播放');
  }
}
