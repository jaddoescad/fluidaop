import { ReactNode, useCallback, useEffect, useState } from 'react';
import { SideNav } from '../components/AppChrome';
import '../variants/flow.css';
import '../variants/zen.css';
import './actions.css';

interface ActionDefinition {
  id: string;
  key: string;
  name: string;
  description: string;
  handler: string;
  enabled: boolean;
  executionMode: 'simulation';
  requiresConfirmation: boolean;
  configuration: Record<string, unknown>;
  version: number;
  builtIn: boolean;
  executable: boolean;
  updatedAt: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const payload = await response.json().catch(() => null) as T | { error?: string } | null;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Actions request returned ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export function ActionsPage({ onNavigate, header }: { onNavigate: (label: string) => void; header: ReactNode }) {
  const [definitions, setDefinitions] = useState<ActionDefinition[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftTone, setDraftTone] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await api<{ definitions: ActionDefinition[] }>('/api/action-definitions');
      const order = ['draft-email-to-customer', 'draft-sms-reply', 'create-follow-up-reminder', 'create-internal-task'];
      setDefinitions(payload.definitions.slice().sort((left, right) => order.indexOf(left.key) - order.indexOf(right.key)));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load Actions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const patchDefinition = async (definition: ActionDefinition, patch: Record<string, unknown>) => {
    if (busyId) return;
    setBusyId(definition.id);
    setError(null);
    try {
      const payload = await api<{ definition: ActionDefinition }>(`/api/action-definitions/${definition.id}`, {
        method: 'PATCH', body: JSON.stringify({ version: definition.version, ...patch }),
      });
      setDefinitions((current) => current.map((item) => item.id === definition.id ? payload.definition : item));
      setEditingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update Action');
    } finally {
      setBusyId(null);
    }
  };

  const beginEdit = (definition: ActionDefinition) => {
    setEditingId(definition.id);
    setDraftName(definition.name);
    setDraftDescription(definition.description);
    setDraftTone(typeof definition.configuration.tone === 'string' ? definition.configuration.tone : '');
  };

  return (
    <div className="v v-flow v-zen al-root">
      <div className="fl-shell">
        <SideNav active="Actions" onNav={onNavigate} />
        <div className="fl-frame">
          {header}
          <main className="al-main">
            <div className="al-inner">
              <header className="al-head">
                <h1>Actions</h1>
                <p>Reusable capabilities Hermes may recommend. The Board shows accepted instances, not this library.</p>
              </header>
              <div className="al-trust">
                <span>Simulation only</span>
                No capability on this page can send Gmail, SMS, or change a provider record.
              </div>
              {error && <p className="al-error" role="alert">{error}</p>}
              {loading ? <p className="al-state">Loading Actions…</p> : (
                <section className="al-list" aria-label="Built-in Actions">
                  {definitions.map((definition) => {
                    const editing = editingId === definition.id;
                    return (
                      <article key={definition.id} className={`al-row${definition.enabled ? ' is-enabled' : ''}`}>
                        <div className="al-icon" aria-hidden="true">
                          {definition.handler === 'draft-email-reply' ? '✉' : definition.handler === 'draft-sms-reply' ? '◌' : definition.handler === 'create-reminder' ? '◷' : '✓'}
                        </div>
                        <div className="al-copy">
                          {editing ? (
                            <div className="al-edit">
                              <label>Name<input value={draftName} maxLength={100} onChange={(event) => setDraftName(event.target.value)} /></label>
                              <label>Description<textarea value={draftDescription} maxLength={1000} onChange={(event) => setDraftDescription(event.target.value)} /></label>
                              {definition.handler === 'draft-email-reply' && (
                                <label>Drafting tone<input value={draftTone} maxLength={200} onChange={(event) => setDraftTone(event.target.value)} /></label>
                              )}
                              <div className="al-edit-actions">
                                <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                                <button type="button" className="is-primary" disabled={busyId === definition.id || !draftName.trim() || !draftDescription.trim()} onClick={() => void patchDefinition(definition, {
                                  name: draftName, description: draftDescription,
                                  configuration: { ...definition.configuration, ...(definition.handler === 'draft-email-reply' ? { tone: draftTone.trim() } : {}) },
                                })}>{busyId === definition.id ? 'Saving…' : 'Save'}</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="al-title-line">
                                <h2>{definition.name}</h2>
                                <span>{definition.enabled ? 'Enabled' : definition.executable ? 'Disabled' : 'Coming next'}</span>
                              </div>
                              <p>{definition.description}</p>
                              <small>{definition.executionMode} · confirmation required · v{definition.version}</small>
                            </>
                          )}
                        </div>
                        {!editing && (
                          <div className="al-controls">
                            <button type="button" className="al-config" onClick={() => beginEdit(definition)}>Configure</button>
                            <button
                              type="button"
                              className="al-toggle"
                              role="switch"
                              aria-checked={definition.enabled}
                              aria-label={`${definition.enabled ? 'Disable' : 'Enable'} ${definition.name}`}
                              disabled={busyId === definition.id || !definition.executable}
                              title={definition.executable ? undefined : 'The handler is not implemented yet'}
                              onClick={() => void patchDefinition(definition, { enabled: !definition.enabled })}
                            />
                          </div>
                        )}
                      </article>
                    );
                  })}
                </section>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
