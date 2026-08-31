export interface ResilientFetchOptions {
  timeoutMs?: number;
  safeRetries?: number;
  request?: typeof fetch;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_SAFE_RETRIES = 1;

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfterSeconds = Number.parseInt(response?.headers.get('retry-after') ?? '', 10);
  if (Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 5_000);
  }
  return Math.min(250 * (2 ** attempt), 2_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchWithTimeoutAndRetry(
  input: string | URL | Request,
  init: RequestInit = {},
  options: ResilientFetchOptions = {},
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const retrySafe = method === 'GET' || method === 'HEAD';
  const attempts = 1 + (retrySafe ? Math.max(0, options.safeRetries ?? DEFAULT_SAFE_RETRIES) : 0);
  const request = options.request ?? fetch;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await request(input, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS),
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts - 1) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await delay(retryDelayMs(response, attempt));
  }

  throw lastError ?? new Error('HTTP request failed');
}
