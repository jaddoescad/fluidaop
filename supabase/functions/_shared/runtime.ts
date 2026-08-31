import { createClient } from 'npm:@supabase/supabase-js@2.95.0';

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const encoder = new TextEncoder();

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

export function databaseSecret(): string {
  const current = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (current) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(current) as Record<string, unknown>;
    } catch {
      throw new Error('SUPABASE_SECRET_KEYS is not valid JSON');
    }
    const preferred = parsed.default;
    if (typeof preferred === 'string' && preferred) return preferred;
    const fallback = Object.values(parsed).find((value) => typeof value === 'string' && value);
    if (typeof fallback === 'string') return fallback;
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!legacy) throw new Error('Supabase database secret is unavailable');
  return legacy;
}

export function createAdminClient() {
  const url = Deno.env.get('SUPABASE_URL');
  if (!url) throw new Error('Supabase URL is unavailable');
  return createClient(url, databaseSecret(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function safeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let different = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return different === 0;
}

export function validSecret(
  supplied: string,
  candidates: Array<string | undefined>,
  minimumLength = 43,
): boolean {
  if (supplied.length < minimumLength) return false;
  return candidates.some((candidate) => {
    const expected = candidate?.trim() ?? '';
    return expected.length >= minimumLength && safeEqual(expected, supplied);
  });
}
