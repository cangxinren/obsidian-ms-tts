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
export class App {}
export const Platform = { isDesktopApp: true };
export function setIcon() {}
export async function requestUrl() {
  throw new Error('requestUrl not available in this test stub');
}
