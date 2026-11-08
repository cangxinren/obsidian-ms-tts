import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type MsTtsPlugin from './main';
import type { KeyStorage, MsTtsSettings, PlaybackMode, ProviderId, VoiceOption } from './types';
import { describeError } from './errors';
import { formatBytes } from './util';
import { DOUBAO_VOICES, openAiVoiceOptions, voiceLabel } from './voices';
import { PLAYBACK_MODE_LABELS, PLAYBACK_MODES } from './playlist';

const CATEGORY_ORDER = ['新闻播报', '对话/教学', '有声书', '方言', '体育解说', '通用', '英文', '多语种', '其他语言'];

export class MsTtsSettingsTab extends PluginSettingTab {
  private readonly msPlugin: MsTtsPlugin;
  private localeFilter = 'zh-CN';
  private categoryFilter = '全部';
  private voiceFilter = '';

  constructor(app: App, plugin: MsTtsPlugin) {
    super(app, plugin);
    this.msPlugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: '微软语音朗读' });
    containerEl.createEl('p', {
      text: '可选择免密钥的微软 Edge 语音、豆包/火山引擎，或任意 OpenAI 兼容语音接口。默认 Edge 语音无需配置即可使用。',
    });

    this.renderProvider(containerEl);
    this.renderProviderSettings(containerEl);
    this.renderProsody(containerEl);
    this.renderPlayback(containerEl);
    this.renderPlaylists(containerEl);
    this.renderCache(containerEl);
    this.renderSystem(containerEl);
    this.renderMisc(containerEl);
  }

  private async save<K extends keyof MsTtsSettings>(key: K, value: MsTtsSettings[K]): Promise<void> {
    this.msPlugin.settings[key] = value;
    await this.msPlugin.saveSettings();
  }

  private renderProvider(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '语音引擎' });

    new Setting(containerEl)
      .setName('引擎')
      .setDesc('Edge 免密钥、最容易上手；豆包有新闻/教学专用音色；OpenAI 兼容接口适合自建或硅基流动。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('edge', '微软 Edge 免费语音（免密钥，推荐）')
          .addOption('doubao', '豆包 / 火山引擎（有免费额度）')
          .addOption('openai', 'OpenAI 兼容 / 硅基流动（按量计费）')
          .addOption('system', 'Windows 系统语音（离线兜底）')
          .setValue(this.msPlugin.settings.provider)
          .onChange(async (value) => {
            await this.save('provider', value as ProviderId);
            this.msPlugin.onProviderChanged();
            this.display();
          }),
      );

    const provider = this.msPlugin.settings.provider;
    if (provider === 'edge') {
      containerEl.createEl('p', {
        cls: 'ms-tts-warning',
        text: 'Edge 语音使用微软 Edge「大声朗读」接口，免密钥、免费，但不是微软公开 API，可能随微软更新失效。新闻播报推荐「云扬」，对话/教学推荐「晓晓」「云希」。',
      });
    } else if (provider === 'doubao') {
      containerEl.createEl('p', {
        cls: 'ms-tts-warning',
        text: '豆包语音需要火山引擎账号并完成实名认证；新用户约有 2 万字符 / 半年的语音合成试用额度。V1 接口不支持音调参数。',
      });
    } else if (provider === 'openai') {
      containerEl.createEl('p', {
        cls: 'ms-tts-warning',
        text: 'OpenAI 兼容接口需要 API Key。默认填入硅基流动 CosyVoice2（约 ¥0.05/千字符，新用户有代金券）。Base URL 需要包含 /v1。',
      });
    }
  }

  private renderProviderSettings(containerEl: HTMLElement): void {
    const provider = this.msPlugin.settings.provider;

    if (provider === 'edge') {
      this.renderEdge(containerEl);
    } else if (provider === 'doubao') {
      this.renderDoubao(containerEl);
    } else if (provider === 'openai') {
      this.renderOpenAi(containerEl);
    } else {
      return;
    }

    this.renderKeyStorage(containerEl);
    this.renderConnectionTest(containerEl);
  }

  private renderEdge(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '微软 Edge 语音' });

    const voices = this.msPlugin.voices;
    const locales = unique(this.msPlugin.voices.map((voice) => voice.locale));
    if (!locales.includes(this.localeFilter)) {
      this.localeFilter = locales.includes('zh-CN') ? 'zh-CN' : locales[0] ?? '';
    }

    const categories = ['全部', ...CATEGORY_ORDER.filter((item) =>
      this.msPlugin.voices.some((voice) => voice.categories.includes(item)),
    )];
    if (!categories.includes(this.categoryFilter)) this.categoryFilter = '全部';

    new Setting(containerEl)
      .setName('语音列表')
      .setDesc(`当前已加载 ${voices.length} 个语音。首次使用建议点击「刷新语音列表」。`)
      .addButton((button) =>
        button.setButtonText('刷新语音列表').onClick(async () => {
          try {
            const list = await this.msPlugin.refreshVoices();
            new Notice(`已获取 ${list.length} 个 Edge 语音`);
            this.display();
          } catch (error) {
            new Notice(describeError(error), 10000);
          }
        }),
      );

    new Setting(containerEl)
      .setName('语言过滤')
      .addDropdown((dropdown) => {
        for (const locale of locales) dropdown.addOption(locale, locale);
        dropdown.setValue(this.localeFilter).onChange((value) => {
          this.localeFilter = value;
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('场景过滤')
      .addDropdown((dropdown) => {
        for (const category of categories) dropdown.addOption(category, category);
        dropdown.setValue(this.categoryFilter).onChange((value) => {
          this.categoryFilter = value;
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('搜索语音')
      .addText((text) =>
        text
          .setPlaceholder('例如 云扬 / Yunyang / 新闻')
          .setValue(this.voiceFilter)
          .onChange((value) => {
            this.voiceFilter = value;
          }),
      )
      .addButton((button) => button.setButtonText('应用').onClick(() => this.display()));

    const filtered = this.filteredEdgeVoices();
    new Setting(containerEl)
      .setName('语音')
      .setDesc(`当前筛选结果 ${filtered.length} 个。推荐：新闻播报「云扬」，对话/教学「晓晓 / 云希」。`)
      .addDropdown((dropdown) => {
        for (const voice of filtered) dropdown.addOption(voice.id, voiceLabel(voice));
        if (!filtered.some((voice) => voice.id === this.msPlugin.settings.edgeVoice)) {
          dropdown.addOption(
            this.msPlugin.settings.edgeVoice,
            `${this.msPlugin.settings.edgeVoice}（当前，未在筛选结果中）`,
          );
        }
        dropdown.setValue(this.msPlugin.settings.edgeVoice).onChange(async (value) => {
          await this.save('edgeVoice', value);
          this.display();
        });
      })
      .addButton((button) =>
        button.setButtonText('试听').setCta().onClick(() => {
          void this.msPlugin.previewVoice();
        }),
      );

    new Setting(containerEl)
      .setName('手动填写 ShortName')
      .setDesc('可直接填写，例如 zh-CN-YunyangNeural、zh-CN-XiaoxiaoNeural。')
      .addText((text) =>
        text
          .setPlaceholder('zh-CN-YunyangNeural')
          .setValue(this.msPlugin.settings.edgeVoice)
          .onChange((value) => {
            void this.save('edgeVoice', value.trim());
          }),
      );
  }

  private renderDoubao(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '豆包 / 火山引擎' });

    new Setting(containerEl)
      .setName('AppID')
      .setDesc('火山引擎语音应用详情页中的 APP ID。')
      .addText((text) =>
        text
          .setPlaceholder('例如 123456789')
          .setValue(this.msPlugin.settings.doubaoAppId)
          .onChange((value) => {
            void this.save('doubaoAppId', value.trim());
          }),
      );

    const tokenSetting = new Setting(containerEl)
      .setName('Access Token')
      .setDesc('火山引擎语音应用的 Access Token，只保存在本机。')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('粘贴 Access Token')
          .setValue(this.msPlugin.getSecret('doubao'))
          .onChange((value) => this.msPlugin.setSecret('doubao', value));
      });

    tokenSetting.addButton((button) =>
      button.setButtonText('显示/隐藏').onClick(() => togglePassword(tokenSetting)),
    );

    new Setting(containerEl)
      .setName('Cluster')
      .setDesc('V1 小模型接口固定为 volcano_tts。')
      .addText((text) =>
        text
          .setPlaceholder('volcano_tts')
          .setValue(this.msPlugin.settings.doubaoCluster)
          .onChange((value) => {
            void this.save('doubaoCluster', value.trim());
          }),
      );

    this.renderVoiceDropdown(containerEl, DOUBAO_VOICES, 'doubaoVoice', {
      title: '音色',
      description: '新闻播报推荐 BV011 / BV012；教学推荐 BV034 / BV033。',
    });

    new Setting(containerEl)
      .setName('手动填写音色 ID')
      .setDesc('例如 BV011_streaming。V1 接口不支持 2.0 音色（uranus 系列）。')
      .addText((text) =>
        text
          .setPlaceholder('BV011_streaming')
          .setValue(this.msPlugin.settings.doubaoVoice)
          .onChange((value) => {
            void this.save('doubaoVoice', value.trim());
          }),
      );
  }

  private renderOpenAi(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'OpenAI 兼容语音' });

    new Setting(containerEl)
      .setName('Base URL')
      .setDesc('需要包含 /v1，例如 https://api.siliconflow.cn/v1。')
      .addText((text) =>
        text
          .setPlaceholder('https://api.siliconflow.cn/v1')
          .setValue(this.msPlugin.settings.openaiBaseUrl)
          .onChange((value) => {
            void this.save('openaiBaseUrl', value.trim());
          }),
      );

    const keySetting = new Setting(containerEl)
      .setName('API Key')
      .setDesc('只保存在本机，不写入笔记库。')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('sk-...')
          .setValue(this.msPlugin.getSecret('openai'))
          .onChange((value) => this.msPlugin.setSecret('openai', value));
      });

    keySetting.addButton((button) =>
      button.setButtonText('显示/隐藏').onClick(() => togglePassword(keySetting)),
    );

    new Setting(containerEl)
      .setName('模型')
      .setDesc('硅基流动推荐 FunAudioLLM/CosyVoice2-0.5B；也可填 fishaudio/fish-speech-1.5。')
      .addText((text) =>
        text
          .setPlaceholder('FunAudioLLM/CosyVoice2-0.5B')
          .setValue(this.msPlugin.settings.openaiModel)
          .onChange((value) => {
            void this.save('openaiModel', value.trim());
          }),
      )
      .addButton((button) =>
        button.setButtonText('更新音色列表').onClick(() => this.display()),
      );

    const options = openAiVoiceOptions(this.msPlugin.settings.openaiModel);
    this.renderVoiceDropdown(containerEl, options, 'openaiVoice', {
      title: '音色',
      description: 'CosyVoice2 预置音色：claire 温柔女声、alex 沉稳男声、diana 欢快女声。',
    });

    new Setting(containerEl)
      .setName('手动填写 voice')
      .setDesc('自定义服务或克隆音色可直接填写 voice 参数。')
      .addText((text) =>
        text
          .setPlaceholder('FunAudioLLM/CosyVoice2-0.5B:claire')
          .setValue(this.msPlugin.settings.openaiVoice)
          .onChange((value) => {
            void this.save('openaiVoice', value.trim());
          }),
      );
  }

  private renderVoiceDropdown(
    containerEl: HTMLElement,
    options: VoiceOption[],
    key: 'doubaoVoice' | 'openaiVoice',
    config: { title: string; description: string },
  ): void {
    const current = this.msPlugin.settings[key];
    new Setting(containerEl)
      .setName(config.title)
      .setDesc(config.description)
      .addDropdown((dropdown) => {
        for (const voice of options) dropdown.addOption(voice.id, voiceLabel(voice));
        if (current && !options.some((voice) => voice.id === current)) {
          dropdown.addOption(current, `${current}（当前）`);
        }
        dropdown.setValue(current).onChange(async (value) => {
          await this.save(key, value);
          this.display();
        });
      })
      .addButton((button) =>
        button.setButtonText('试听').setCta().onClick(() => {
          void this.msPlugin.previewVoice();
        }),
      );
  }

  private renderKeyStorage(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('密钥保存方式')
      .setDesc('「本机保存」写入 Obsidian 用户目录，不进入笔记库、不随 OneDrive 同步；「仅本次会话」重启后需重输。')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('local', '本机保存（localStorage）')
          .addOption('session', '仅本次会话')
          .setValue(this.msPlugin.settings.keyStorage)
          .onChange(async (value) => {
            this.msPlugin.setKeyStorage(value as KeyStorage);
            await this.save('keyStorage', value as KeyStorage);
            this.display();
          }),
      );
  }

  private renderConnectionTest(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('连接测试')
      .setDesc('Edge 会刷新语音列表；豆包 / OpenAI 兼容接口会实际合成一句短文本。')
      .addButton((button) =>
        button
          .setButtonText('测试连接')
          .setCta()
          .onClick(async () => {
            try {
              new Notice(await this.msPlugin.testConnection(), 8000);
              this.display();
            } catch (error) {
              new Notice(describeError(error), 10000);
            }
          }),
      )
      .addButton((button) =>
        button.setButtonText('试听当前语音').onClick(() => {
          void this.msPlugin.previewVoice();
        }),
      );
  }

  private renderProsody(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '语调' });
    const provider = this.msPlugin.settings.provider;

    new Setting(containerEl)
      .setName('语速')
      .setDesc('0.50–2.00 倍，1.00 为正常速度。')
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 2, 0.05)
          .setValue(this.msPlugin.settings.rate)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.save('rate', value);
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon('rotate-ccw')
          .setTooltip('恢复 1.00')
          .onClick(async () => {
            await this.save('rate', 1);
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('音调')
      .setDesc(
        provider === 'doubao'
          ? '豆包 V1 接口不支持音调，此项会被忽略。'
          : provider === 'openai'
            ? 'OpenAI 兼容接口通常不支持音调，此项可能被忽略。'
            : '-12 到 +12 半音，0 为原声。',
      )
      .addSlider((slider) =>
        slider
          .setLimits(-12, 12, 1)
          .setValue(this.msPlugin.settings.pitch)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.save('pitch', value);
          }),
      )
      .addExtraButton((button) =>
        button
          .setIcon('rotate-ccw')
          .setTooltip('恢复 0')
          .onClick(async () => {
            await this.save('pitch', 0);
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('音量')
      .setDesc(
        provider === 'openai'
          ? 'OpenAI 兼容接口通常不支持音量，此项可能被忽略。'
          : '0–100，默认 100。豆包会映射到 0.5–2.0 的响度倍率。',
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 5)
          .setValue(this.msPlugin.settings.volume)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.save('volume', value);
          }),
      );
  }

  private renderPlayback(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '播放行为' });

    new Setting(containerEl)
      .setName('播放模式')
      .setDesc('顺序：播完列表停止；单篇循环：重复当前笔记；列表循环：列表末尾回到开头；随机：打乱整个列表，播完停止。')
      .addDropdown((dropdown) => {
        for (const mode of PLAYBACK_MODES) {
          dropdown.addOption(mode, PLAYBACK_MODE_LABELS[mode]);
        }
        dropdown.setValue(this.msPlugin.settings.playbackMode).onChange((value) => {
          this.msPlugin.setPlaybackMode(value as PlaybackMode);
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('自动用所在文件夹成列')
      .setDesc('朗读整篇笔记时，如果它不在当前播放列表中，自动把同文件夹的笔记作为临时播放列表。')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.autoFolderPlaylist).onChange((value) => {
          void this.save('autoFolderPlaylist', value);
        }),
      );

    new Setting(containerEl)
      .setName('文件夹导入包含子文件夹')
      .setDesc('按文件夹导入或自动成列时，是否包含子文件夹里的笔记。')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.playlistIncludeSubfolders).onChange((value) => {
          void this.save('playlistIncludeSubfolders', value);
        }),
      );

    new Setting(containerEl)
      .setName('每块字符数')
      .setDesc('默认 300。越大请求越少，但逐句高亮的估算误差越大；豆包会自动按 900 字节再切分。')
      .addSlider((slider) =>
        slider
          .setLimits(120, 800, 20)
          .setValue(this.msPlugin.settings.chunkChars)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.save('chunkChars', value);
          }),
      );

    new Setting(containerEl)
      .setName('逐句合成（精确高亮）')
      .setDesc('每句单独请求，高亮完全同步；请求数会明显增加。')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.perSentence).onChange((value) => {
          void this.save('perSentence', value);
        }),
      );

    new Setting(containerEl)
      .setName('预取下一段')
      .setDesc('当前段播放时提前合成下一段，减少停顿。')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.prefetch).onChange((value) => {
          void this.save('prefetch', value);
        }),
      );

    new Setting(containerEl)
      .setName('逐句高亮')
      .setDesc('在编辑/实时预览模式下高亮当前朗读句。')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.highlight).onChange((value) => {
          void this.save('highlight', value);
        }),
      );

    new Setting(containerEl)
      .setName('自动滚动')
      .setDesc('高亮推进时把当前句滚到可见区域。')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.autoScroll).onChange((value) => {
          void this.save('autoScroll', value);
        }),
      );

    new Setting(containerEl)
      .setName('失败时自动改用系统语音')
      .setDesc('接口不可用、网络错误或鉴权失败时，自动切换到 Windows 本地语音。')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.autoFallbackSystem).onChange((value) => {
          void this.save('autoFallbackSystem', value);
        }),
      );

    new Setting(containerEl)
      .setName('朗读时打开播放器面板')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.openPanelOnPlay).onChange((value) => {
          void this.save('openPanelOnPlay', value);
        }),
      );

    new Setting(containerEl)
      .setName('显示状态栏进度')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.showStatusBar).onChange((value) => {
          void this.save('showStatusBar', value);
          this.msPlugin.refreshStatusBar();
        }),
      );
  }

  private renderPlaylists(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '播放列表' });

    const lists = this.msPlugin.playlist.getLists();
    const active = this.msPlugin.playlist.getActiveList();
    new Setting(containerEl)
      .setName('播放列表管理')
      .setDesc(
        lists.length
          ? `共有 ${lists.length} 个列表${active ? `，当前「${active.name}」共 ${active.items.length} 篇` : ''}。`
          : '还没有播放列表。可以新建，或把当前笔记 / 文件夹加进来。',
      )
      .addButton((button) =>
        button.setButtonText('管理播放列表').setCta().onClick(() => {
          this.msPlugin.openPlaylistManager();
        }),
      );
  }

  private renderCache(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '音频缓存' });

    new Setting(containerEl)
      .setName('启用缓存')
      .setDesc('按「引擎+语音+语调+文本」缓存 MP3，重复朗读不再请求。缓存在 IndexedDB，不进入笔记库。')
      .addToggle((toggle) =>
        toggle.setValue(this.msPlugin.settings.cacheEnabled).onChange((value) => {
          void this.save('cacheEnabled', value);
        }),
      );

    new Setting(containerEl)
      .setName('缓存上限')
      .setDesc('超过上限后按最久未使用顺序清理。')
      .addSlider((slider) =>
        slider
          .setLimits(50, 1000, 50)
          .setValue(this.msPlugin.settings.cacheMaxMB)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.save('cacheMaxMB', value);
            void this.msPlugin.cache.evict(value * 1024 * 1024);
          }),
      );

    const statsSetting = new Setting(containerEl)
      .setName('缓存状态')
      .setDesc('统计中…')
      .addButton((button) =>
        button
          .setButtonText('清空缓存')
          .setWarning()
          .onClick(async () => {
            await this.msPlugin.cache.clear();
            new Notice('已清空音频缓存');
            this.display();
          }),
      );

    void this.msPlugin.cache.stats().then((stats) => {
      statsSetting.setDesc(`已缓存 ${stats.count} 段，共 ${formatBytes(stats.bytes)}。`);
    });
  }

  private renderSystem(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Windows 系统语音兜底' });

    const voices = this.msPlugin.systemVoices();
    if (!voices.length) {
      new Setting(containerEl)
        .setName('系统语音')
        .setDesc('当前没有检测到系统语音。Windows 可在「设置 → 时间和语言 → 语言和区域」安装中文语音包。');
    } else {
      new Setting(containerEl)
        .setName('系统语音')
        .setDesc(`检测到 ${voices.length} 个本地语音。仅在引擎选择「系统语音」或自动兜底时使用。`)
        .addDropdown((dropdown) => {
          for (const voice of voices) {
            dropdown.addOption(voice.voiceURI, `${voice.name} (${voice.lang})`);
          }
          dropdown.setValue(this.msPlugin.settings.systemVoiceURI || voices[0].voiceURI).onChange((value) => {
            void this.save('systemVoiceURI', value);
          });
        });
    }

    new Setting(containerEl)
      .setName('系统语音语速')
      .setDesc('0.50–2.00 倍。')
      .addSlider((slider) =>
        slider
          .setLimits(0.5, 2, 0.05)
          .setValue(this.msPlugin.settings.systemRate)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.save('systemRate', value);
          }),
      );

    new Setting(containerEl)
      .setName('系统语音音调')
      .setDesc('-12 到 +12，映射到浏览器 speechSynthesis 的 0.1–2 范围。')
      .addSlider((slider) =>
        slider
          .setLimits(-12, 12, 1)
          .setValue(this.msPlugin.settings.systemPitch)
          .setDynamicTooltip()
          .onChange((value) => {
            void this.save('systemPitch', value);
          }),
      );
  }

  private renderMisc(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: '隐私与说明' });

    containerEl.createEl('p', {
      cls: 'ms-tts-warning',
      text: '朗读文本会发送到所选引擎的服务器：Edge 发送到微软，豆包发送到火山引擎，OpenAI 兼容接口发送到你填写的地址。密钥只保存在本机 Obsidian 用户目录，不写入笔记库，请不要把密钥粘贴到笔记里。',
    });

    const links = containerEl.createEl('p');
    links.createEl('a', {
      text: '火山引擎语音控制台',
      href: 'https://console.volcengine.com/speech/',
    });
    links.appendText(' · ');
    links.createEl('a', {
      text: '硅基流动 API Key',
      href: 'https://cloud.siliconflow.cn/account/ak',
    });
    links.appendText(' · ');
    links.createEl('a', {
      text: '硅基流动定价',
      href: 'https://www.siliconflow.cn/pricing',
    });

    containerEl.createEl('p', {
      text: 'Edge 语音为免密钥方案，不支持「说话风格」；新闻/教学语气请通过选择不同音色实现（云扬=新闻，晓晓/云希=对话教学）。',
    });
  }

  private filteredEdgeVoices(): VoiceOption[] {
    const query = this.voiceFilter.trim().toLowerCase();
    return this.msPlugin.voices.filter((voice) => {
      if (this.localeFilter && voice.locale !== this.localeFilter) return false;
      if (this.categoryFilter !== '全部' && !voice.categories.includes(this.categoryFilter)) return false;
      if (query) {
        const haystack = `${voice.id} ${voice.name} ${voice.description ?? ''} ${voice.categories.join(' ')}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => {
    const score = (value: string) => (value === 'zh-CN' ? 0 : value.startsWith('zh') ? 1 : 2);
    return score(a) - score(b) || a.localeCompare(b);
  });
}

function togglePassword(setting: Setting): void {
  const input = setting.controlEl.querySelector('input');
  if (input) input.type = input.type === 'password' ? 'text' : 'password';
}
