import { MarkdownView, Notice, Plugin, TFile, TFolder } from 'obsidian';
import type { Editor } from 'obsidian';
import { DEFAULT_SETTINGS } from './settings';
import { MsTtsSettingsTab } from './settings-tab';
import type {
  KeyStorage,
  MsTtsSettings,
  PlaybackMode,
  Playlist,
  PlayerSnapshot,
  ProviderId,
  SecretName,
  Sentence,
  VoiceOption,
} from './types';
import { AudioCache } from './cache';
import { Player } from './player';
import { TtsService } from './tts-service';
import { clearEditorHighlight, highlightEditor, highlightField } from './highlighter';
import { buildReadableDoc } from './text-extract';
import { PlayerView, VIEW_TYPE_MS_TTS_PLAYER } from './player-view';
import { exportDocAudio } from './exporter';
import { describeError } from './errors';
import { clamp } from './util';
import { PLAYBACK_MODE_LABELS, PlaylistController } from './playlist';
import { PlaylistManagerModal, PlaylistPickerModal } from './playlist-modal';

const SECRET_PREFIX = 'ms-tts-reader:secret:';
const VOICES_PREFIX = 'ms-tts-reader:voices:';

export default class MsTtsPlugin extends Plugin {
  settings!: MsTtsSettings;
  voices: VoiceOption[] = [];
  cache!: AudioCache;
  player!: Player;
  tts!: TtsService;
  playlist!: PlaylistController;

  private sessionSecrets: Record<SecretName, string> = { doubao: '', openai: '' };
  private statusBarEl: HTMLElement | null = null;
  private readingPath: string | null = null;
  private readingView: MarkdownView | null = null;
  private readingEditor: Editor | null = null;
  private lastMarkdownView: MarkdownView | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.cache = new AudioCache();
    this.cache.setMaxBytes(this.settings.cacheMaxMB * 1024 * 1024);
    void this.cache.evict(this.settings.cacheMaxMB * 1024 * 1024);

    this.tts = new TtsService(
      () => this.settings,
      (name) => this.getSecret(name),
    );
    this.player = new Player({
      settings: () => this.settings,
      tts: this.tts,
      cache: this.cache,
    });

    this.playlist = new PlaylistController({
      app: this.app,
      settings: () => this.settings,
      save: () => this.saveSettings(),
      player: this.player,
      openNoteForReading: (path) => this.openNoteForReading(path),
      notify: (message) => new Notice(message, 5000),
    });
    this.player.setDocEndHandler(() => this.playlist.handleDocEnded());

    this.registerEditorExtension(highlightField);
    this.registerView(VIEW_TYPE_MS_TTS_PLAYER, (leaf) => new PlayerView(leaf, this.player, this));
    this.addSettingTab(new MsTtsSettingsTab(this.app, this));

    this.addRibbonIcon('volume-2', '微软语音朗读：朗读当前笔记', () => {
      void this.readActiveDocument();
    });

