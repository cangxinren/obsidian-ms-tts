import { App, Modal, Notice, Setting, TFile, setIcon } from 'obsidian';
import type MsTtsPlugin from './main';
import type { ExportResult, ExportSource } from './exporter';
import { exportMergedAudio, prepareExportUnits } from './exporter';
import { describeError } from './errors';
import { FolderPickerModal, NotePickerModal, PlaylistPickerModal } from './playlist-modal';
import { formatBytes } from './util';
import { formatLrcDuration } from './lyrics';

interface QueueItem extends ExportSource {
  key: string;
}

export class ExportAudioModal extends Modal {
  private items: QueueItem[] = [];
  private customSeq = 0;
  private fileName = '';
  private fileNameTouched = false;
  private folder = '';
  private includeLyrics = true;
  private embedLyrics = true;
  private announceTitles = true;
  private includeSubfolders = false;
  private busy = false;
  private cancelled = false;
  private closed = false;

  private progressTextEl: HTMLElement | null = null;
  private progressFillEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: MsTtsPlugin,
    initialPaths: string[] = [],
  ) {
    super(app);
    const settings = plugin.settings;
    this.folder = settings.exportFolder ?? '';
    this.includeLyrics = settings.exportIncludeLyrics ?? true;
    this.embedLyrics = settings.exportEmbedLyrics ?? true;
    this.announceTitles = settings.exportAnnounceTitles ?? true;
    this.includeSubfolders = settings.playlistIncludeSubfolders;
    if (initialPaths.length) this.addInitialPaths(initialPaths);
  }

  onOpen(): void {
    this.titleEl.setText('导出音频');
    this.render();
  }

  onClose(): void {
    this.cancelled = true;
    this.closed = true;
    this.contentEl.empty();
  }

  private render(): void {
    if (this.busy) return;
    this.contentEl.empty();
    this.contentEl.addClass('ms-tts-export-modal');

    this.contentEl.createDiv({
      cls: 'ms-tts-export-hint',
      text: '选择整篇笔记、批量笔记或自定义文本，合成为一个音频文件；可同时生成歌词。',
    });

    const list = this.contentEl.createDiv({ cls: 'ms-tts-export-list' });
    this.renderQueue(list);

    const addRow = this.contentEl.createDiv({ cls: 'ms-tts-export-actions' });
    this.addAction(addRow, 'file-plus', '当前笔记', () => this.addCurrentNote());
    this.addAction(addRow, 'files', '多选笔记…', () => this.pickNotes());
    this.addAction(addRow, 'folder-plus', '导入文件夹…', () => this.pickFolder());
    this.addAction(addRow, 'list-music', '当前播放列表', () => this.addActivePlaylist());
    this.addAction(addRow, 'text-cursor-input', '添加自定义文本…', () => this.addCustomText());

    const subfolder = this.contentEl.createDiv({ cls: 'ms-tts-export-subfolder' });
    const subfolderToggle = subfolder.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
    subfolderToggle.checked = this.includeSubfolders;
    subfolderToggle.onchange = () => {
      this.includeSubfolders = subfolderToggle.checked;
    };
    subfolder.createSpan({ text: '文件夹导入时包含子文件夹' });

    const summary = this.contentEl.createDiv({ cls: 'ms-tts-export-summary' });
    const customChars = this.items
      .filter((item) => item.kind === 'custom')
      .reduce((sum, item) => sum + (item.text?.length ?? 0), 0);
    summary.setText(
      this.items.length
        ? `共 ${this.items.length} 项${customChars ? ` · 自定义文本 ${customChars} 字` : ''}`
        : '还没有添加任何来源',
    );

    new Setting(this.contentEl)
      .setName('文件名')
      .setDesc('实际文件名会自动追加「-朗读-时间」，重名时再加序号。')
      .addText((text) =>
        text.setValue(this.fileName).onChange((value) => {
          this.fileName = value;
          this.fileNameTouched = true;
        }),
      );

    new Setting(this.contentEl)
      .setName('保存目录')
      .setDesc('留空使用附件目录；填写 / 表示库根目录。')
      .addText((text) =>
        text.setValue(this.folder).onChange((value) => {
          this.folder = value;
        }),
      )
      .addButton((button) =>
        button.setButtonText('选择…').onClick(() => {
          new FolderPickerModal(this.app, (path) => {
            this.folder = path;
            this.render();
          }).open();
        }),
      );

    new Setting(this.contentEl)
      .setName('生成 .lrc 歌词')
      .setDesc('在音频同目录生成同名 LRC 歌词文件。')
      .addToggle((toggle) =>
        toggle.setValue(this.includeLyrics).onChange((value) => {
          this.includeLyrics = value;
        }),
      );

    new Setting(this.contentEl)
      .setName('内嵌歌词到 MP3')
      .setDesc('写入 ID3 标签（含同步歌词）。WAV 不支持内嵌，只会生成 .lrc。')
      .addToggle((toggle) =>
        toggle.setValue(this.embedLyrics).onChange((value) => {
          this.embedLyrics = value;
        }),
      );

    new Setting(this.contentEl)
      .setName('朗读每篇标题')
      .setDesc('多篇合并时，在每篇开头朗读《标题》；关闭则只在歌词里标记章节。')
      .addToggle((toggle) =>
        toggle.setValue(this.announceTitles).onChange((value) => {
          this.announceTitles = value;
        }),
      );

    const actions = this.contentEl.createDiv({ cls: 'ms-tts-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => this.close();
    const start = actions.createEl('button', { text: '开始导出', cls: 'mod-cta' });
    start.disabled = this.items.length === 0;
    start.onclick = () => {
      void this.startExport();
    };
  }

  private renderQueue(container: HTMLElement): void {
    container.empty();
    if (!this.items.length) {
      container.createDiv({ cls: 'ms-tts-playlist-empty', text: '添加笔记或自定义文本后开始导出。' });
      return;
    }

    this.items.forEach((item, index) => {
      const row = container.createDiv({ cls: 'ms-tts-playlist-item' });
      row.createSpan({ cls: 'ms-tts-playlist-item-index', text: String(index + 1) });

      const main = row.createDiv({ cls: 'ms-tts-playlist-item-main' });
      main.createDiv({
        cls: 'ms-tts-playlist-item-title',
        text: item.title || (item.kind === 'note' ? '未命名笔记' : '自定义文本'),
      });
      main.createDiv({
        cls: 'ms-tts-playlist-item-path',
        text:
          item.kind === 'note'
            ? item.path ?? ''
            : `${(item.text ?? '').length} 字 · 自定义文本`,
      });

      const actions = row.createDiv({ cls: 'ms-tts-playlist-item-actions' });
      iconButton(actions, 'arrow-up', '上移', index === 0, () => {
        this.move(index, -1);
      });
      iconButton(actions, 'arrow-down', '下移', index === this.items.length - 1, () => {
        this.move(index, 1);
      });
      iconButton(actions, 'x', '删除', false, () => {
        this.items.splice(index, 1);
        this.afterQueueChange();
      });
    });
  }

  private addAction(container: HTMLElement, icon: string, text: string, onClick: () => void): void {
    const button = container.createEl('button', { cls: 'ms-tts-export-action' });
    setIcon(button.createSpan({ cls: 'ms-tts-export-action-icon' }), icon);
    button.createSpan({ text });
    button.onclick = onClick;
  }

  private addInitialPaths(paths: string[]): void {
    const existing = new Set(this.items.map((item) => item.path));
    for (const path of paths) {
      if (existing.has(path)) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') continue;
      this.items.push({ kind: 'note', title: file.basename, path: file.path, key: `note:${path}` });
      existing.add(path);
    }
    this.fileName = this.defaultFileName();
  }

  private addCurrentNote(): void {
    const file = this.plugin.getCurrentNoteFile();
    if (!file) {
      new Notice('请先打开一篇笔记');
      return;
    }
    this.addNotePaths([file.path]);
  }

  private pickNotes(): void {
    new NotePickerModal(this.app, this.app.vault.getMarkdownFiles(), (paths) => {
      this.addNotePaths(paths);
    }).open();
  }

  private pickFolder(): void {
    new FolderPickerModal(this.app, (folderPath) => {
      const items = this.plugin.playlist.buildFolderQueue(folderPath, this.includeSubfolders);
      this.addNotePaths(items.map((item) => item.path));
    }).open();
  }

  private addActivePlaylist(): void {
    const active = this.plugin.playlist.getActiveList();
    if (active) {
      this.addNotePaths(active.items.map((item) => item.path));
      return;
    }

    const lists = this.plugin.playlist.getLists();
    if (!lists.length) {
      new Notice('还没有播放列表');
      return;
    }
    if (lists.length === 1) {
      this.addNotePaths(lists[0].items.map((item) => item.path));
      return;
    }

    new PlaylistPickerModal(this.app, lists, (list) => {
      this.addNotePaths(list.items.map((item) => item.path));
    }).open();
  }

  private addCustomText(): void {
    const defaultTitle = `自定义文本 ${this.customSeq + 1}`;
    new CustomTextModal(this.app, defaultTitle, (title, text) => {
      if (!text.trim()) {
        new Notice('自定义文本为空');
        return;
      }
      this.customSeq++;
      this.items.push({
        kind: 'custom',
        title: title.trim() || defaultTitle,
        text,
        key: `custom-${this.customSeq}`,
      });
      this.afterQueueChange();
    }).open();
  }

  private addNotePaths(paths: string[], notify = true): void {
    const existing = new Set(
      this.items.filter((item) => item.kind === 'note').map((item) => item.path),
    );
    let added = 0;
    let duplicate = 0;
    let missing = 0;

    for (const path of paths) {
      if (existing.has(path)) {
        duplicate++;
        continue;
      }
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') {
        missing++;
        continue;
      }
      this.items.push({ kind: 'note', title: file.basename, path: file.path, key: `note:${path}` });
      existing.add(path);
      added++;
    }

    this.afterQueueChange();
    if (notify) {
      const parts: string[] = [];
      if (added) parts.push(`已添加 ${added} 篇`);
      if (duplicate) parts.push(`跳过重复 ${duplicate} 篇`);
      if (missing) parts.push(`文件无效 ${missing} 篇`);
      new Notice(parts.join('，') || '没有新增笔记');
    }
  }

  private move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.items.length) return;
    const [item] = this.items.splice(index, 1);
    this.items.splice(target, 0, item);
    this.render();
  }

  private afterQueueChange(): void {
    if (!this.fileNameTouched) this.fileName = this.defaultFileName();
    this.render();
  }

  private defaultFileName(): string {
    if (!this.items.length) return '朗读音频';
    if (this.items.length === 1) return this.items[0].title || '朗读音频';
    return `${this.items[0].title || '朗读音频'}等${this.items.length}项`;
  }

  private async startExport(): Promise<void> {
    if (this.busy || !this.items.length) return;

    if (this.plugin.settings.provider === 'system') {
      new Notice('Windows 系统语音不支持导出音频，请切换到 Edge / 豆包 / OpenAI 兼容语音');
      return;
    }
    if (!this.plugin.tts.isConfigured()) {
      new Notice(`${this.plugin.tts.providerLabel()}尚未配置，无法导出`);
      return;
    }

    this.busy = true;
    this.cancelled = false;
    this.showProgress('正在准备…');

    const settings = this.plugin.settings;
    settings.exportIncludeLyrics = this.includeLyrics;
    settings.exportEmbedLyrics = this.embedLyrics;
    settings.exportAnnounceTitles = this.announceTitles;
    settings.exportFolder = this.folder.trim();
    settings.playlistIncludeSubfolders = this.includeSubfolders;
    void this.plugin.saveSettings();

    try {
      const sources: ExportSource[] = this.items.map(({ key: _key, ...source }) => source);
      const prepared = await prepareExportUnits(this.app, sources, settings, {
        announceTitles: this.announceTitles,
        isCancelled: () => this.cancelled,
        onProgress: (done, total) => this.updateProgress(`正在读取 ${done}/${total}`, done, total),
      });

      if (!prepared.units.length) {
        throw new Error(prepared.skipped.length ? '所选来源都没有可朗读的文本' : '没有可导出的文本');
      }

      const result = await exportMergedAudio(
        this.app,
        prepared.units,
        settings,
        this.plugin.tts,
        this.plugin.cache,
        {
          fileName: this.fileName,
          folder: this.folder.trim() === '' ? undefined : this.folder.trim(),
          includeLyrics: this.includeLyrics,
          embedLyrics: this.embedLyrics,
          skipped: prepared.skipped,
          isCancelled: () => this.cancelled,
          onProgress: (done, total) => this.updateProgress(`正在合成 ${done}/${total}`, done, total),
        },
      );

      this.busy = false;
      this.showResult(result);
    } catch (error) {
      this.busy = false;
      if (this.closed) return;
      this.cancelled = false;
      if (isCancelledError(error)) new Notice('已取消导出');
      else new Notice(`导出失败：${describeError(error)}`, 10000);
      this.render();
    }
  }

  private showProgress(message: string): void {
    this.contentEl.empty();
    this.contentEl.addClass('ms-tts-export-modal');
    this.progressTextEl = this.contentEl.createDiv({ cls: 'ms-tts-export-progress-text', text: message });
    const bar = this.contentEl.createDiv({ cls: 'ms-tts-progress' });
    this.progressFillEl = bar.createDiv({ cls: 'ms-tts-progress-fill' });

    const actions = this.contentEl.createDiv({ cls: 'ms-tts-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => {
      this.cancelled = true;
      cancel.disabled = true;
      this.progressTextEl?.setText('正在取消…');
    };
  }

  private updateProgress(message: string, done: number, total: number): void {
    this.progressTextEl?.setText(message);
    if (this.progressFillEl && total > 0) {
      this.progressFillEl.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
    }
  }

  private showResult(result: ExportResult): void {
    this.contentEl.empty();
    this.contentEl.addClass('ms-tts-export-modal');
    this.contentEl.createDiv({ cls: 'ms-tts-export-result-title', text: '导出完成' });

    const rows: Array<[string, string]> = [
      ['音频', result.audioPath],
      ['歌词', result.lyricsPath ?? (this.includeLyrics ? '未生成' : '未启用')],
      ['时长', formatLrcDuration(result.durationMs)],
      ['大小', formatBytes(result.size)],
    ];
    for (const [label, value] of rows) {
      const row = this.contentEl.createDiv({ cls: 'ms-tts-export-result-row' });
      row.createSpan({ cls: 'ms-tts-export-result-label', text: label });
      row.createSpan({ cls: 'ms-tts-export-result-value', text: value });
    }

    if (result.lyricsError) {
      this.contentEl.createDiv({
        cls: 'ms-tts-warning',
        text: `音频已保存，但歌词写入失败：${result.lyricsError}`,
      });
    }
    if (result.skipped.length) {
      this.contentEl.createDiv({
        cls: 'ms-tts-warning',
        text: `已跳过 ${result.skipped.length} 项：${result.skipped.join('、')}`,
      });
    }

    const actions = this.contentEl.createDiv({ cls: 'ms-tts-modal-actions' });
    const close = actions.createEl('button', { text: '关闭', cls: 'mod-cta' });
    close.onclick = () => this.close();
  }
}

