import type { MsTtsSettings } from './types';

export const DEFAULT_SETTINGS: MsTtsSettings = {
  provider: 'edge',

  edgeVoice: 'zh-CN-XiaoxiaoNeural',

  doubaoAppId: '',
  doubaoCluster: 'volcano_tts',
  doubaoVoice: 'BV011_streaming',

  openaiBaseUrl: 'https://api.siliconflow.cn/v1',
  openaiModel: 'FunAudioLLM/CosyVoice2-0.5B',
  openaiVoice: 'FunAudioLLM/CosyVoice2-0.5B:claire',

  rate: 1,
  pitch: 0,
  volume: 100,

  chunkChars: 300,
  perSentence: false,
  prefetch: true,
  highlight: true,
  autoScroll: true,
  autoFallbackSystem: true,

  systemVoiceURI: '',
  systemRate: 1,
  systemPitch: 0,

  cacheEnabled: true,
  cacheMaxMB: 200,

  keyStorage: 'local',
  openPanelOnPlay: true,
  showStatusBar: true,

  playbackMode: 'sequential',
  playlists: [],
  activePlaylistId: '',
  autoFolderPlaylist: false,
  playlistIncludeSubfolders: false,
};
