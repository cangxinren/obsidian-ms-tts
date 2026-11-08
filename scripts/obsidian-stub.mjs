export class Plugin {}
export class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
  }
}
export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}
export class Setting {}
export class Notice {
  constructor() {}
}
export class MarkdownView {}
export class WorkspaceLeaf {}
export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export class Modal {}
export class FuzzySuggestModal {}
export class TextComponent {}
export class ButtonComponent {}
export class ToggleComponent {}
export class DropdownComponent {}
export class TextAreaComponent {}
export class Component {}
export class App {}
export const Platform = { isDesktopApp: true };
export function setIcon() {}
export async function requestUrl() {
  throw new Error('requestUrl not available in this test stub');
}
