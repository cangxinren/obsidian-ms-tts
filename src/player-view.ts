import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import type { Player } from './player';
import type { PlayerSnapshot } from './types';
import type MsTtsPlugin from './main';
import { PLAYBACK_MODE_ICONS, PLAYBACK_MODE_LABELS } from './playlist';

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
  private prevNoteButton!: HTMLButtonElement;
  private nextNoteButton!: HTMLButtonElement;
  private modeButton!: HTMLButtonElement;
  private playlistButton!: HTMLButtonElement;
  private playlistEl!: HTMLElement;

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

    const playlistControls = root.createDiv({ cls: 'ms-tts-playlist-controls' });
    this.prevNoteButton = playlistControls.createEl('button', { attr: { 'aria-label': '上一篇笔记' } });
    setIcon(this.prevNoteButton, 'chevrons-left');
    this.modeButton = playlistControls.createEl('button', {
      cls: 'ms-tts-mode-button',
      attr: { 'aria-label': '切换播放模式' },
    });
    this.playlistButton = playlistControls.createEl('button', { attr: { 'aria-label': '管理播放列表' } });
    setIcon(this.playlistButton, 'list-music');
    this.nextNoteButton = playlistControls.createEl('button', { attr: { 'aria-label': '下一篇笔记' } });
    setIcon(this.nextNoteButton, 'chevrons-right');

    this.counterEl = root.createDiv({ cls: 'ms-tts-counter' });
    this.playlistEl = root.createDiv({ cls: 'ms-tts-playlist-status' });
    this.metaEl = root.createDiv({ cls: 'ms-tts-meta' });

    this.prevButton.onclick = () => this.player.prev();
    this.nextButton.onclick = () => this.player.next();
    stopButton.onclick = () => this.player.stop();
    this.playButton.onclick = () => this.togglePlay();
    this.prevNoteButton.onclick = () => this.plugin.playlist.prevNote();
    this.nextNoteButton.onclick = () => this.plugin.playlist.nextNote();
    this.modeButton.onclick = () => this.plugin.togglePlaybackMode();
    this.playlistButton.onclick = () => this.plugin.openPlaylistManager();

    this.unsubscribers.push(
      this.player.on('snapshot', (snapshot) => this.render(snapshot)),
      this.player.on('sentence', () => this.render(this.player.getSnapshot())),
      this.plugin.playlist.onChange(() => this.render(this.player.getSnapshot())),
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

    const playlist = this.plugin.playlist.getSnapshot();
    const canSwitch = playlist.count > 1 && playlist.source !== 'partial';
    this.prevNoteButton.disabled = !canSwitch || playlist.isAdvancing;
    this.nextNoteButton.disabled = !canSwitch || playlist.isAdvancing;
    setIcon(this.modeButton, PLAYBACK_MODE_ICONS[playlist.mode]);
    const modeLabel = PLAYBACK_MODE_LABELS[playlist.mode];
    this.modeButton.setAttribute('aria-label', `播放模式：${modeLabel}，点击切换`);
    this.modeButton.title = `播放模式：${modeLabel}，点击切换`;

    if (playlist.source === 'partial') {
      this.playlistEl.setText(`单次播放 · ${modeLabel}`);
    } else {
      const sourceLabel =
        playlist.source === 'playlist'
          ? playlist.listName || '播放列表'
          : playlist.source === 'folder'
            ? '文件夹队列'
            : '单篇';
      const position = playlist.count > 1 ? ` · ${playlist.index + 1}/${playlist.count}` : '';
      this.playlistEl.setText(`${sourceLabel}${position} · ${modeLabel}`);
    }

    this.prevButton.disabled = !hasDocument;
    this.nextButton.disabled = !hasDocument;
    this.playButton.disabled = false;

    const icon = snapshot.state === 'playing' ? 'pause' : 'play';
    setIcon(this.playButton, icon);
    this.playButton.setAttribute('aria-label', snapshot.state === 'playing' ? '暂停' : '播放');
  }
}
