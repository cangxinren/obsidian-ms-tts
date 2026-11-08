# 微软语音朗读 · Microsoft TTS Reader

[![GitHub release](https://img.shields.io/github/v/release/cangxinren/obsidian-ms-tts?display_name=tag&sort=semver)](https://github.com/cangxinren/obsidian-ms-tts/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.5.0%2B-7C3AED)](https://obsidian.md)
[![Desktop only](https://img.shields.io/badge/platform-desktop-blue)](#已知限制)

用 **微软 Edge 免费语音**、**豆包 / 火山引擎** 或 **任意 OpenAI 兼容 TTS** 朗读 Obsidian 笔记。支持选择语音、语速、音调，逐句高亮跟随、音频缓存、侧边栏播放器与整篇音频导出。

> Read your Obsidian notes aloud with free Microsoft Edge voices, Doubao/Volcengine, or any OpenAI-compatible TTS. Voice selection, speech rate, pitch, sentence highlighting, audio cache and MP3/WAV export. Desktop only.

## 功能

- 朗读选区、从光标处朗读、朗读整篇笔记
- 语音列表可搜索、按语言/场景过滤（Edge 全量 300+ 语音）
- 语速 0.5–2.0、音调 -12～+12 半音、音量可调
- 编辑 / 实时预览模式逐句高亮 + 自动滚动
- 侧边栏播放器：当前句、进度、上一段 / 下一段、暂停 / 继续 / 停止
- 音频缓存（IndexedDB，不进入笔记库、不随 OneDrive 同步）
- 导出整篇为 MP3（接口返回 WAV 时自动导出 WAV）
- 接口失败、断网或未配置密钥时自动切换 Windows 系统语音

## 引擎对比

| 引擎 | 密钥 | 费用 | 中文音色 | 适合场景 |
|---|---|---|---|---|
| 微软 Edge 免费语音 | **不需要** | 免费 | 晓晓、云扬、云健、云希、晓伊、云夏、方言 | 新闻播报、对话教学、日常朗读 |
| 豆包 / 火山引擎 V1 | AppID + Access Token | 新用户约 2 万字符 / 半年 | BV011/BV012 新闻、BV034/BV033 教学、BV700/BV705 情感 | 新闻播报、课程讲解、长文 |
| OpenAI 兼容 / 硅基流动 | API Key | ¥0.05 / 千字符起 | alex、claire、diana 等 8 个 CosyVoice2 音色 | 通用朗读、对话讲解 |
| Windows 系统语音 | 不需要 | 免费离线 | 取决于系统中文语音包 | 无网络 / 接口失效兜底 |

**音色推荐**

- 新闻播报：Edge「云扬」、豆包 `BV011_streaming`（女）/ `BV012_streaming`（男）
- 对话 / 教学：Edge「晓晓」「云希」「晓伊」「云夏」、豆包 `BV034_streaming`（知性姐姐）/ `BV033_streaming`（温柔小哥）
- 长篇听书：豆包 `BV142_streaming`（沉稳解说男）、Edge「云健」

> **关于 Edge 语音**：它使用微软 Edge 浏览器「大声朗读」接口，免密钥、免费，但不是微软公开 API，微软可能随时调整协议。插件已内置系统语音兜底，失效时请更新插件或切换引擎。
>
> **关于豆包**：豆包没有“完全免费、免密钥”的官方接口。需要使用火山引擎账号、完成实名认证，并创建应用获取 AppID / Access Token；新用户有试用额度。

## 安装

### 从 Release 安装（推荐）

1. 打开 [最新 Release](https://github.com/cangxinren/obsidian-ms-tts/releases/latest)。
2. 下载 `main.js`、`manifest.json`、`styles.css` 三个文件；也可以直接下载 `ms-tts-reader-v0.2.0.zip` 解压使用。
3. 在笔记库中创建目录：

   ```text
   <你的库>/.obsidian/plugins/ms-tts-reader/
   ```

4. 把三个文件放入该目录。
5. Obsidian → 设置 → 第三方插件 → 关闭安全模式 → 刷新 → 启用「微软语音朗读」。
6. 默认使用 Edge 免费语音，**无需配置**；打开笔记点左侧喇叭即可朗读。

### 使用 BRAT 安装

已安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 时，添加 Beta 插件：

```text
cangxinren/obsidian-ms-tts
```

BRAT 会从 Release 下载插件文件。

### 从源码构建

需要 Node.js 20+：

```bash
git clone https://github.com/cangxinren/obsidian-ms-tts.git
cd obsidian-ms-tts
npm install
npm run build
```

把 `main.js`、`manifest.json`、`styles.css` 复制到 `<你的库>/.obsidian/plugins/ms-tts-reader/`。

仓库内提供了 PowerShell 部署脚本：

```powershell
powershell -NoProfile -File .\scripts\deploy.ps1 -Vault "<你的库路径>"
```

## 使用

| 命令 | 说明 |
|---|---|
| 朗读选区 | 编辑模式读选中文字；阅读模式读页面选中文字 |
| 从光标处朗读 | 从光标位置读到文末 |
| 朗读整篇笔记 | 朗读当前笔记全文 |
| 暂停或继续朗读 | 切换播放状态 |
| 停止朗读 | 停止并清除高亮 |
| 打开朗读播放器 | 打开右侧播放器面板 |
| 导出当前笔记为音频 | 合成整篇并保存到附件目录 |
| 试听当前语音 | 用当前参数朗读一句示例 |

左侧 ribbon 的喇叭图标可直接朗读当前笔记；状态栏显示当前段进度，点击可暂停 / 继续。

## 各引擎配置

### 微软 Edge 免费语音（默认）

1. 设置 → 微软语音朗读 → 引擎选「微软 Edge 免费语音」。
2. 点「刷新语音列表」，选择语音；新闻推荐「云扬」，对话 / 教学推荐「晓晓」「云希」。
3. 点「试听」，再点「测试连接」确认可用。

无需密钥。若刷新列表失败（网络或微软接口变动），插件会使用内置推荐语音列表。

### 豆包 / 火山引擎

1. 打开 [火山引擎语音控制台](https://console.volcengine.com/speech/)，完成实名认证，开通「语音合成」。
2. 创建应用，记录 **APP ID** 与 **Access Token**。
3. 插件设置中引擎选「豆包 / 火山引擎」，填入 AppID、Access Token，Cluster 保持 `volcano_tts`。
4. 选择音色并点「测试连接」。

注意：V1 接口单次文本约 1024 字节，插件会自动按 900 字节切段；V1 不支持音调，也不支持 2.0 音色（`uranus` 系列）。部分音色需要在控制台 0 元下单后才能使用。

### OpenAI 兼容 / 硅基流动

1. 在 [硅基流动 API Key 页面](https://cloud.siliconflow.cn/account/ak) 创建 Key。
2. 插件设置中引擎选「OpenAI 兼容 / 硅基流动」。
3. Base URL 保持 `https://api.siliconflow.cn/v1`，模型 `FunAudioLLM/CosyVoice2-0.5B`，填入 API Key。
4. 选择音色并点「测试连接」。

也可以填写任意 OpenAI 兼容 TTS 服务，Base URL 需包含 `/v1`，voice 按服务文档填写。

### Windows 系统语音

引擎选「Windows 系统语音」，或在其他引擎失败时自动兜底。若没有中文语音，请在 Windows「设置 → 时间和语言 → 语言和区域」安装中文语音包。

## 隐私与安全

- **Edge**：朗读文本发送到微软 Edge 朗读接口；无需密钥。
- **豆包**：朗读文本发送到火山引擎；需要 AppID / Access Token。
- **OpenAI 兼容**：朗读文本发送到你填写的 API 地址；需要 API Key。
- 密钥默认保存在 Obsidian 用户目录的 `localStorage`，**不写入笔记库**，不会随 OneDrive / remotely-save 同步；也可选择「仅本次会话」。
- 插件不含遥测；不向第三方发送除朗读文本之外的数据。
- 请不要把密钥粘贴进笔记或提交到 Git 仓库。

## 已知限制

- 仅支持 Obsidian 桌面版（Edge 语音通过 Node WebSocket 连接）。
- Edge 语音为非官方接口，2025-12、2026-10 均发生过协议变更；失效时请更新插件或切换其他引擎。
- Edge 不支持「说话风格」，只能通过换音色实现新闻 / 教学 / 活泼等语气。
- Edge 与豆包 V1 的逐句高亮依赖字符权重 + 音频时长估算；需要精确高亮可开启「逐句合成」（请求数增加）。
- 豆包 V1 不支持音调，单次请求文本 ≤1024 字节，2.0 音色需走 V3（本插件暂不支持）。
- 部分 OpenAI 兼容接口会忽略音调 / 音量参数。
- 阅读模式无法在正文内高亮（没有 CodeMirror 编辑器），只在播放器面板显示当前句；正文内高亮请使用编辑 / 实时预览模式。
- 导出 MP3 依赖各段 MP3 帧拼接；若接口返回 WAV，会自动改为 WAV 导出。

## 开发

```bash
npm install
npm run dev     # esbuild watch
npm run check   # TypeScript 类型检查
npm run build   # 类型检查 + 生产构建
```

主要模块：

- `src/providers/edge.ts`：Edge WebSocket、Sec-MS-GEC v2、语音列表
- `src/providers/doubao.ts`：火山引擎 V1 HTTP（base64）
- `src/providers/openai.ts`：OpenAI 兼容 `/audio/speech`
- `src/tts-service.ts`：引擎选择、限流、缓存键、语音描述
- `src/player.ts`：播放状态机、预取、逐句计时
- `src/text-extract.ts`：Markdown 清洗与分块
- `src/highlighter.ts`：CodeMirror 高亮
- `src/exporter.ts`：整篇导出与 MP3/WAV 拼接

`scripts/edge-tts-test.mjs` 可在 Node 下单独验证 Edge 鉴权与合成（需要 `ws` 依赖）。

## 贡献

欢迎提交 Issue 和 Pull Request。提交前请运行：

```bash
npm run check
npm run build
```

请勿在 Issue、日志或代码中粘贴 API Key / Access Token。

## 许可证

[MIT](LICENSE) © 2026 cangxinren
