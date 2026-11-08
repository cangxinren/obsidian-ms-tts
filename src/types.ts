export type ProviderId = 'edge' | 'doubao' | 'openai' | 'system';
export type KeyStorage = 'local' | 'session';
export type SecretName = 'doubao' | 'openai';

export type PlaybackMode = 'sequential' | 'repeat-one' | 'repeat-all' | 'shuffle';
export type QueueSource = 'playlist' | 'folder' | 'single' | 'partial';

export interface PlaylistItem {
  path: string;
  title: string;
}

export interface Playlist {
  id: string;
  name: string;
  items: PlaylistItem[];
  createdAt: number;
  updatedAt: number;
}

export interface MsTtsSettings {
  provider: ProviderId;

  // 微软 Edge 免费语音（免密钥）
  edgeVoice: string;

  // 豆包 / 火山引擎
  doubaoAppId: string;
  doubaoCluster: string;
  doubaoVoice: string;

  // OpenAI 兼容（硅基流动等）
  openaiBaseUrl: string;
  openaiModel: string;
  openaiVoice: string;

  // 通用语调
  rate: number;
  pitch: number;
  volume: number;

  chunkChars: number;
  perSentence: boolean;
  prefetch: boolean;
  highlight: boolean;
  autoScroll: boolean;
  autoFallbackSystem: boolean;

  // Windows 系统语音
  systemVoiceURI: string;
  systemRate: number;
  systemPitch: number;

  cacheEnabled: boolean;
  cacheMaxMB: number;

  keyStorage: KeyStorage;
  openPanelOnPlay: boolean;
  showStatusBar: boolean;

  // 播放模式与播放列表
  playbackMode: PlaybackMode;
  playlists: Playlist[];
  activePlaylistId: string;
  autoFolderPlaylist: boolean;
  playlistIncludeSubfolders: boolean;

  // 合并导出
  exportIncludeLyrics: boolean;
  exportEmbedLyrics: boolean;
  exportAnnounceTitles: boolean;
  /** 空字符串 = 附件目录；'/' = 库根目录；其他 = 指定目录 */
  exportFolder: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  locale: string;
  gender?: string;
  categories: string[];
  personalities?: string[];
  description?: string;
  provider: ProviderId;
}

export interface Sentence {
  text: string;
  /** 源文档中的起始偏移（已含 baseOffset） */
  srcStart: number;
  /** 源文档中的结束偏移（已含 baseOffset） */
  srcEnd: number;
  /** 估算朗读时长用的字符权重 */
  weight: number;
}

export interface Chunk {
  text: string;
  sentences: Sentence[];
  srcStart: number;
  srcEnd: number;
}

export interface ReadableDoc {
  title: string;
  chunks: Chunk[];
  totalChars: number;
}

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

export interface PlayerSnapshot {
  state: PlayerState;
  title: string;
  chunkIndex: number;
  chunkCount: number;
  sentenceIndex: number;
  sentenceText: string;
  progress: number;
  cacheHits: number;
  requests: number;
  provider: ProviderId;
  error?: string;
}

export interface PlaylistSnapshot {
  mode: PlaybackMode;
  listId: string;
  listName: string;
  source: QueueSource;
  index: number;
  count: number;
  currentPath: string | null;
  currentTitle: string;
  isAdvancing: boolean;
}