export class CustomTextModal extends Modal {
  private titleValue: string;
  private textValue = '';

  constructor(
    app: App,
    defaultTitle: string,
    private readonly onAdd: (title: string, text: string) => void,
  ) {
    super(app);
    this.titleValue = defaultTitle;
  }

  onOpen(): void {
    this.titleEl.setText('添加自定义文本');
    this.contentEl.addClass('ms-tts-export-modal');

    const titleInput = this.contentEl.createEl('input', {
      cls: 'ms-tts-text-input',
      type: 'text',
      placeholder: '标题（用于文件名、章节和歌词）',
    });
    titleInput.value = this.titleValue;
    titleInput.oninput = () => {
      this.titleValue = titleInput.value;
    };

    const textarea = this.contentEl.createEl('textarea', { cls: 'ms-tts-export-textarea' });
    textarea.placeholder = '粘贴或输入要朗读的文本…';
    textarea.rows = 10;
    textarea.value = this.textValue;
    textarea.oninput = () => {
      this.textValue = textarea.value;
    };

    const actions = this.contentEl.createDiv({ cls: 'ms-tts-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => this.close();
    const add = actions.createEl('button', { text: '添加', cls: 'mod-cta' });
    add.onclick = () => {
      if (!this.textValue.trim()) {
        new Notice('请先输入文本');
        return;
      }
      this.onAdd(this.titleValue.trim() || '自定义文本', this.textValue);
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function iconButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  disabled: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const button = parent.createEl('button', { attr: { 'aria-label': label } });
  setIcon(button, icon);
  button.disabled = disabled;
  button.onclick = onClick;
  return button;
}

function isCancelledError(error: unknown): boolean {
  return error instanceof Error && /取消/.test(error.message);
}
