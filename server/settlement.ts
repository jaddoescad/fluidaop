export const LOCAL_SIGNAL_REVIEWER = 'manager' as const;
export const NO_ACTION_RESOLUTION = 'no_action' as const;

const postgresBigintMaximum = 9_223_372_036_854_775_807n;

export function isPositiveSignalId(value: string): boolean {
  if (!/^[1-9][0-9]*$/.test(value)) return false;
  try {
    return BigInt(value) <= postgresBigintMaximum;
  } catch {
    return false;
  }
}

export function signalSettlementPayload(signalId: string): {
  activityId: string;
  resolution: typeof NO_ACTION_RESOLUTION;
  reviewer: typeof LOCAL_SIGNAL_REVIEWER;
} {
  if (!isPositiveSignalId(signalId)) throw new Error('Invalid Signal id');
  return {
    activityId: signalId,
    resolution: NO_ACTION_RESOLUTION,
    reviewer: LOCAL_SIGNAL_REVIEWER,
  };
}
