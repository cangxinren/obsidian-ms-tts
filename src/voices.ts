import type { VoiceOption } from './types';

/** Edge Read Aloud 常用中文音色的中文名 */
export const EDGE_NAMES: Record<string, string> = {
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunxiaNeural': '云夏',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-liaoning-XiaobeiNeural': '晓北（东北）',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮（陕西）',
  'zh-HK-HiuGaaiNeural': '曉佳（粤语）',
  'zh-HK-HiuMaanNeural': '曉曼（粤语）',
  'zh-HK-WanLungNeural': '雲龍（粤语）',
  'zh-TW-HsiaoChenNeural': '曉臻（台湾）',
  'zh-TW-HsiaoYuNeural': '曉雨（台湾）',
  'zh-TW-YunJheNeural': '雲哲（台湾）',
};

/** 语音列表拉取失败时的内置候选 */
export const EDGE_FALLBACK_VOICES: VoiceOption[] = [
  edgeVoice('zh-CN-XiaoxiaoNeural', '晓晓', 'zh-CN', 'Female', ['新闻播报', '对话/教学', '有声书'], ['Warm'], '温暖自然，最稳定'),
  edgeVoice('zh-CN-YunyangNeural', '云扬', 'zh-CN', 'Male', ['新闻播报'], ['Professional', 'Reliable'], '专业新闻播报男声'),
  edgeVoice('zh-CN-YunjianNeural', '云健', 'zh-CN', 'Male', ['新闻播报', '体育解说'], ['Passion'], '激情解说、纪录片'),
  edgeVoice('zh-CN-YunxiNeural', '云希', 'zh-CN', 'Male', ['对话/教学', '有声书'], ['Lively', 'Sunshine'], '年轻有活力'),
  edgeVoice('zh-CN-XiaoyiNeural', '晓伊', 'zh-CN', 'Female', ['对话/教学', '有声书'], ['Lively'], '活泼'),
  edgeVoice('zh-CN-YunxiaNeural', '云夏', 'zh-CN', 'Male', ['对话/童声'], ['Cute'], '少年音'),
  edgeVoice('zh-CN-liaoning-XiaobeiNeural', '晓北（东北）', 'zh-CN', 'Female', ['方言'], ['Humorous'], '东北方言'),
  edgeVoice('zh-CN-shaanxi-XiaoniNeural', '晓妮（陕西）', 'zh-CN', 'Female', ['方言'], ['Bright'], '陕西方言'),
  edgeVoice('zh-HK-HiuGaaiNeural', '曉佳（粤语）', 'zh-HK', 'Female', ['方言'], [], '粤语'),
  edgeVoice('zh-TW-HsiaoChenNeural', '曉臻（台湾）', 'zh-TW', 'Female', ['通用'], [], '台湾国语'),
  edgeVoice('en-US-AriaNeural', 'Aria', 'en-US', 'Female', ['英文'], [], '英文女声'),
  edgeVoice('en-US-GuyNeural', 'Guy', 'en-US', 'Male', ['英文'], [], '英文男声'),
  edgeVoice('en-US-JennyNeural', 'Jenny', 'en-US', 'Female', ['英文'], [], '英文女声'),
  edgeVoice('en-US-EmmaMultilingualNeural', 'Emma', 'en-US', 'Female', ['英文', '多语种'], [], '多语种女声'),
];

/** 豆包 / 火山引擎 V1 常用音色 */
export const DOUBAO_VOICES: VoiceOption[] = [
  doubaoVoice('BV011_streaming', '新闻女声', ['新闻播报'], '官方新闻播报，女声'),
  doubaoVoice('BV012_streaming', '新闻男声', ['新闻播报'], '官方新闻播报，男声'),
  doubaoVoice('BV034_streaming', '知性姐姐', ['对话/教学'], '教育场景，知性女声'),
  doubaoVoice('BV033_streaming', '温柔小哥', ['对话/教学'], '教育场景，温柔男声'),
  doubaoVoice('BV705_streaming', '炀炀', ['对话/教学'], '自然对话、讲故事'),
  doubaoVoice('BV001_streaming', '通用女声', ['通用'], '免费音色，无需 0 元下单'),
  doubaoVoice('BV002_streaming', '通用男声', ['通用'], '免费音色，无需 0 元下单'),
  doubaoVoice('BV700_streaming', '灿灿', ['通用'], '22 种情感/风格，可讲故事'),
  doubaoVoice('BV142_streaming', '沉稳解说男', ['有声书'], '低沉，适合长文朗读'),
  doubaoVoice('BV123_streaming', '阳光青年', ['有声书'], '有声阅读'),
  doubaoVoice('BV102_streaming', '儒雅青年', ['有声书'], '有声阅读'),
  doubaoVoice('BV411_streaming', '小帅', ['通用'], '抖音影视解说腔'),
  doubaoVoice('BV412_streaming', '小美', ['通用'], '抖音影视解说腔'),
];

