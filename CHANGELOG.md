# Changelog

## 0.2.0 - 2026-11-08

### Added

- 新增微软 Edge 免费语音引擎（免密钥，支持 300+ 语音，含新闻 / 对话教学 / 方言）。
- 新增豆包 / 火山引擎 V1 引擎（AppID + Access Token，新闻 / 教育专用音色）。
- 新增 OpenAI 兼容引擎，默认接入硅基流动 CosyVoice2。
- 语音列表按场景分类，支持搜索、语言过滤、试听与手动填写 voice。
- 导出自动识别 MP3 / WAV。
- 自动清理 0.1.x 的 Azure 配置与密钥残留。

### Changed

- 移除 Azure Speech 引擎与相关设置。
- 重构 Provider / TtsService 抽象，按引擎限流、缓存与错误降级。
- 插件改为桌面专用（Edge 语音依赖 Node WebSocket）。

### Fixed

- 修复 Edge 二进制帧音频起点偏移 2 字节导致音频损坏的问题。
- 修复播放器面板成为活动视图后逐句高亮失效的问题。
- 修复面板激活时无法回退到最近 Markdown 视图的问题。

## 0.1.0 - 2026-11-08

### Added

- 初始版本：Azure Speech Service 朗读、语音 / 风格 / 语速 / 音调、逐句高亮、缓存、播放器面板、MP3 导出、Windows 系统语音兜底。
