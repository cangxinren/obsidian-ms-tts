import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  TFile,
  TFolder,
  setIcon,
} from 'obsidian';
import type MsTtsPlugin from './main';
import type { Playlist } from './types';
import { PLAYBACK_MODE_LABELS } from './playlist';

export class PlaylistManagerModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: MsTtsPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('播放列表');
    this.modalEl.addClass('ms-tts-playlist-modal');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const lists = this.plugin.playlist.getLists();
    let active = this.plugin.playlist.getActiveList();

    if (!lists.length) {
      contentEl.createEl('p', {
        cls: 'ms-tts-playlist-empty',
        text: '还没有播放列表。新建一个，或把当前笔记加进来。',
      });
      const actions = contentEl.createDiv({ cls: 'ms-tts-modal-actions' });
      this.textButton(actions, '新建播放列表', () => this.createList(), 'cta');
      this.textButton(actions, '添加当前笔记', () => this.addCurrentNote());
      return;
    }

    if (!active) {
      this.plugin.playlist.setActiveList(lists[0].id);
      active = lists[0];
    }

    const header = contentEl.createDiv({ cls: 'ms-tts-playlist-header' });
    const select = header.createEl('select', { cls: 'dropdown' });
    for (const list of lists) {
      select.createEl('option', {
        text: `${list.name}（${list.items.length}）`,
        value: list.id,
      });
    }
    select.value = active.id;
    select.onchange = () => {
      this.plugin.playlist.setActiveList(select.value);
      this.render();
    };

    this.textButton(header, '播放', () => {
      this.plugin.playlist.playPlaylist(active.id);
      this.close();
    }, 'cta');
    this.textButton(header, '新建', () => this.createList());
    this.textButton(header, '重命名', () => this.renameList());
    this.textButton(header, '删除', () => this.deleteList(), 'warning');

    const mode = this.plugin.playlist.getSnapshot().mode;
    contentEl.createEl('p', {
      cls: 'ms-tts-playlist-summary',
      text: `共 ${active.items.length} 篇 · 当前模式：${PLAYBACK_MODE_LABELS[mode]}`,
    });

    if (!active.items.length) {
      contentEl.createEl('p', {
        cls: 'ms-tts-playlist-empty',
        text: '这个列表还是空的。可以用下面的按钮添加笔记。',
      });
    } else {
      const snapshot = this.plugin.playlist.getSnapshot();
      const itemsEl = contentEl.createDiv({ cls: 'ms-tts-playlist-items' });
      active.items.forEach((item, index) => {
        const exists = this.app.vault.getAbstractFileByPath(item.path) instanceof TFile;
        const row = itemsEl.createDiv({ cls: 'ms-tts-playlist-item' });
        if (snapshot.currentPath === item.path) row.addClass('is-current');
        if (!exists) row.addClass('is-missing');

        row.createSpan({ cls: 'ms-tts-playlist-item-index', text: `${index + 1}.` });
        const main = row.createDiv({ cls: 'ms-tts-playlist-item-main' });
        main.createDiv({
          cls: 'ms-tts-playlist-item-title',
          text: item.title || item.path,
        });
        main.createDiv({
          cls: 'ms-tts-playlist-item-path',
          text: exists ? item.path : `${item.path}（文件不存在）`,
        });

        const actions = row.createDiv({ cls: 'ms-tts-playlist-item-actions' });
        this.rowButton(actions, 'chevron-up', '上移', index === 0, () => {
          this.plugin.playlist.moveItem(active.id, index, index - 1);
          this.render();
        });
        this.rowButton(
          actions,
          'chevron-down',
          '下移',
          index === active.items.length - 1,
          () => {
            this.plugin.playlist.moveItem(active.id, index, index + 1);
            this.render();
          },
        );
        this.rowButton(actions, 'play', '从这篇开始播放', false, () => {
          this.plugin.playlist.playPlaylist(active.id, index);
          this.close();
        });
        this.rowButton(actions, 'trash-2', '从列表移除', false, () => {
          this.plugin.playlist.removeItem(active.id, item.path);
          this.render();
        });
      });
    }

    const options = contentEl.createDiv({ cls: 'ms-tts-playlist-options' });
    const includeLabel = options.createEl('label');
    const includeCheckbox = includeLabel.createEl('input', {
      type: 'checkbox',
    }) as HTMLInputElement;
    includeCheckbox.checked = this.plugin.settings.playlistIncludeSubfolders;
    includeCheckbox.onchange = () => {
      this.plugin.settings.playlistIncludeSubfolders = includeCheckbox.checked;
      void this.plugin.saveSettings();
    };
    includeLabel.appendText(' 导入文件夹时包含子文件夹');

    const footer = contentEl.createDiv({ cls: 'ms-tts-playlist-footer' });
    this.textButton(footer, '添加当前笔记', () => this.addCurrentNote());
    this.textButton(footer, '导入文件夹', () => this.importFolder(active));
    this.textButton(footer, '多选笔记', () => this.pickNotes(active));
    this.textButton(footer, '清理失效', () => {
      const removed = this.plugin.playlist.pruneMissing(active.id);
      new Notice(removed ? `已清理 ${removed} 条失效条目` : '没有失效条目');
      this.render();
    });
    this.textButton(
      footer,
      '清空',
      () => {
        new ConfirmModal(
          this.app,
          '清空播放列表',
          `确定清空「${active.name}」吗？不会删除笔记文件。`,
          '清空',
          () => {
            this.plugin.playlist.clearList(active.id);
            this.render();
          },
        ).open();
      },
      'warning',
    );
  }

  private createList(): void {
    new TextInputModal(this.app, '新建播放列表', '播放列表名称', '', (name) => {
      this.plugin.playlist.createList(name);
      this.render();
    }).open();
  }

  private renameList(): void {
    const list = this.plugin.playlist.getActiveList();
    if (!list) return;
    new TextInputModal(this.app, '重命名播放列表', '播放列表名称', list.name, (name) => {
      this.plugin.playlist.renameList(list.id, name);
      this.render();
    }).open();
  }

  private deleteList(): void {
    const list = this.plugin.playlist.getActiveList();
    if (!list) return;
    new ConfirmModal(
      this.app,
      '删除播放列表',
      `确定删除「${list.name}」吗？只会删除列表，不会删除笔记文件。`,
      '删除',
      () => {
        this.plugin.playlist.deleteList(list.id);
        this.render();
      },
    ).open();
  }

  private addCurrentNote(): void {
    const file = this.plugin.getCurrentNoteFile();
    if (!file) {
      new Notice('请先打开一篇 Markdown 笔记');
      return;
    }
    const list = this.plugin.playlist.getActiveList() ?? this.plugin.playlist.createList('默认列表');
    const added = this.plugin.playlist.addPathsTo(list.id, [file.path]);
    new Notice(added ? `已加入「${list.name}」` : '这篇笔记已在列表中');
    this.render();
  }

  private importFolder(list: Playlist): void {
    new FolderPickerModal(this.app, (folderPath) => {
      const added = this.plugin.playlist.addFolderTo(
        list.id,
        folderPath,
        this.plugin.settings.playlistIncludeSubfolders,
      );
      new Notice(added ? `已导入 ${added} 篇笔记` : '文件夹里没有新的 Markdown 笔记');
      this.render();
    }).open();
  }

  private pickNotes(list: Playlist): void {
    new NotePickerModal(this.app, this.app.vault.getMarkdownFiles(), (paths) => {
      const added = this.plugin.playlist.addPathsTo(list.id, paths);
      new Notice(added ? `已加入 ${added} 篇笔记` : '所选笔记已在列表中');
      this.render();
    }).open();
  }

  private textButton(
    parent: HTMLElement,
    text: string,
    onClick: () => void,
    style?: 'cta' | 'warning',
  ): HTMLButtonElement {
    const button = parent.createEl('button', { text });
    if (style === 'cta') button.addClass('mod-cta');
    if (style === 'warning') button.addClass('mod-warning');
    button.onclick = onClick;
    return button;
  }

  private rowButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    disabled: boolean,
    onClick: () => void,
  ): void {
    const button = parent.createEl('button', {
      attr: { 'aria-label': label, title: label },
    });
    setIcon(button, icon);
    button.disabled = disabled;
    button.onclick = onClick;
  }
}

