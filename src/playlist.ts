import { App, TFile, TFolder } from 'obsidian';
import type {
  MsTtsSettings,
  PlaybackMode,
  Playlist,
  PlaylistItem,
  PlaylistSnapshot,
  QueueSource,
  ReadableDoc,
} from './types';
import type { Player } from './player';
import { buildReadableDoc } from './text-extract';
import { randomUuid } from './util';

export const PLAYBACK_MODES: PlaybackMode[] = [
  'sequential',
  'repeat-one',
  'repeat-all',
  'shuffle',
];

export const PLAYBACK_MODE_LABELS: Record<PlaybackMode, string> = {
  sequential: '顺序播放',
  'repeat-one': '单篇循环',
  'repeat-all': '列表循环',
  shuffle: '随机播放',
};

export const PLAYBACK_MODE_ICONS: Record<PlaybackMode, string> = {
  sequential: 'list-ordered',
  'repeat-one': 'repeat-1',
  'repeat-all': 'repeat',
  shuffle: 'shuffle',
};

export interface PlaylistDeps {
  app: App;
  settings: () => MsTtsSettings;
  save: () => Promise<void>;
  player: Player;
  openNoteForReading: (path: string) => Promise<{ text: string; title: string } | null>;
  notify: (message: string) => void;
}

type PlayResult = 'started' | 'skipped' | 'aborted';

/** 生成随机播放顺序，当前项固定放在首位 */
export function buildShuffleOrder(
  count: number,
  first = -1,
  random: () => number = Math.random,
): number[] {
  const rest: number[] = [];
  for (let i = 0; i < count; i++) {
    if (i !== first) rest.push(i);
  }
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const value = rest[i];
    rest[i] = rest[j];
    rest[j] = value;
  }
  return first >= 0 && first < count ? [first, ...rest] : rest;
}

function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor(index)));
}