/** 硅基流动 CosyVoice2 的 8 个预置音色 */
export const COSYVOICE_VOICE_NAMES: Array<[string, string]> = [
  ['alex', '沉稳男声'],
  ['benjamin', '低沉男声'],
  ['charles', '磁性男声'],
  ['david', '欢快男声'],
  ['anna', '沉稳女声'],
  ['bella', '激情女声'],
  ['claire', '温柔女声'],
  ['diana', '欢快女声'],
];

export function openAiVoiceOptions(model: string): VoiceOption[] {
  const voiceModel = model || 'FunAudioLLM/CosyVoice2-0.5B';
  return COSYVOICE_VOICE_NAMES.map(([key, name]) => ({
    id: `${voiceModel}:${key}`,
    name,
    locale: 'zh-CN',
    categories: ['对话/教学', '通用'],
    description: `CosyVoice2 预置音色`,
    provider: 'openai',
  }));
}

export function normalizeEdgeVoices(raw: unknown[]): VoiceOption[] {
  const options: VoiceOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as {
      ShortName?: string;
      FriendlyName?: string;
      Gender?: string;
      Locale?: string;
      VoiceTag?: { ContentCategories?: string[]; VoicePersonalities?: string[] };
    };
    const shortName = value.ShortName;
    if (!shortName) continue;

    const categories = edgeCategories(value.Locale ?? '', value.VoiceTag);
    options.push({
      id: shortName,
      name: EDGE_NAMES[shortName] ?? deriveEnglishName(value.FriendlyName, shortName),
      locale: value.Locale ?? 'unknown',
      gender: value.Gender,
      categories,
      personalities: (value.VoiceTag?.VoicePersonalities ?? []).map((tag) => tag.trim()),
      description: (value.VoiceTag?.VoicePersonalities ?? []).map((tag) => tag.trim()).join(' / '),
      provider: 'edge',
    });
  }

  return options.sort(compareVoices);
}

function edgeCategories(
  locale: string,
  tag?: { ContentCategories?: string[]; VoicePersonalities?: string[] },
): string[] {
  const raw = (tag?.ContentCategories ?? []).map((item) => item.trim());
  const personalities = (tag?.VoicePersonalities ?? []).map((item) => item.trim());
  const categories = new Set<string>();

  if (raw.includes('News')) categories.add('新闻播报');
  if (raw.includes('Novel')) categories.add('有声书');
  if (raw.includes('Cartoon')) categories.add('对话/童声');
  if (raw.includes('Sports')) categories.add('体育解说');
  if (raw.includes('Dialect')) categories.add('方言');

  if (personalities.includes('Lively') || personalities.includes('Sunshine') || personalities.includes('Cute')) {
    categories.add('对话/教学');
  }
  if (personalities.includes('Warm')) categories.add('对话/教学');
  if (personalities.includes('Professional') || personalities.includes('Reliable')) categories.add('新闻播报');

  if (!categories.size) {
    if (locale.startsWith('zh')) categories.add('通用');
    else if (locale.startsWith('en')) categories.add('英文');
    else categories.add('其他语言');
  }
  return Array.from(categories);
}

function deriveEnglishName(friendlyName: string | undefined, shortName: string): string {
  if (friendlyName) {
    const match = friendlyName.match(/^Microsoft\s+(.+?)\s+Online/i);
    if (match) return match[1];
  }
  const parts = shortName.split('-');
  const last = parts[parts.length - 1] ?? shortName;
  return last.replace(/Neural$/, '').replace(/Multilingual$/, ' Multilingual');
}

function compareVoices(a: VoiceOption, b: VoiceOption): number {
  const localeScore = (voice: VoiceOption) => (voice.locale === 'zh-CN' ? 0 : voice.locale.startsWith('zh') ? 1 : 2);
  if (localeScore(a) !== localeScore(b)) return localeScore(a) - localeScore(b);

  const categoryScore = (voice: VoiceOption) => {
    if (voice.categories.includes('新闻播报')) return 0;
    if (voice.categories.includes('对话/教学')) return 1;
    if (voice.categories.includes('有声书')) return 2;
    if (voice.categories.includes('方言')) return 3;
    if (voice.categories.includes('英文')) return 5;
    return 4;
  };
  const diff = categoryScore(a) - categoryScore(b);
  if (diff !== 0) return diff;
  return a.name.localeCompare(b.name, 'zh-CN');
}

function edgeVoice(
  id: string,
  name: string,
  locale: string,
  gender: string,
  categories: string[],
  personalities: string[],
  description: string,
): VoiceOption {
  return { id, name, locale, gender, categories, personalities, description, provider: 'edge' };
}

function doubaoVoice(id: string, name: string, categories: string[], description: string): VoiceOption {
  return {
    id,
    name,
    locale: 'zh-CN',
    gender: name.includes('男') ? 'Male' : name.includes('女') ? 'Female' : undefined,
    categories,
    description,
    provider: 'doubao',
  };
}

export function voiceLabel(voice: VoiceOption): string {
  const tag = voice.categories[0] ? `[${voice.categories[0]}] ` : '';
  const locale = voice.locale === 'zh-CN' ? '' : ` · ${voice.locale}`;
  return `${tag}${voice.name}${locale} · ${voice.id}`;
}
