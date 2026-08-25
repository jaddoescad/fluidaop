import { createClient } from 'npm:@supabase/supabase-js@2.95.0';

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const allowedRoles = new Set(['customer', 'employee', 'painter', 'applicant', 'contractor', 'supplier']);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function databaseSecret(): string {
  const current = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (current) {
    const parsed = JSON.parse(current) as Record<string, unknown>;
    const preferred = parsed.default;
    if (typeof preferred === 'string' && preferred) return preferred;
    const fallback = Object.values(parsed).find((value) => typeof value === 'string' && value);
    if (typeof fallback === 'string') return fallback;
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!legacy) throw new Error('Supabase database secret is unavailable');
  return legacy;
}

function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return different === 0;
}

function validSecret(supplied: string, candidates: Array<string | undefined>): boolean {
  if (supplied.length < 43) return false;
  return candidates.some((candidate) => {
    const expected = candidate?.trim() ?? '';
    return expected.length >= 43 && safeEqual(expected, supplied);
  });
}

function authorizedAgent(req: Request): boolean {
  return validSecret(req.headers.get('x-fluid-agent-secret')?.trim() ?? '', [
    Deno.env.get('FLUID_CUSTOMER_SYNC_SECRET'),
    Deno.env.get('FLUID_EMAIL_CATEGORIZER_SECRET'),
  ]);
}

function authorizedRead(req: Request): boolean {
  return authorizedAgent(req) || validSecret(req.headers.get('x-fluid-activity-secret')?.trim() ?? '', [
    Deno.env.get('FLUID_ACTIVITY_SYNC_SECRET'),
  ]);
}

function boundedInteger(raw: string | null, fallback: number, minimum: number, maximum: number): number {
  if (raw === null || !/^\d+$/.test(raw)) return fallback;
  return Math.max(minimum, Math.min(maximum, Number.parseInt(raw, 10)));
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') ?? 'status';

  if (!authorizedRead(req)) return response({ error: 'Unauthorized' }, 401);
  if (action === 'run' && !authorizedAgent(req)) return response({ error: 'Agent authorization required' }, 403);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!supabaseUrl) throw new Error('Supabase URL is unavailable');
    const supabase = createClient(supabaseUrl, databaseSecret(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (req.method === 'GET' && action === 'status') {
      const { data, error } = await supabase.rpc('read_customer_sync_status');
      if (error) throw error;
      return response(data);
    }

    if (req.method === 'GET' && action === 'people') {
      const role = (url.searchParams.get('role') ?? 'customer').trim().toLowerCase();
      if (!allowedRoles.has(role)) return response({ error: 'Invalid people role' }, 400);
      const limit = boundedInteger(url.searchParams.get('limit'), 30, 1, 100);
      const offset = boundedInteger(url.searchParams.get('offset'), 0, 0, 100_000);

      const { data, error, count } = await supabase
        .from('people_directory')
        .select(
          'id,display_name,primary_email,primary_phone,status,roles,source_system,source_record_id,last_synced_at,linked_signal_count,last_signal_at,created_at,updated_at',
          { count: 'exact' },
        )
        .eq('status', 'active')
        .contains('roles', [role])
        .order('display_name', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;

      const rows = (data ?? []).map((person) => ({
        id: person.id,
        displayName: person.display_name,
        primaryEmail: person.primary_email,
        primaryPhone: person.primary_phone,
        status: person.status,
        roles: person.roles,
        sourceSystem: person.source_system,
        sourceRecordId: person.source_record_id,
        lastSyncedAt: person.last_synced_at,
        linkedSignalCount: person.linked_signal_count,
        lastSignalAt: person.last_signal_at,
        createdAt: person.created_at,
        updatedAt: person.updated_at,
      }));
      const total = count ?? rows.length;
      const nextOffset = offset + rows.length < total ? offset + rows.length : null;
      return response({ people: rows, count: total, limit, offset, nextOffset, role });
    }

    if (req.method === 'POST' && action === 'run') {
      const { data, error } = await supabase.rpc('sync_ottawa_painters_customers');
      if (error) throw error;
      if (data?.status === 'failed') return response(data, 500);
      return response(data);
    }

    return response({ error: 'Not found' }, 404);
  } catch (error) {
    console.error('fluid-customer-sync request failed');
    return response({ error: error instanceof Error ? error.message : 'Unexpected customer sync error' }, 500);
  }
});
