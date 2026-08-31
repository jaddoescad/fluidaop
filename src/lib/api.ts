export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type JsonValidator<T> = (value: unknown) => value is T;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(payload: unknown, status: number): string {
  return isRecord(payload) && typeof payload.error === 'string'
    ? payload.error
    : `the server answered HTTP ${status}`;
}

/**
 * The single JSON boundary for browser API calls. It normalizes headers and
 * server errors, supports cancellation, and optionally validates payloads
 * before they enter application state.
 */
export async function apiJson<T>(
  path: string,
  init?: RequestInit,
  validate?: JsonValidator<T>,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(errorMessage(payload, response.status), response.status, payload);
  if (validate && !validate(payload)) {
    throw new ApiError('the server returned an invalid JSON response', response.status, payload);
  }
  return payload as T;
}
