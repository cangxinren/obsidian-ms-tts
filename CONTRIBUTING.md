# Contributing

感谢参与改进「微软语音朗读」。

## 开发环境

- Node.js 20+
- Obsidian 桌面版 1.5.0+
- Windows / macOS / Linux 均可构建，Edge 语音需要在 Obsidian 桌面端运行

```bash
npm install
npm run dev
npm run check
npm run build
```

## 提交 Issue

请尽量提供：

- Obsidian 版本、插件版本、操作系统
- 使用的引擎（Edge / 豆包 / OpenAI 兼容 / 系统语音）
- 复现步骤与预期结果
- 相关报错文本（**不要粘贴 API Key、Access Token 或笔记隐私内容**）

## 提交 Pull Request

1. Fork 仓库并从 `main` 创建分支。
2. 保持改动聚焦，说明动机与影响。
3. 提交前运行 `npm run check` 和 `npm run build`。
4. 不要提交 `main.js`、`node_modules/` 或任何密钥。

## 代码结构

- `src/providers/`：各语音引擎适配
- `src/tts-service.ts`：引擎选择、限流、缓存键
- `src/player.ts`：播放状态机与逐句计时
- `src/text-extract.ts`：Markdown 清洗与分块
- `src/settings-tab.ts`：设置界面
- `src/exporter.ts`：音频导出与拼接

## 许可

提交的代码默认按 MIT 许可证授权。