    this.registerCommands();
    this.registerFileMenu();
    this.registerVaultEvents();
    this.setupStatusBar();
    this.wirePlayerEvents();
    this.loadCachedVoices();
    this.lastMarkdownView = this.findActiveMarkdownView();
    this.refreshStatusBar();

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.onActiveLeafChange()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.onActiveLeafChange()));
  }

  onunload(): void {
    this.player?.dispose();
    this.statusBarEl?.remove();
    this.statusBarEl = null;
    void this.cache?.close();
  }

  // ---------- 设置与密钥 ----------

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<MsTtsSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    this.settings.rate = clamp(this.settings.rate, 0.5, 2);
    this.settings.pitch = clamp(this.settings.pitch, -12, 12);
    this.settings.volume = clamp(this.settings.volume, 0, 100);
    this.settings.chunkChars = clamp(this.settings.chunkChars, 120, 800);
    this.settings.cacheMaxMB = clamp(this.settings.cacheMaxMB, 50, 1000);
    this.normalizePlaylists();
    this.cleanupLegacySettings();
  }

  /** 兼容旧配置：清理非法列表、去重条目、修正 activePlaylistId */
  private normalizePlaylists(): void {
    const raw = this.settings.playlists as unknown;
    const source = Array.isArray(raw) ? raw : [];
    const seenLists = new Set<string>();

    const playlists: Playlist[] = [];
    for (const entry of source as Array<Partial<Playlist> | null | undefined>) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || !entry.id || seenLists.has(entry.id)) continue;
      if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
      seenLists.add(entry.id);

      const seenItems = new Set<string>();
      const items: Playlist['items'] = [];
      if (Array.isArray(entry.items)) {
        for (const item of entry.items) {
          if (!item || typeof item.path !== 'string' || !item.path) continue;
          if (seenItems.has(item.path)) continue;
          seenItems.add(item.path);
          items.push({
            path: item.path,
            title:
              typeof item.title === 'string' && item.title
                ? item.title
                : (item.path.split('/').pop() ?? item.path).replace(/\.md$/i, ''),
          });
        }
      }

      playlists.push({
        id: entry.id,
        name: entry.name,
        items,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
      });
    }

    this.settings.playlists = playlists;
    if (!playlists.some((list) => list.id === this.settings.activePlaylistId)) {
      this.settings.activePlaylistId = playlists[0]?.id ?? '';
    }
    if (!['sequential', 'repeat-one', 'repeat-all', 'shuffle'].includes(this.settings.playbackMode)) {
      this.settings.playbackMode = 'sequential';
    }
    if (typeof this.settings.autoFolderPlaylist !== 'boolean') {
      this.settings.autoFolderPlaylist = false;
    }
    if (typeof this.settings.playlistIncludeSubfolders !== 'boolean') {
      this.settings.playlistIncludeSubfolders = false;
    }
  }

  /** 移除 0.1.x 的 Azure 配置与密钥残留 */
  private cleanupLegacySettings(): void {
    const legacyKeys = [
      'engine',
      'voice',
      'style',
      'styleDegree',
      'outputFormat',
      'endpointMode',
      'region',
      'customEndpoint',
      'f0Mode',
    ];
    for (const key of legacyKeys) {
      delete (this.settings as unknown as Record<string, unknown>)[key];
    }
    try {
      window.localStorage.removeItem('ms-tts-reader:api-key');
      window.localStorage.removeItem('ms-tts-reader:voices');
    } catch {
      // ignore
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.cache?.setMaxBytes(this.settings.cacheMaxMB * 1024 * 1024);
    this.refreshStatusBar();
  }

  getSecret(name: SecretName): string {
    if (!this.settings) return '';
    if (this.settings.keyStorage === 'session') return this.sessionSecrets[name] ?? '';
    try {
      return window.localStorage.getItem(`${SECRET_PREFIX}${name}`) ?? '';
    } catch {
      return '';
    }
  }

  setSecret(name: SecretName, value: string): void {
    const trimmed = value.trim();
    this.sessionSecrets[name] = trimmed;
    if (this.settings?.keyStorage === 'local') {
      try {
        window.localStorage.setItem(`${SECRET_PREFIX}${name}`, trimmed);
      } catch {
        // localStorage 不可用时仅保留在内存
      }
    }
  }

  clearSecret(name: SecretName): void {
    this.sessionSecrets[name] = '';
    try {
      window.localStorage.removeItem(`${SECRET_PREFIX}${name}`);
    } catch {
      // ignore
    }
  }

  setKeyStorage(storage: KeyStorage): void {
    const current: Record<SecretName, string> = {
      doubao: this.getSecret('doubao'),
      openai: this.getSecret('openai'),
    };
    this.settings.keyStorage = storage;

    for (const name of ['doubao', 'openai'] as SecretName[]) {
      this.sessionSecrets[name] = current[name];
      try {
        if (storage === 'local') {
          window.localStorage.setItem(`${SECRET_PREFIX}${name}`, current[name]);
        } else {
          window.localStorage.removeItem(`${SECRET_PREFIX}${name}`);
        }
      } catch {
        // ignore
      }
    }
  }

  // ---------- 语音 ----------

  providerLabel(provider?: ProviderId): string {
    return this.tts.providerLabel(provider);
  }

  describeCurrentVoice(): string {
    return this.tts.describeVoice();
  }

  async refreshVoices(): Promise<VoiceOption[]> {
    if (this.settings.provider === 'system') return [];
    const voices = await this.tts.listVoices();
    this.voices = voices;
    try {
      window.localStorage.setItem(
        `${VOICES_PREFIX}${this.settings.provider}`,
        JSON.stringify({ ts: Date.now(), voices }),
      );
    } catch {
      // 列表过大时忽略持久化
    }
    return voices;
  }

  async testConnection(): Promise<string> {
    const provider = this.settings.provider;

    if (provider === 'system') {
      const voices = this.systemVoices();
      if (!voices.length) {
        throw new Error('未检测到 Windows 系统语音，请在系统设置中安装中文语音包');
      }
      return `系统语音可用：检测到 ${voices.length} 个本地语音`;
    }

    if (provider === 'edge') {
      const voices = await this.refreshVoices();
      const chinese = voices.filter((voice) => voice.locale === 'zh-CN').length;
      return `Edge 语音可用：共 ${voices.length} 个，其中中文 ${chinese} 个`;
    }

    const audio = await this.tts.synthesize('你好，这是语音连接测试。');
    return `连接成功：已合成 ${audio.byteLength} 字节测试音频`;
  }

  onProviderChanged(): void {
    const state = this.player.getSnapshot().state;
    if (state === 'playing' || state === 'paused' || state === 'loading') {
      this.player.stop();
    }
    this.voices = [];
    this.loadCachedVoices();
    this.refreshStatusBar();
  }

  systemVoices(): SpeechSynthesisVoice[] {
    try {
      return window.speechSynthesis?.getVoices() ?? [];
    } catch {
      return [];
    }
  }

  private loadCachedVoices(): void {
    if (this.settings.provider === 'system') {
      this.voices = [];
      return;
    }

    try {
      const raw = window.localStorage.getItem(`${VOICES_PREFIX}${this.settings.provider}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { voices?: VoiceOption[] };
        if (Array.isArray(parsed.voices) && parsed.voices.length) {
          this.voices = parsed.voices;
          return;
        }
      }
    } catch {
      // ignore
    }

    this.voices = this.tts.fallbackVoices();
  }

  // ---------- 命令 ----------

  private registerCommands(): void {
    this.addCommand({
      id: 'read-selection',
      name: '朗读选区',
      checkCallback: (checking) => {
        const view = this.getActiveView();
        const info = view ? this.getSelectionInfo(view) : null;
        if (checking) return !!info;
        if (!view || !info) {
          new Notice('请先在笔记中选中要朗读的文字');
          return false;
        }
        void this.beginReading(
          info.text,
          view.file?.basename ?? '选区',
          info.baseOffset,
          view.file?.path ?? null,
          view,
          true,
        );
        return true;
      },
    });

    this.addCommand({
      id: 'read-from-cursor',
      name: '从光标处朗读',
      editorCheckCallback: (checking, editor) => {
        if (checking) return true;
        void this.readFromCursor(editor);
        return true;
      },
    });

    this.addCommand({
      id: 'read-document',
      name: '朗读整篇笔记',
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (checking) return !!view;
        if (!view) {
          new Notice('请先打开一篇笔记');
          return false;
        }
        void this.readActiveDocument();
        return true;
      },
    });

    this.addCommand({
      id: 'toggle-playback',
      name: '暂停或继续朗读',
      callback: () => this.togglePlayback(),
    });

    this.addCommand({
      id: 'stop-reading',
      name: '停止朗读',
      callback: () => {
        this.player.stop();
        this.playlist.invalidate();
        this.readingPath = null;
      },
    });

    this.addCommand({
      id: 'open-player',
      name: '打开朗读播放器',
      callback: () => {
        void this.activatePlayerView();
      },
    });

    this.addCommand({
      id: 'export-audio',
      name: '导出当前笔记为音频',
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (checking) return !!view;
        if (!view) {
          new Notice('请先打开一篇笔记');
          return false;
        }
        void this.exportCurrent();
        return true;
      },
    });

    this.addCommand({
      id: 'preview-voice',
      name: '试听当前语音',
      callback: () => {
        void this.previewVoice();
      },
    });

    this.addCommand({
      id: 'play-playlist',
      name: '播放当前播放列表',
      callback: () => {
        const list = this.playlist.getActiveList();
        if (!list) {
          new Notice('还没有播放列表，请先添加笔记');
          return;
        }
        this.playlist.playPlaylist(list.id);
      },
    });

    this.addCommand({
      id: 'toggle-playback-mode',
      name: '切换播放模式',
      callback: () => this.togglePlaybackMode(),
    });

    this.addCommand({
      id: 'add-to-playlist',
      name: '将当前笔记加入播放列表',
      checkCallback: (checking) => {
        const file = this.getCurrentNoteFile();
        if (checking) return !!file;
        if (!file) {
          new Notice('请先打开一篇笔记');
          return false;
        }
        this.promptAddToPlaylist([file.path]);
        return true;
      },
    });

    this.addCommand({
      id: 'manage-playlists',
      name: '管理播放列表',
      callback: () => this.openPlaylistManager(),
    });

    this.addCommand({
      id: 'playlist-from-folder',
      name: '用当前笔记所在文件夹生成播放列表',
      checkCallback: (checking) => {
        const file = this.getCurrentNoteFile();
        if (checking) return !!file;
        if (!file) {
          new Notice('请先打开一篇笔记');
          return false;
        }
        this.createPlaylistFromFolder(file);
        return true;
      },
    });

    this.addCommand({
      id: 'next-note',
      name: '播放下一条笔记',
      callback: () => this.playlist.nextNote(),
    });

    this.addCommand({
      id: 'prev-note',
      name: '播放上一条笔记',
      callback: () => this.playlist.prevNote(),
    });
  }

  togglePlayback(): void {
    const snapshot = this.player.getSnapshot();
    if (snapshot.state === 'playing') this.player.pause();
    else if (snapshot.state === 'paused') this.player.resume();
    else void this.readActiveDocument();
  }

  // ---------- 朗读 ----------

  async readActiveDocument(): Promise<void> {
    const view = this.getActiveView();
    if (!view) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const text = view.getViewData();
    if (!text.trim()) {
      new Notice('当前笔记没有可朗读的文本');
      return;
    }
    await this.beginReading(
      text,
      view.file?.basename ?? '未命名笔记',
      0,
      view.file?.path ?? null,
      view,
    );
  }

  async previewVoice(): Promise<void> {
    const sample = '你好，这是微软语音朗读的试听。你可以调整语音、语速和音调。';
    const doc = buildReadableDoc(sample, {
      chunkChars: 300,
      perSentence: false,
      title: '语音试听',
    });
    this.playlist.startSingle(doc, { title: '语音试听', path: null, source: 'partial' });
  }

  private async readFromCursor(editor: Editor): Promise<void> {
    const view = this.getActiveView();
    if (!view) return;
    const offset = editor.posToOffset(editor.getCursor('from'));
    const text = editor.getValue().slice(offset);
    if (!text.trim()) {
      new Notice('光标之后没有可朗读的文本');
      return;
    }
    await this.beginReading(
      text,
      view.file?.basename ?? '未命名笔记',
      offset,
      view.file?.path ?? null,
      view,
      true,
    );
  }

  private async beginReading(
    text: string,
    title: string,
    baseOffset: number,
    path: string | null,
    view: MarkdownView | null,
    partial = false,
  ): Promise<void> {
    const doc = buildReadableDoc(text, {
      chunkChars: this.settings.chunkChars,
      perSentence: this.settings.perSentence,
      baseOffset,
      title,
    });

    if (!doc.chunks.length) {
      new Notice('没有可朗读的文本（可能全是代码或空内容）');
      return;
    }

    this.readingPath = path;
    this.ensureSystemVoice();
    this.clearHighlight();
    this.readingView = view;
    this.readingEditor = view && view.getMode() === 'source' ? view.editor : null;
    if (this.settings.openPanelOnPlay) void this.activatePlayerView();

    if (partial || !path) {
      this.playlist.startSingle(doc, {
        title,
        path,
        source: partial ? 'partial' : 'single',
      });
    } else {
      this.playlist.startFromNote(path, doc, title);
    }
  }

  private ensureSystemVoice(): void {
    if (this.settings.provider !== 'system' && !this.settings.autoFallbackSystem) return;
    if (this.settings.systemVoiceURI) return;
    const voices = this.systemVoices();
    const preferred = voices.find((voice) => /^zh/i.test(voice.lang)) ?? voices[0];
    if (preferred) {
      this.settings.systemVoiceURI = preferred.voiceURI;
      void this.saveSettings();
    }
  }

  private getSelectionInfo(view: MarkdownView): { text: string; baseOffset: number } | null {
    const editor = view.editor;
    if (view.getMode() === 'source' && editor) {
      const text = editor.getSelection();
      if (!text.trim()) return null;
      return { text, baseOffset: editor.posToOffset(editor.getCursor('from')) };
    }
    const text = window.getSelection()?.toString() ?? '';
    if (!text.trim()) return null;
    return { text, baseOffset: 0 };
  }

  private findActiveMarkdownView(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  /**
   * 返回当前应朗读的笔记视图。
   * 播放器面板或设置页成为活动视图时，回退到最近打开的 Markdown 视图。
   */
  private getActiveView(): MarkdownView | null {
    const active = this.findActiveMarkdownView();
    if (active) {
      this.lastMarkdownView = active;
      return active;
    }

    const leaves = this.app.workspace.getLeavesOfType('markdown');
    if (this.lastMarkdownView?.file && leaves.some((leaf) => leaf.view === this.lastMarkdownView)) {
      return this.lastMarkdownView;
    }

    for (const leaf of leaves) {
      const view = leaf.view as MarkdownView;
      if (view?.file) {
        this.lastMarkdownView = view;
        return view;
      }
    }
    return null;
  }

  // ---------- 播放列表辅助 ----------

  openPlaylistManager(): void {
    new PlaylistManagerModal(this.app, this).open();
  }

  togglePlaybackMode(): void {
    const mode = this.playlist.cycleMode();
    new Notice(`播放模式：${PLAYBACK_MODE_LABELS[mode]}`);
  }

  setPlaybackMode(mode: PlaybackMode): void {
    this.playlist.setMode(mode);
  }

  getCurrentNoteFile(): TFile | null {
    const view = this.getActiveView();
    if (view?.file) return view.file;
    const active = this.app.workspace.getActiveFile();
    return active && active.extension.toLowerCase() === 'md' ? active : null;
  }

  /** 播放列表续播时打开/定位目标笔记，并返回可用于构建文档的文本 */
  private async openNoteForReading(
    path: string,
  ): Promise<{ text: string; title: string } | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return null;

    const active = this.findActiveMarkdownView();
    if (active?.file?.path === path) {
      this.lastMarkdownView = active;
      this.readingPath = path;
      this.readingView = active;
      this.readingEditor = active.getMode() === 'source' ? active.editor : null;
      return { text: active.getViewData(), title: active.file?.basename ?? file.basename };
    }

    const current = this.readingView;
    if (current?.file?.path === path) {
      this.lastMarkdownView = current;
      this.readingPath = path;
      this.readingEditor = current.getMode() === 'source' ? current.editor : null;
      return { text: current.getViewData(), title: current.file?.basename ?? file.basename };
    }

    let leaf = current?.leaf;
    if (!leaf || !(leaf.view instanceof MarkdownView)) {
      const leaves = this.app.workspace.getLeavesOfType('markdown');
      const reusable =
        leaves.find(
          (item) => item.view instanceof MarkdownView && item.view.file?.path === path,
        ) ?? leaves.find((item) => item.view instanceof MarkdownView);
      leaf = reusable ?? this.app.workspace.getLeaf('tab');
    }
    if (!leaf) return null;

    this.readingPath = path;
    this.clearHighlight();
    try {
      await leaf.openFile(file);
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      this.readingPath = null;
      new Notice(`打开笔记失败：${describeError(error)}`);
      return null;
    }

    const view = leaf.view instanceof MarkdownView ? leaf.view : null;
    if (view) {
      this.lastMarkdownView = view;
      this.readingView = view;
      this.readingEditor = view.getMode() === 'source' ? view.editor : null;
    }
    const text = await this.app.vault.cachedRead(file);
    return { text, title: file.basename };
  }

  /** 从文件浏览器/命令直接播放某篇笔记 */
  async playFile(file: TFile): Promise<void> {
    try {
      const active = this.getActiveView();
      const leaf = active?.leaf ?? this.app.workspace.getLeaf('tab');
      this.clearHighlight();
      await leaf.openFile(file);
      await this.app.workspace.revealLeaf(leaf);
      const view = leaf.view instanceof MarkdownView ? leaf.view : null;
      const text = await this.app.vault.cachedRead(file);
      await this.beginReading(text, file.basename, 0, file.path, view);
    } catch (error) {
      new Notice(`无法播放：${describeError(error)}`);
    }
  }

  private registerFileMenu(): void {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile && file.extension.toLowerCase() === 'md') {
          const target = file;
          menu.addItem((item) =>
            item
              .setTitle('添加到播放列表…')
              .setIcon('list-plus')
              .onClick(() => this.promptAddToPlaylist([target.path])),
          );
          menu.addItem((item) =>
            item
              .setTitle('从这篇笔记开始播放')
              .setIcon('play')
              .onClick(() => {
                void this.playFile(target);
              }),
          );
        } else if (file instanceof TFolder) {
          const target = file;
          menu.addItem((item) =>
            item
              .setTitle('将文件夹加入播放列表…')
              .setIcon('folder-plus')
              .onClick(() => this.promptAddFolderToPlaylist(target)),
          );
        }
      }),
    );
  }

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.playlist.handleRename(oldPath, file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', () => {
        this.playlist.handleDelete();
      }),
    );
  }

  private promptAddToPlaylist(paths: string[]): void {
    const lists = this.playlist.getLists();
    if (!lists.length) {
      const list = this.playlist.createList('默认列表');
      const added = this.playlist.addPathsTo(list.id, paths);
      new Notice(added ? `已加入「${list.name}」` : '没有新增笔记');
      return;
    }
    if (lists.length === 1) {
      const list = lists[0];
      const added = this.playlist.addPathsTo(list.id, paths);
      new Notice(added ? `已加入「${list.name}」` : '所选笔记已在列表中');
      return;
    }
    new PlaylistPickerModal(this.app, lists, (list) => {
      const added = this.playlist.addPathsTo(list.id, paths);
      new Notice(added ? `已加入「${list.name}」` : '所选笔记已在列表中');
    }).open();
  }

  private promptAddFolderToPlaylist(folder: TFolder): void {
    const paths = this.playlist
      .buildFolderQueue(folder.path, this.settings.playlistIncludeSubfolders)
      .map((item) => item.path);
    if (!paths.length) {
      new Notice('文件夹里没有 Markdown 笔记');
      return;
    }

    const addTo = (list: Playlist): void => {
      const added = this.playlist.addPathsTo(list.id, paths);
      new Notice(added ? `已加入 ${added} 篇到「${list.name}」` : '这些笔记已在列表中');
    };

    const lists = this.playlist.getLists();
    if (!lists.length) {
      addTo(this.playlist.createList('默认列表'));
      return;
    }
    if (lists.length === 1) {
      addTo(lists[0]);
      return;
    }
    new PlaylistPickerModal(this.app, lists, addTo).open();
  }

  private createPlaylistFromFolder(file: TFile): void {
    const folder = file.parent;
    const name = folder && folder.path !== '/' ? folder.name : '库根目录';
    const list = this.playlist.createList(name);
    const added = this.playlist.addFolderTo(
      list.id,
      folder?.path ?? '/',
      this.settings.playlistIncludeSubfolders,
    );
    new Notice(`已生成「${list.name}」，共 ${added} 篇`);
    this.openPlaylistManager();
  }

  // ---------- 播放器事件与高亮 ----------

  private wirePlayerEvents(): void {
    this.player.on('snapshot', (snapshot) => {
      this.renderStatusBar(snapshot);
      if (snapshot.state === 'stopped') this.playlist.invalidate();
      if (snapshot.state === 'idle' || snapshot.state === 'stopped' || snapshot.state === 'error') {
        this.readingPath = null;
        this.clearHighlight();
      }
    });

    this.player.on('sentence', (sentence) => this.applyHighlight(sentence));
    this.player.on('notice', (message) => new Notice(message, 7000));
    this.player.on('error', (error) => new Notice(describeError(error), 10000));
  }

  private applyHighlight(sentence: Sentence | null): void {
    const editor = this.readingEditor;
    if (!editor) return;

    if (!sentence || !this.settings.highlight) {
      clearEditorHighlight(editor);
      return;
    }
    highlightEditor(editor, sentence.srcStart, sentence.srcEnd, this.settings.autoScroll);
  }

  private clearHighlight(): void {
    if (this.readingEditor) clearEditorHighlight(this.readingEditor);
    this.readingEditor = null;
    this.readingView = null;
  }

  private onActiveLeafChange(): void {
    const active = this.findActiveMarkdownView();
    if (active) this.lastMarkdownView = active;

    // 播放列表自动切篇期间不要把它误判为用户切换笔记
    if (this.playlist?.isAdvancing()) return;

    if (!this.readingPath) return;
    // 播放器面板成为活动视图时不要停止朗读
    if (!active) return;
    const path = active.file?.path ?? null;
    if (path && path !== this.readingPath) {
      this.player.stop();
      this.readingPath = null;
    }
  }

  // ---------- 状态栏 ----------

  private setupStatusBar(): void {
    if (this.statusBarEl) return;
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('ms-tts-status');
    this.statusBarEl.onclick = () => this.togglePlayback();
  }

  refreshStatusBar(): void {
    if (this.settings.showStatusBar) {
      this.setupStatusBar();
    } else if (this.statusBarEl) {
      this.statusBarEl.remove();
      this.statusBarEl = null;
    }
    if (this.player) this.renderStatusBar(this.player.getSnapshot());
  }

  private renderStatusBar(snapshot: PlayerSnapshot): void {
    const element = this.statusBarEl;
    if (!element) return;

    if (
      snapshot.state === 'playing' ||
      snapshot.state === 'paused' ||
      snapshot.state === 'loading'
    ) {
      if (!this.settings.showStatusBar) {
        element.setText('');
        return;
      }
      const current = Math.min(snapshot.chunkIndex + 1, snapshot.chunkCount);
      const queue = this.playlist?.getSnapshot();
      const listPart =
        queue && queue.count > 1 && queue.source !== 'partial'
          ? `${queue.index + 1}/${queue.count} · `
          : '';
      element.setText(
        `🎧 ${listPart}${current}/${snapshot.chunkCount}${snapshot.state === 'paused' ? ' · 已暂停' : ''}`,
      );
      element.addClass('is-active');
    } else {
      element.removeClass('is-active');
      element.setText('');
    }
  }

  // ---------- 视图与导出 ----------

  async activatePlayerView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_MS_TTS_PLAYER);
    if (existing.length) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('tab');
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_MS_TTS_PLAYER, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async exportCurrent(): Promise<void> {
    const view = this.getActiveView();
    if (!view) {
      new Notice('请先打开一篇笔记');
      return;
    }

    if (this.settings.provider === 'system') {
      new Notice('Windows 系统语音不支持导出音频，请切换到 Edge / 豆包 / OpenAI 兼容语音');
      return;
    }

    const doc = buildReadableDoc(view.getViewData(), {
      chunkChars: this.settings.chunkChars,
      perSentence: false,
      title: view.file?.basename ?? '未命名笔记',
    });

    if (!doc.chunks.length) {
      new Notice('没有可导出的文本');
      return;
    }
    if (!this.tts.isConfigured()) {
      new Notice(`${this.tts.providerLabel()}尚未配置，无法导出`);
      return;
    }
    if (doc.totalChars > 50000) {
      new Notice(`文本约 ${doc.totalChars} 字，将分 ${doc.chunks.length} 段合成，可能耗时较长。`, 8000);
    }

    const notice = new Notice('正在导出音频…', 0);
    try {
      const path = await exportDocAudio(this.app, doc, this.settings, this.tts, this.cache, {
        onProgress: (done, total) => notice.setMessage(`正在导出音频… ${done}/${total}`),
      });
      notice.hide();
      new Notice(`已导出：${path}`, 8000);
    } catch (error) {
      notice.hide();
      new Notice(`导出失败：${describeError(error)}`, 10000);
    }
  }
}
