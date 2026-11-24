import { errorMessage, sleep } from '../common/fp.js';

/** User agent sent to public sources (identifies the software, no personal data). */
export const USER_AGENT = 'regulatory-radar/0.1 (+self-hosted; respects published rate limits)';

/** Error carrying the HTTP status of a failed request. */
export class HttpError extends Error {
  /** Creates the error. */
  constructor(
    /** HTTP status (0 = network error or timeout). */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Options of a polite HTTP GET. */
export interface GetOptions {
  /** Per-attempt timeout. */
  readonly timeoutMs: number;
  /** Extra headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Attempts on timeouts and 5xx/429 (default 3). */
  readonly attempts?: number;
  /** Caller cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * GET with timeout, bounded retries with exponential backoff (on timeouts, 429 and 5xx only) and a
 * descriptive user agent. Never works around bot filters: 4xx other than 429 fail immediately.
 */
export const politeGet = async (url: string, opts: GetOptions): Promise<Response> => {
  const attempts = opts.attempts ?? 3;
  const attempt = async (n: number): Promise<Response> => {
    const signals = [AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])];
    const result = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...opts.headers },
      signal: AbortSignal.any(signals),
    }).then(
      (res) => res,
      (e: unknown) => new HttpError(0, `${url}: ${errorMessage(e)}`),
    );
    const retryable = result instanceof HttpError || result.status === 429 || result.status >= 500;
    if (!retryable) return result as Response;
    if (n + 1 >= attempts || opts.signal?.aborted)
      throw result instanceof HttpError
        ? result
        : new HttpError(result.status, `${url}: HTTP ${result.status}`);
    // Free the connection of the failed response and honour the server's Retry-After (seconds, capped at 60 s).
    if (!(result instanceof HttpError)) await result.body?.cancel().catch(() => undefined);
    const retryAfter = result instanceof HttpError ? Number.NaN : Number(result.headers.get('retry-after'));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** n;
    await sleep(waitMs, opts.signal);
    return attempt(n + 1);
  };
  return attempt(0);
};