export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private readonly onChoose: (folderPath: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    super.onOpen();
    this.setPlaceholder('选择要导入的文件夹');
  }

  getItems(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder);
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder.path);
  }
}

export class NotePickerModal extends Modal {
  private readonly files: TFile[];
  private readonly selected = new Set<string>();
  private visible: TFile[] = [];
  private query = '';
  private listEl!: HTMLElement;
  private confirmButton!: HTMLButtonElement;

  constructor(
    app: App,
    files: TFile[],
    private readonly onChoose: (paths: string[]) => void,
  ) {
    super(app);
    this.files = files.slice().sort((a, b) => a.path.localeCompare(b.path, 'zh'));
  }

  onOpen(): void {
    this.titleEl.setText('选择笔记');
    this.modalEl.addClass('ms-tts-note-picker-modal');

    const search = this.contentEl.createEl('input', {
      cls: 'ms-tts-note-picker-search',
      type: 'search',
      placeholder: '搜索笔记标题或路径…',
    });
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderList();
    });

    const toolbar = this.contentEl.createDiv({ cls: 'ms-tts-note-picker-toolbar' });
    const selectAll = toolbar.createEl('button', { text: '全选当前结果' });
    selectAll.onclick = () => {
      for (const file of this.visible) this.selected.add(file.path);
      this.renderList();
    };
    const clear = toolbar.createEl('button', { text: '清空选择' });
    clear.onclick = () => {
      this.selected.clear();
      this.renderList();
    };

    this.listEl = this.contentEl.createDiv({ cls: 'ms-tts-note-picker-list' });

    const actions = this.contentEl.createDiv({ cls: 'ms-tts-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => this.close();
    this.confirmButton = actions.createEl('button', { text: '加入 0 篇', cls: 'mod-cta' });
    this.confirmButton.disabled = true;
    this.confirmButton.onclick = () => {
      if (!this.selected.size) return;
      this.onChoose(Array.from(this.selected));
      this.close();
    };

    this.renderList();
  }

  private renderList(): void {
    this.listEl.empty();
    const query = this.query.trim().toLowerCase();
    this.visible = this.files.filter((file) => {
      if (!query) return true;
      return (
        file.path.toLowerCase().includes(query) || file.basename.toLowerCase().includes(query)
      );
    });

    if (!this.visible.length) {
      this.listEl.createDiv({ cls: 'ms-tts-playlist-empty', text: '没有匹配的笔记' });
    } else {
      for (const file of this.visible.slice(0, 800)) {
        const row = this.listEl.createEl('label', { cls: 'ms-tts-note-picker-row' });
        const checkbox = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
        checkbox.checked = this.selected.has(file.path);
        checkbox.onchange = () => {
          if (checkbox.checked) this.selected.add(file.path);
          else this.selected.delete(file.path);
          this.updateCount();
        };
        row.createSpan({ cls: 'ms-tts-note-picker-title', text: file.basename });
        row.createSpan({ cls: 'ms-tts-note-picker-path', text: file.path });
      }
      if (this.visible.length > 800) {
        this.listEl.createDiv({
          cls: 'ms-tts-playlist-empty',
          text: `结果过多，仅显示前 800 篇；请输入关键词缩小范围。`,
        });
      }
    }

    this.updateCount();
  }

  private updateCount(): void {
    this.confirmButton.setText(`加入 ${this.selected.size} 篇`);
    this.confirmButton.disabled = this.selected.size === 0;
  }
}

