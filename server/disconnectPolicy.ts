export interface DisconnectStateUpdate {
  disconnectPending: true;
  status: 'error';
  error: string;
  updatedAt: string;
}

export function pendingDisconnectUpdate(now: string): DisconnectStateUpdate {
  return {
    disconnectPending: true,
    status: 'error',
    error: 'Disconnecting from the provider.',
    updatedAt: now,
  };
}

export function failedDisconnectUpdate(detail: string, now: string): DisconnectStateUpdate {
  return {
    disconnectPending: true,
    status: 'error',
    error: `Disconnect pending: ${detail}`.slice(0, 500),
    updatedAt: now,
  };
}

export function canForceRemoveConnection(disconnectPending: boolean | undefined): boolean {
  return disconnectPending === true;
}

export function googleRevocationIsComplete(status: number): boolean {
  return (status >= 200 && status < 300) || status === 400 || status === 401;
}
