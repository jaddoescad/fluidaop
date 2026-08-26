import { type HermesAgentDefinition } from '../agents/hermes';

interface FluidSchedulesPayload {
  schedules: HermesAgentDefinition[];
  fetchedAt: string;
}

export async function loadFluidSchedules(): Promise<HermesAgentDefinition[]> {
  const response = await fetch('/api/fluid/schedules', { headers: { Accept: 'application/json' } });
  const payload = (await response.json().catch(() => null)) as FluidSchedulesPayload | { error?: unknown } | null;
  if (!response.ok) {
    const detail = payload !== null && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Fluid schedules returned HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (payload === null || !('schedules' in payload) || !Array.isArray(payload.schedules)) {
    throw new Error('Fluid returned an invalid schedule roster');
  }
  return payload.schedules;
}