export class PlaylistPickerModal extends FuzzySuggestModal<Playlist> {
  constructor(
    app: App,
    private readonly lists: Playlist[],
    private readonly onChoose: (list: Playlist) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    super.onOpen();
    this.setPlaceholder('选择目标播放列表');
  }

  getItems(): Playlist[] {
    return this.lists;
  }

  getItemText(list: Playlist): string {
    return `${list.name}（${list.items.length}）`;
  }

  onChooseItem(list: Playlist): void {
    this.onChoose(list);
  }
}

export class TextInputModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly placeholder: string,
    private readonly initial: string,
    private readonly onSubmit: (value: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    const input = this.contentEl.createEl('input', {
      cls: 'ms-tts-text-input',
      type: 'text',
      placeholder: this.placeholder,
    });
    input.value = this.initial;

    const actions = this.contentEl.createDiv({ cls: 'ms-tts-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => this.close();
    const confirm = actions.createEl('button', { text: '确定', cls: 'mod-cta' });
    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.onSubmit(value);
      this.close();
    };
    confirm.onclick = submit;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', { text: this.message });

    const actions = this.contentEl.createDiv({ cls: 'ms-tts-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => this.close();
    const confirm = actions.createEl('button', {
      text: this.confirmText,
      cls: 'mod-warning',
    });
    confirm.onclick = () => {
      this.onConfirm();
      this.close();
    };
  }
}
