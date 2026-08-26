import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { SideNav } from '../components/AppChrome';
import '../variants/flow.css';
import '../variants/zen.css';
import './people.css';

const PAGE_SIZE = 30;

interface ContactCursor { createdAt: string; id: string }
interface ActivityCursor { occurredAt: string; id: number }
interface RoleDefinition { key: string; name: string; description: string }
interface ContactRow {
  id: string; displayName: string; primaryEmail: string | null; primaryPhone: string | null;
  status: 'active' | 'archived'; entityType: 'person' | 'business'; roles: string[];
  linkedSignalCount: number; lastSignalAt: string | null; createdAt: string; updatedAt: string;
}
interface ContactsPayload { contacts: ContactRow[]; count: number; nextCursor: ContactCursor | null }
interface ContactLookup { id: string; displayName: string; primaryEmail: string | null; primaryPhone: string | null }
interface ContactDetailPayload {
  contact: ContactRow;
  roles: Array<{ role_key: string; source_system: string; last_seen_at: string }>;
  identifiers: Array<{
    id: string; kind: 'email' | 'phone' | 'provider'; value: string; displayName: string | null;
    classification: string; confidence: number; primary: boolean;
    source: { system: string; recordType: string; recordId: string };
    firstSeenAt: string; lastSeenAt: string;
  }>;
  sources: Array<{ source_system: string; source_record_type: string; source_record_id: string; last_synced_at: string }>;
}
interface ContactActivity {
  id: number; source: 'gmail' | 'quo'; event_type: string; direction: 'inbound' | 'outbound';
  subject: string; preview: string; occurred_at: string; actor_email: string | null; actor_phone: string | null;
  classifications?: Array<{ label_kind: 'topic' | 'urgency'; label: { key: string; name: string; color: string } | null }>;
}
interface ContactActivitiesPayload { signals: ContactActivity[]; nextCursor: ActivityCursor | null }
interface SuggestionCandidate {
  contact: { id: string; displayName: string; primaryEmail: string | null; primaryPhone: string | null };
  confidence: number; sourceSystem: string;
}
interface ContactSuggestion {
  id: string; identity_id: string; suggestion_type: 'create' | 'link' | 'ignore' | 'conflict';
  proposed_entity_type: 'person' | 'business' | null; proposed_role_key: string | null;
  proposed_display_name: string | null; confidence: number | null; reason: string; created_at: string;
  identity: { id: string; kind: 'email' | 'phone' | 'provider'; display_value: string; display_name: string | null; classification: string } | null;
  activity: { id: number; source: 'gmail' | 'quo'; event_type: string; direction: string; subject: string; preview: string; occurred_at: string } | null;
  candidates: SuggestionCandidate[];
}
interface SuggestionsPayload { suggestions: ContactSuggestion[]; count: number; nextCursor: ContactCursor | null }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload !== null && typeof payload === 'object' && 'error' in payload &&
      typeof (payload as { error: unknown }).error === 'string'
      ? (payload as { error: string }).error : `the server answered HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return `${words[0]?.[0] ?? ''}${words.length > 1 ? words[words.length - 1]?.[0] ?? '' : ''}`.toUpperCase();
}

function relativeTime(value: string | null): string {
  if (value === null) return 'No activity yet';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return 'Unknown time';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function cursorQuery(cursor: ContactCursor | ActivityCursor | null): string {
  if (cursor === null) return '';
  const params = new URLSearchParams();
  params.set('cursorAt', 'createdAt' in cursor ? cursor.createdAt : cursor.occurredAt);
  params.set('cursorId', String(cursor.id));
  return `&${params.toString()}`;
}

const sourceLabel = (source: 'gmail' | 'quo') => source === 'gmail' ? 'Gmail' : 'Quo';

function ContactDetail({ contactId, onClose }: { contactId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ContactDetailPayload | null>(null);
  const [activities, setActivities] = useState<ContactActivity[]>([]);
  const [nextCursor, setNextCursor] = useState<ActivityCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadActivities = useCallback(async (cursor: ActivityCursor | null, append: boolean) => {
    if (append) setLoadingMore(true);
    const payload = await api<ContactActivitiesPayload>(`/api/contacts/${contactId}/activities?limit=${PAGE_SIZE}${cursorQuery(cursor)}`);
    setActivities((current) => append ? [...current, ...payload.signals] : payload.signals);
    setNextCursor(payload.nextCursor);
    if (append) setLoadingMore(false);
  }, [contactId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    Promise.all([
      api<ContactDetailPayload>(`/api/contacts/${contactId}`),
      api<ContactActivitiesPayload>(`/api/contacts/${contactId}/activities?limit=${PAGE_SIZE}`),
    ]).then(([nextDetail, nextActivities]) => {
      if (cancelled) return;
      setDetail(nextDetail); setActivities(nextActivities.signals); setNextCursor(nextActivities.nextCursor);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contactId]);

  return (
    <aside className="pp-detail" aria-label="Contact details">
      <button type="button" className="pp-detail-close" onClick={onClose} aria-label="Close Contact details">×</button>
      {loading ? <div className="pp-state">Loading Contact…</div> : error ? (
        <div className="pp-state pp-state-error"><strong>Couldn’t load Contact</strong><p>{error}</p></div>
      ) : detail ? <>
        <header className="pp-detail-head">
          <span className="pp-avatar pp-avatar-large">{initials(detail.contact.displayName)}</span>
          <div><span className="pp-kicker">{detail.contact.entityType}</span><h2>{detail.contact.displayName}</h2><p>{detail.contact.primaryEmail ?? detail.contact.primaryPhone ?? 'No primary identifier'}</p></div>
        </header>
        <section className="pp-detail-section"><h3>Roles</h3><div className="pp-pills">
          {detail.roles.length > 0 ? detail.roles.map((role) => <span key={`${role.role_key}:${role.source_system}`}>{role.role_key}</span>) : <small>No role assigned</small>}
        </div></section>
        <section className="pp-detail-section"><h3>Identifiers</h3><div className="pp-identifiers">
          {detail.identifiers.map((identifier) => <div key={identifier.id}><span>{identifier.kind}</span><strong>{identifier.value}</strong><small>{identifier.source.system} · exact match</small></div>)}
        </div></section>
        <section className="pp-detail-section pp-history"><h3>Activity <span>{activities.length}</span></h3>
          {activities.length === 0 ? <p className="pp-muted">No linked Gmail or Quo activity.</p> : activities.map((signal) => {
            const topic = signal.classifications?.find((classification) => classification.label_kind === 'topic')?.label;
            return <article key={signal.id}>
              <div className={`pp-source-mark is-${signal.source}`}>{signal.source === 'gmail' ? 'M' : 'Q'}</div>
              <div><strong>{signal.subject}</strong><p>{signal.preview || 'No preview'}</p><small>{sourceLabel(signal.source)} · {signal.direction} · {relativeTime(signal.occurred_at)}</small></div>
              {topic ? <span className="pp-topic" style={{ borderColor: topic.color }}>{topic.name}</span> : null}
            </article>;
          })}
          {nextCursor ? <button type="button" className="pp-more" disabled={loadingMore} onClick={() => void loadActivities(nextCursor, true).catch((cause: unknown) => { setLoadingMore(false); setError(cause instanceof Error ? cause.message : String(cause)); })}>{loadingMore ? 'Loading…' : 'Load older activity'}</button> : null}
        </section>
      </> : null}
    </aside>
  );
}

export function PeoplePage({ onNavigate, header }: { onNavigate: (label: string) => void; header: ReactNode }) {
  const [tab, setTab] = useState<'contacts' | 'suggestions'>('contacts');
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [role, setRole] = useState('');
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [contactCount, setContactCount] = useState(0);
  const [contactCursor, setContactCursor] = useState<ContactCursor | null>(null);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [suggestionCursor, setSuggestionCursor] = useState<ContactCursor | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [linkingSuggestionId, setLinkingSuggestionId] = useState<string | null>(null);
  const [linkContactId, setLinkContactId] = useState('');
  const [linkQuery, setLinkQuery] = useState('');
  const [linkOptions, setLinkOptions] = useState<ContactLookup[]>([]);
  const [busySuggestionId, setBusySuggestionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roleName = useMemo(() => new Map(roles.map((item) => [item.key, item.name])), [roles]);

  const loadContacts = useCallback(async (cursor: ContactCursor | null, append: boolean, selectedRole = role) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (selectedRole) params.set('role', selectedRole);
      if (cursor) { params.set('cursorAt', cursor.createdAt); params.set('cursorId', cursor.id); }
      const payload = await api<ContactsPayload>(`/api/contacts?${params.toString()}`);
      setContacts((current) => append ? [...current, ...payload.contacts] : payload.contacts);
      setContactCount(payload.count); setContactCursor(payload.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (append) setLoadingMore(false); else setLoading(false); }
  }, [role]);

  const loadSuggestions = useCallback(async (cursor: ContactCursor | null, append: boolean) => {
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const payload = await api<SuggestionsPayload>(`/api/contact-suggestions?limit=${PAGE_SIZE}${cursorQuery(cursor)}`);
      setSuggestions((current) => append ? [...current, ...payload.suggestions] : payload.suggestions);
      setSuggestionCount(payload.count); setSuggestionCursor(payload.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (append) setLoadingMore(false); else setLoading(false); }
  }, []);

  useEffect(() => {
    void api<{ roles: RoleDefinition[] }>('/api/contacts/roles')
      .then((payload) => setRoles(payload.roles))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    void api<SuggestionsPayload>('/api/contact-suggestions?limit=1')
      .then((payload) => setSuggestionCount(payload.count))
      .catch(() => undefined);
  }, []);
  useEffect(() => { void loadContacts(null, false, role); }, [loadContacts, role]);
  useEffect(() => { if (tab === 'suggestions') void loadSuggestions(null, false); }, [loadSuggestions, tab]);
  useEffect(() => {
    if (linkingSuggestionId === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: linkQuery.trim() });
      void api<{ contacts: ContactLookup[] }>(`/api/contacts/search?${params.toString()}`)
        .then((payload) => { if (!cancelled) setLinkOptions(payload.contacts); })
        .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [linkQuery, linkingSuggestionId]);

  const resolveSuggestion = async (suggestionId: string, action: 'create' | 'link' | 'ignore', contactId?: string) => {
    setBusySuggestionId(suggestionId); setError(null);
    try {
      await api(`/api/contact-suggestions/${suggestionId}/resolve`, { method: 'POST', body: JSON.stringify({ action, ...(action === 'link' ? { contactId } : {}) }) });
      setSuggestions((current) => current.filter((suggestion) => suggestion.id !== suggestionId));
      setSuggestionCount((current) => Math.max(0, current - 1));
      setLinkingSuggestionId(null); setLinkContactId(''); setLinkQuery(''); setLinkOptions([]);
      await loadContacts(null, false, role);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusySuggestionId(null); }
  };

  return <div className="v v-flow v-zen pp-root"><div className="fl-shell">
    <SideNav active="Contacts" onNav={onNavigate} />
    <div className="fl-frame">{header}<main className="pp-main"><div className="pp-inner">
      <header className="pp-head"><div><h1>Contacts</h1><p>People and businesses connected across Gmail, Quo messages, and calls.</p></div><div className="pp-counts"><span><strong>{contactCount.toLocaleString()}</strong> Contacts</span><span><strong>{suggestionCount.toLocaleString()}</strong> to review</span></div></header>
      <nav className="pp-mode-tabs" aria-label="Contacts sections">
        <button type="button" className={tab === 'contacts' ? 'is-active' : ''} onClick={() => setTab('contacts')}>Contacts</button>
        <button type="button" className={tab === 'suggestions' ? 'is-active' : ''} onClick={() => setTab('suggestions')}>Suggestions {suggestionCount > 0 ? <span>{suggestionCount}</span> : null}</button>
      </nav>
      {tab === 'contacts' ? <div className="pp-toolbar"><button type="button" className={!role ? 'is-active' : ''} onClick={() => setRole('')}>All</button>{roles.map((item) => <button type="button" key={item.key} className={role === item.key ? 'is-active' : ''} onClick={() => setRole(item.key)}>{item.name}</button>)}</div> : null}
      {error ? <div className="pp-state pp-state-error" role="alert"><strong>Couldn’t complete that request</strong><p>{error}</p><button type="button" onClick={() => tab === 'contacts' ? void loadContacts(null, false) : void loadSuggestions(null, false)}>Try again</button></div>
        : loading ? <div className="pp-state" role="status">Loading {tab}…</div>
        : tab === 'contacts' ? contacts.length === 0 ? <div className="pp-state"><strong>No Contacts in this view</strong><p>Unmatched identities stay hidden until they are safely resolved.</p></div> : <section className="pp-directory" aria-label="Contact directory">
          <div className="pp-columns" aria-hidden="true"><span>Contact</span><span>Identifiers</span><span>Role</span><span>Activity</span></div>
          {contacts.map((contact) => <button type="button" className="pp-row" key={contact.id} onClick={() => setSelectedContactId(contact.id)}>
            <span className="pp-person"><span className="pp-avatar">{initials(contact.displayName)}</span><span><strong>{contact.displayName}</strong><small>{contact.entityType}</small></span></span>
            <span className="pp-contact"><span>{contact.primaryEmail ?? contact.primaryPhone ?? 'No primary identifier'}</span><small>{contact.primaryEmail && contact.primaryPhone ? contact.primaryPhone : ''}</small></span>
            <span className="pp-pills">{contact.roles.length > 0 ? contact.roles.map((item) => <span key={item}>{roleName.get(item) ?? item}</span>) : <small>No role</small>}</span>
            <span className="pp-signals"><span>{contact.linkedSignalCount.toLocaleString()}</span><small>{relativeTime(contact.lastSignalAt)}</small></span>
          </button>)}
          {contactCursor ? <button type="button" className="pp-more" disabled={loadingMore} onClick={() => void loadContacts(contactCursor, true)}>{loadingMore ? 'Loading…' : 'Load more Contacts'}</button> : <p className="pp-end">Showing all {contactCount.toLocaleString()} Contacts</p>}
        </section>
        : suggestions.length === 0 ? <div className="pp-state pp-empty"><strong>No pending suggestions</strong><p>Exact matches are attached automatically. Ambiguous identities wait here instead of being guessed.</p></div>
        : <section className="pp-suggestions" aria-label="Contact suggestions">{suggestions.map((suggestion) => {
          const identity = suggestion.identity; const busy = busySuggestionId === suggestion.id; const linking = linkingSuggestionId === suggestion.id;
          return <article key={suggestion.id} className={`pp-suggestion is-${suggestion.suggestion_type}`}>
            <header><div className="pp-avatar">{initials(suggestion.proposed_display_name ?? identity?.display_name ?? identity?.display_value ?? '?')}</div><div><span className="pp-kicker">{suggestion.suggestion_type === 'conflict' ? 'Identity conflict' : 'Contact suggestion'}</span><h2>{suggestion.proposed_display_name ?? identity?.display_name ?? identity?.display_value ?? 'Unidentified signal'}</h2><p>{identity?.display_value ?? 'No usable identifier'}</p></div><span className="pp-confidence">{suggestion.confidence === null ? 'Review' : `${Math.round(suggestion.confidence * 100)}%`}</span></header>
            <p className="pp-reason">{suggestion.reason}</p><div className="pp-suggestion-meta">{suggestion.proposed_role_key ? <span>{roleName.get(suggestion.proposed_role_key) ?? suggestion.proposed_role_key}</span> : null}{suggestion.activity ? <span>{sourceLabel(suggestion.activity.source)} · {suggestion.activity.subject}</span> : null}</div>
            {suggestion.candidates.length > 0 ? <div className="pp-candidates"><small>Contacts currently claiming this exact identity</small>{suggestion.candidates.map((candidate) => <button key={candidate.contact.id} type="button" disabled={busy} onClick={() => void resolveSuggestion(suggestion.id, 'link', candidate.contact.id)}><strong>{candidate.contact.displayName}</strong><span>{candidate.contact.primaryEmail ?? candidate.contact.primaryPhone}</span></button>)}</div> : null}
            {linking ? <div className="pp-linker"><input type="search" value={linkQuery} onChange={(event) => setLinkQuery(event.target.value)} placeholder="Search name, email, or phone" aria-label="Search existing Contacts" autoFocus /><select value={linkContactId} onChange={(event) => setLinkContactId(event.target.value)} aria-label="Existing Contact"><option value="">Choose a Contact…</option>{linkOptions.map((contact) => <option value={contact.id} key={contact.id}>{contact.displayName} — {contact.primaryEmail ?? contact.primaryPhone ?? 'no identifier'}</option>)}</select><button type="button" disabled={!linkContactId || busy} onClick={() => void resolveSuggestion(suggestion.id, 'link', linkContactId)}>Link</button><button type="button" disabled={busy} onClick={() => { setLinkingSuggestionId(null); setLinkContactId(''); setLinkQuery(''); setLinkOptions([]); }}>Cancel</button></div>
              : <footer>{suggestion.suggestion_type !== 'conflict' ? <button type="button" className="pp-primary" disabled={busy} onClick={() => void resolveSuggestion(suggestion.id, 'create')}>Create Contact</button> : null}<button type="button" disabled={busy} onClick={() => { setLinkingSuggestionId(suggestion.id); setLinkContactId(''); setLinkQuery(''); }}>Link existing</button><button type="button" disabled={busy} onClick={() => void resolveSuggestion(suggestion.id, 'ignore')}>Ignore / system</button></footer>}
          </article>;
        })}{suggestionCursor ? <button type="button" className="pp-more" disabled={loadingMore} onClick={() => void loadSuggestions(suggestionCursor, true)}>{loadingMore ? 'Loading…' : 'Load more suggestions'}</button> : null}</section>}
    </div></main>{selectedContactId ? <ContactDetail contactId={selectedContactId} onClose={() => setSelectedContactId(null)} /> : null}</div>
  </div></div>;
}
