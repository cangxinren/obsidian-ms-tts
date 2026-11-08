export type TtsErrorKind =
  | 'config'
  | 'auth'
  | 'forbidden'
  | 'rate-limit'
  | 'bad-request'
  | 'server'
  | 'network'
  | 'playback'
  | 'canceled'
  | 'unknown';

export class TtsError extends Error {
  readonly kind: TtsErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(kind: TtsErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'TtsError';
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export function errorFromStatus(status: number, body: string): TtsError {
  const detail = (body || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  switch (status) {
    case 400:
      return new TtsError('bad-request', `请求参数不被支持${detail ? `：${detail}` : ''}`, { status });
    case 401:
      return new TtsError('auth', '语音服务鉴权失败，请检查密钥或接口设置', { status });
    case 403:
      return new TtsError('forbidden', '密钥无权限，或免费额度已用尽', { status });
    case 415:
      return new TtsError('bad-request', '语音接口不接受当前请求类型（Content-Type）', { status });
    case 429:
      return new TtsError('rate-limit', '请求过于频繁，请稍后重试', { status });
    default:
      if (status >= 500) {
        return new TtsError('server', `语音服务暂时不可用（${status}）`, { status });
      }
      return new TtsError('unknown', `语音接口返回错误（${status}）${detail ? `：${detail}` : ''}`, { status });
  }
}

export function describeError(err: unknown): string {
  if (err instanceof TtsError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