export class PlaylistController {
  private queue: PlaylistItem[] = [];
  private queueListId = '';
  private source: QueueSource = 'single';
  private index = 0;
  private shuffleOrder: number[] = [];
  private shufflePos = 0;
  private doc: ReadableDoc | null = null;
  private currentPath: string | null = null;
  private title = '';
  private allowAdvance = false;
  private runId = 0;
  private advancing = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: PlaylistDeps) {}

  // ---------- 查询 ----------

  getLists(): Playlist[] {
    return this.deps.settings().playlists;
  }

  getActiveList(): Playlist | null {
    const settings = this.deps.settings();
    return settings.playlists.find((list) => list.id === settings.activePlaylistId) ?? null;
  }

  getSnapshot(): PlaylistSnapshot {
    const settings = this.deps.settings();
    const active = settings.playlists.find((list) => list.id === settings.activePlaylistId) ?? null;
    const queueList = this.queueListId
      ? settings.playlists.find((list) => list.id === this.queueListId) ?? null
      : null;
    const displayList = this.source === 'playlist' ? queueList : active;
    return {
      mode: settings.playbackMode,
      listId: displayList?.id ?? '',
      listName: displayList?.name ?? '',
      source: this.source,
      index: this.index,
      count: this.queue.length,
      currentPath: this.currentPath,
      currentTitle: this.title,
      isAdvancing: this.advancing,
    };
  }

  isAdvancing(): boolean {
    return this.advancing;
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // ---------- 播放入口 ----------

  /** 选区 / 光标 / 试听：只播一次，不参与自动续播 */
  startSingle(
    doc: ReadableDoc,
    meta: { title: string; path?: string | null; source?: QueueSource },
  ): void {
    this.runId++;
    this.queue = meta.path ? [{ path: meta.path, title: meta.title }] : [];
    this.queueListId = '';
    this.source = meta.source ?? 'partial';
    this.index = 0;
    this.shuffleOrder = [];
    this.shufflePos = 0;
    this.doc = doc;
    this.currentPath = meta.path ?? null;
    this.title = meta.title;
    this.allowAdvance = false;
    this.advancing = false;
    this.emitChange();
    void this.deps.player.playDoc(doc, 0);
  }

  /** 整篇朗读：按当前播放列表 / 文件夹 / 单篇解析队列 */
  startFromNote(path: string, doc: ReadableDoc, title: string): void {
    this.runId++;
    const settings = this.deps.settings();
    const list = this.getActiveList();
    const listIndex = list ? list.items.findIndex((item) => item.path === path) : -1;

    if (list && listIndex >= 0) {
      this.queue = list.items.slice();
      this.queueListId = list.id;
      this.source = 'playlist';
      this.index = listIndex;
      this.allowAdvance = true;
    } else if (settings.autoFolderPlaylist) {
      const folderQueue = this.queueFromPathFolder(path, settings.playlistIncludeSubfolders);
      if (folderQueue.length > 1) {
        this.queue = folderQueue;
        this.queueListId = '';
        this.source = 'folder';
        this.index = Math.max(0, folderQueue.findIndex((item) => item.path === path));
        this.allowAdvance = true;
      } else {
        this.singleQueue(path, title);
      }
    } else {
      this.singleQueue(path, title);
    }

    this.rebuildShuffle();
    this.doc = doc;
    this.currentPath = path;
    this.title = title;
    this.advancing = false;
    this.emitChange();
    void this.deps.player.playDoc(doc, 0);
  }

  playPlaylist(listId: string, startIndex?: number): void {
    const list = this.deps.settings().playlists.find((item) => item.id === listId);
    if (!list) {
      this.notify('播放列表不存在');
      return;
    }
    if (!list.items.length) {
      this.notify('播放列表是空的');
      return;
    }

    const settings = this.deps.settings();
    if (settings.activePlaylistId !== list.id) {
      settings.activePlaylistId = list.id;
      void this.deps.save();
    }

    // 先停掉当前播放，避免首篇打开失败时旧文档继续播放却挂着新队列
    this.deps.player.stop();
    this.queue = list.items.slice();
    this.queueListId = list.id;
    this.source = 'playlist';
    this.index =
      settings.playbackMode === 'shuffle' && startIndex === undefined
        ? Math.floor(Math.random() * this.queue.length)
        : clampIndex(startIndex ?? 0, this.queue.length);
    this.allowAdvance = true;
    this.rebuildShuffle();
    this.emitChange();
    void this.playItemAt(this.index, false);
  }

  /** 用户停止 / 切换笔记时打断尚未完成的续播 */
  invalidate(): void {
    this.runId++;
    this.advancing = false;
    this.emitChange();
  }

  nextNote(): void {
    void this.manualAdvance(1);
  }

  prevNote(): void {
    void this.manualAdvance(-1);
  }

  /** Player 自然播完后的回调；返回 true 表示已启动下一段播放 */
  async handleDocEnded(): Promise<boolean> {
    if (!this.allowAdvance || !this.doc || !this.queue.length) return false;
    if (this.deps.player.getSnapshot().title !== this.title) return false;

    if (this.deps.settings().playbackMode === 'repeat-one') {
      const result = await this.playItemAt(this.index, true);
      return result === 'started';
    }

    for (let attempt = 0; attempt < this.queue.length; attempt++) {
      const target = this.findPlayable(1);
      if (target === null) break;
      const result = await this.playItemAt(target, false);
      if (result === 'started') return true;
      if (result === 'aborted') return false;
    }

    if (this.queue.length > 1) this.notify('播放列表已播完');
    return false;
  }

  // ---------- 模式 ----------

  setMode(mode: PlaybackMode): void {
    const settings = this.deps.settings();
    if (settings.playbackMode === mode) return;
    settings.playbackMode = mode;
    this.rebuildShuffle();
    void this.deps.save();
    this.emitChange();
  }

  cycleMode(): PlaybackMode {
    const current = this.deps.settings().playbackMode;
    const index = PLAYBACK_MODES.indexOf(current);
    const next = PLAYBACK_MODES[(index + 1) % PLAYBACK_MODES.length] ?? 'sequential';
    this.setMode(next);
    return next;
  }

  // ---------- 播放列表 CRUD ----------

  createList(name: string): Playlist {
    const now = Date.now();
    const list: Playlist = {
      id: randomUuid(),
      name: name.trim() || '未命名列表',
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    const settings = this.deps.settings();
    settings.playlists.push(list);
    settings.activePlaylistId = list.id;
    void this.deps.save();
    this.emitChange();
    return list;
  }

  renameList(listId: string, name: string): boolean {
    const list = this.deps.settings().playlists.find((item) => item.id === listId);
    if (!list) return false;
    const next = name.trim();
    if (!next || next === list.name) return false;
    list.name = next;
    list.updatedAt = Date.now();
    void this.deps.save();
    this.emitChange();
    return true;
  }

  deleteList(listId: string): boolean {
    const settings = this.deps.settings();
    const index = settings.playlists.findIndex((item) => item.id === listId);
    if (index < 0) return false;

    settings.playlists.splice(index, 1);
    if (settings.activePlaylistId === listId) {
      settings.activePlaylistId = settings.playlists[0]?.id ?? '';
    }

    if (this.queueListId === listId) {
      this.queueListId = '';
      this.source = 'single';
      this.queue = this.currentPath
        ? [{ path: this.currentPath, title: this.title }]
        : [];
      this.index = 0;
      this.allowAdvance = !!this.currentPath;
      this.shuffleOrder = [];
      this.shufflePos = 0;
    }

    void this.deps.save();
    this.emitChange();
    return true;
  }

  setActiveList(listId: string): boolean {
    const settings = this.deps.settings();
    if (listId && !settings.playlists.some((item) => item.id === listId)) return false;
    if (settings.activePlaylistId === listId) return true;
    settings.activePlaylistId = listId;
    void this.deps.save();
    this.emitChange();
    return true;
  }

  addPathsTo(listId: string, paths: string[]): number {
    const list = this.deps.settings().playlists.find((item) => item.id === listId);
    if (!list) return 0;

    const existing = new Set(list.items.map((item) => item.path));
    let added = 0;
    for (const raw of paths) {
      if (!raw || existing.has(raw)) continue;
      const file = this.deps.app.vault.getAbstractFileByPath(raw);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') continue;
      list.items.push({ path: file.path, title: file.basename });
      existing.add(file.path);
      added++;
    }

    if (added > 0) {
      list.updatedAt = Date.now();
      this.syncQueue(list);
      void this.deps.save();
      this.emitChange();
    }
    return added;
  }

  addPathsToActive(paths: string[]): number {
    let list = this.getActiveList();
    if (!list) list = this.createList('默认列表');
    return this.addPathsTo(list.id, paths);
  }

  addFolderTo(listId: string, folderPath: string, includeSubfolders: boolean): number {
    const items = this.buildFolderQueue(folderPath, includeSubfolders);
    return this.addPathsTo(listId, items.map((item) => item.path));
  }

  removeItem(listId: string, path: string): boolean {
    const list = this.deps.settings().playlists.find((item) => item.id === listId);
    if (!list) return false;
    const index = list.items.findIndex((item) => item.path === path);
    if (index < 0) return false;
    list.items.splice(index, 1);
    list.updatedAt = Date.now();
    this.syncQueue(list);
    void this.deps.save();
    this.emitChange();
    return true;
  }

  moveItem(listId: string, from: number, to: number): boolean {
    const list = this.deps.settings().playlists.find((item) => item.id === listId);
    if (!list) return false;
    if (from < 0 || from >= list.items.length) return false;
    const target = Math.min(list.items.length - 1, Math.max(0, to));
    if (target === from) return false;
    const [item] = list.items.splice(from, 1);
    if (!item) return false;
    list.items.splice(target, 0, item);
    list.updatedAt = Date.now();
    this.syncQueue(list);
    void this.deps.save();
    this.emitChange();
    return true;
  }

  clearList(listId: string): boolean {
    const list = this.deps.settings().playlists.find((item) => item.id === listId);
    if (!list || !list.items.length) return false;
    list.items = [];
    list.updatedAt = Date.now();
    this.syncQueue(list);
    void this.deps.save();
    this.emitChange();
    return true;
  }

  pruneMissing(listId: string): number {
    const list = this.deps.settings().playlists.find((item) => item.id === listId);
    if (!list) return 0;
    const before = list.items.length;
    list.items = list.items.filter((item) => this.fileExists(item.path));
    const removed = before - list.items.length;
    if (removed > 0) {
      list.updatedAt = Date.now();
      this.syncQueue(list);
      void this.deps.save();
      this.emitChange();
    }
    return removed;
  }

  buildFolderQueue(folderPath: string, includeSubfolders: boolean): PlaylistItem[] {
    const vault = this.deps.app.vault;
    let files: TFile[];

    if (includeSubfolders) {
      const prefix = folderPath === '/' || folderPath === '' ? '' : `${folderPath}/`;
      files = vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix));
    } else {
      const folder = vault.getAbstractFileByPath(folderPath);
      files =
        folder instanceof TFolder
          ? folder.children.filter(
              (child): child is TFile =>
                child instanceof TFile && child.extension.toLowerCase() === 'md',
            )
          : [];
    }

    return files
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path, 'zh'))
      .map((file) => ({ path: file.path, title: file.basename }));
  }

  /** 文件重命名后同步所有列表中的路径 */
  handleRename(oldPath: string, newPath: string): void {
    let changed = false;
    const settings = this.deps.settings();

    for (const list of settings.playlists) {
      let listChanged = false;
      for (const item of list.items) {
        if (item.path === oldPath || item.path.startsWith(`${oldPath}/`)) {
          item.path =
            item.path === oldPath ? newPath : `${newPath}${item.path.slice(oldPath.length)}`;
          item.title = basename(item.path) || item.title;
          listChanged = true;
        }
      }
      if (listChanged) {
        list.updatedAt = Date.now();
        changed = true;
      }
    }

    if (
      this.currentPath &&
      (this.currentPath === oldPath || this.currentPath.startsWith(`${oldPath}/`))
    ) {
      this.currentPath =
        this.currentPath === oldPath
          ? newPath
          : `${newPath}${this.currentPath.slice(oldPath.length)}`;
      changed = true;
    }

    if (changed) {
      this.syncQueue(this.getActiveList());
      void this.deps.save();
      this.emitChange();
    }
  }

  /** 文件删除后刷新界面；条目保留，播放时自动跳过 */
  handleDelete(): void {
    this.emitChange();
  }

  // ---------- 内部 ----------

  private singleQueue(path: string, title: string): void {
    this.queue = [{ path, title }];
    this.queueListId = '';
    this.source = 'single';
    this.index = 0;
    this.allowAdvance = true;
  }

  private rebuildShuffle(): void {
    if (this.deps.settings().playbackMode === 'shuffle' && this.queue.length) {
      const hasCurrent = this.hasCurrentInQueue();
      this.shuffleOrder = buildShuffleOrder(this.queue.length, hasCurrent ? this.index : -1);
      this.shufflePos = hasCurrent ? 0 : -1;
    } else {
      this.shuffleOrder = [];
      this.shufflePos = 0;
    }
  }

  private hasCurrentInQueue(): boolean {
    return (
      !!this.currentPath && this.queue.some((item) => item.path === this.currentPath)
    );
  }

  private async manualAdvance(direction: 1 | -1): Promise<void> {
    if (!this.allowAdvance || this.queue.length <= 1) return;
    for (let attempt = 0; attempt < this.queue.length; attempt++) {
      const target = this.findPlayable(direction);
      if (target === null) return;
      const result = await this.playItemAt(target, false);
      if (result === 'started' || result === 'aborted') return;
    }
  }

  private async playItemAt(index: number, reuseDoc: boolean): Promise<PlayResult> {
    const item = this.queue[index];
    if (!item) return 'skipped';

    const myRun = ++this.runId;
    this.advancing = true;
    this.emitChange();

    try {
      let doc: ReadableDoc | null = null;
      let title = item.title;

      if (reuseDoc && this.doc && this.currentPath === item.path) {
        doc = this.doc;
        title = this.title;
      } else {
        const opened = await this.deps.openNoteForReading(item.path);
        if (this.runId !== myRun) return 'aborted';
        if (!opened) {
          this.notify(`文件不存在：${item.path}`);
          return 'skipped';
        }

        const settings = this.deps.settings();
        title = opened.title || item.title;
        doc = buildReadableDoc(opened.text, {
          chunkChars: settings.chunkChars,
          perSentence: settings.perSentence,
          title,
        });
        if (!doc.chunks.length) {
          this.notify(`没有可朗读的文本：${title}`);
          return 'skipped';
        }
      }

      if (this.runId !== myRun) return 'aborted';

      this.index = index;
      this.currentPath = item.path;
      this.title = title;
      this.doc = doc;
      this.allowAdvance = true;
      if (this.deps.settings().playbackMode === 'shuffle') {
        const pos = this.shuffleOrder.indexOf(index);
        if (pos >= 0) this.shufflePos = pos;
      }

      this.advancing = false;
      this.emitChange();
      void this.deps.player.playDoc(doc, 0);
      return 'started';
    } catch (error) {
      if (this.runId === myRun) {
        this.notify(`播放失败：${error instanceof Error ? error.message : String(error)}`);
        return 'skipped';
      }
      return 'aborted';
    } finally {
      if (this.runId === myRun) {
        this.advancing = false;
        this.emitChange();
      }
    }
  }

  private findPlayable(direction: 1 | -1): number | null {
    const count = this.queue.length;
    if (!count) return null;

    if (this.deps.settings().playbackMode === 'shuffle') {
      let pos = this.shufflePos;
      for (let step = 0; step < this.shuffleOrder.length; step++) {
        pos += direction;
        if (pos < 0 || pos >= this.shuffleOrder.length) return null;
        const target = this.shuffleOrder[pos];
        if (target === undefined) continue;
        if (this.fileExists(this.queue[target]?.path ?? '')) {
          this.shufflePos = pos;
          return target;
        }
      }
      return null;
    }

    const mode = this.deps.settings().playbackMode;
    // 当前播放项可能已被移出列表：此时 index 指向“下一项”，从 index-1 起算
    let cursor = this.hasCurrentInQueue() ? this.index : this.index - 1;
    for (let step = 0; step < count; step++) {
      cursor += direction;
      if (mode === 'repeat-all') {
        if (cursor < 0) cursor = count - 1;
        else if (cursor >= count) cursor = 0;
      } else if (cursor < 0 || cursor >= count) {
        return null;
      }
      if (this.fileExists(this.queue[cursor]?.path ?? '')) return cursor;
    }
    return null;
  }

  private queueFromPathFolder(path: string, includeSubfolders: boolean): PlaylistItem[] {
    const file = this.deps.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return [];
    return this.buildFolderQueue(file.parent?.path ?? '/', includeSubfolders);
  }

  private fileExists(path: string): boolean {
    if (!path) return false;
    const file = this.deps.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile;
  }

  private syncQueue(list: Playlist | null): void {
    if (this.source !== 'playlist' || !list || list.id !== this.queueListId) return;
    this.queue = list.items.slice();
    const found = this.currentPath
      ? this.queue.findIndex((item) => item.path === this.currentPath)
      : -1;
    this.index = found >= 0 ? found : clampIndex(this.index, this.queue.length);
    if (!this.queue.length) this.allowAdvance = false;
    this.rebuildShuffle();
  }

  private notify(message: string): void {
    this.deps.notify(message);
  }

  private emitChange(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
  }
}

function basename(path: string): string {
  const name = path.split('/').pop() ?? '';
  return name.replace(/\.md$/i, '');
}
