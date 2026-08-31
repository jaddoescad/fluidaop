export interface PublicHttpError {
  status: 400 | 413;
  message: string;
}

export function bodyParserHttpError(error: unknown): PublicHttpError | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const status = (error as { status?: unknown }).status;
  if (status === 413) return { status, message: 'Request body is too large' };
  if (status === 400) return { status, message: 'Request body contains invalid JSON' };
  return null;
}
