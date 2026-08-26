import { useEffect, useRef, useState } from 'react';
import { Act } from '../board/contract';
import { ActionDetail, Person } from '../types';
import { fmtAge } from '../time';
import { DirectionTag, SourceTag } from '../variants/shared';
import './live-action.css';

export function LiveActionPopup({
  detail,
  person,
  now,
  act,
  onClose,
  onOpenSignal,
}: {
  detail: ActionDetail | undefined;
  person: Person | null;
  now: number;
  act: Act;
  onClose: () => void;
  onOpenSignal?: (id: string) => void;
}) {
  const action = detail?.action ?? null;
  const [draft, setDraft] = useState('');
  const [showFullMessage, setShowFullMessage] = useState(false);
  const [busy, setBusy] = useState<'save' | 'send' | 'retry' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { setDraft(action?.draftBody ?? ''); }, [action?.id, action?.draftBody, action?.draftRevision]);
  useEffect(() => { setShowFullMessage(false); }, [detail?.sourceSignal?.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    if (action?.status === 'awaiting_approval') draftRef.current?.focus();
  }, [action?.id, action?.status]);

  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<void>, close = false) => {
    setBusy(kind); setError(null);
    try { await work(); if (close) onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Action update failed'); }
    finally { setBusy(null); }
  };

  if (detail?.loading || !detail) {
    return <div className="fl-scrim" onClick={onClose}><div className="fc la-popup" onClick={(event) => event.stopPropagation()}><div className="la-state">Loading Action…</div></div></div>;
  }
  if (detail.error || !action) {
    return <div className="fl-scrim" onClick={onClose}><div className="fc la-popup" onClick={(event) => event.stopPropagation()}><div className="la-state la-error">{detail.error ?? 'Action not found'}</div></div></div>;
  }

  const source = detail.sourceSignal;
  const editable = action.status === 'awaiting_approval' || action.status === 'simulated';
  const changed = editable && draft.trim() !== (action.draftBody ?? '').trim();
  const status = action.status === 'drafting' ? 'Hermes drafting'
    : action.status === 'awaiting_approval' ? 'Needs your approval'
      : action.status === 'simulated' ? 'Sent (simulation)'
        : action.status === 'failed' ? 'Drafting failed' : action.status;
  const latestMessage = source?.text.trim() || 'The source message could not be loaded.';
  const messageMayOverflow = latestMessage.length > 420 || latestMessage.split(/\r?\n/).length > 6;
  const threadCount = Math.max(source?.threadMessageCount ?? 1, 1);
  const displayName = person?.name ?? action.recipient;

  return (
    <div className="fl-scrim" onClick={onClose}>
      <div className="fc la-popup" role="dialog" aria-modal="true" aria-label={`Reply to ${displayName}`} onClick={(event) => event.stopPropagation()}>
        <header className="fc-head la-head">
          <div className="fc-head-main">
            <b>Reply to {displayName}</b>
            <span className="fc-head-sub">{action.subject} · <span className={`la-status is-${action.status}`}>{status}</span></span>
          </div>
          <button className="fl-x" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
        </header>

        <div className="fc-body la-body">
          <section className="la-latest" aria-labelledby="la-latest-title">
            <div className="la-section-head">
              <span id="la-latest-title">Latest message</span>
              {source && (
                <span className="la-source-meta">
                  <SourceTag channel={source.channel} />
                  <DirectionTag direction={source.direction ?? 'inbound'} />
                  <span>· {fmtAge(source.at, now)}</span>
                </span>
              )}
            </div>
            <p id="la-latest-message" className={showFullMessage ? 'is-expanded' : 'is-clamped'}>{latestMessage}</p>
            <div className="la-context-actions">
              {messageMayOverflow && (
                <button type="button" aria-expanded={showFullMessage} aria-controls="la-latest-message" onClick={() => setShowFullMessage((value) => !value)}>
                  {showFullMessage ? 'Show less' : 'Show full message'}
                </button>
              )}
              {source && onOpenSignal && (
                <button type="button" onClick={() => onOpenSignal(source.id)}>
                  View thread ({threadCount})
                </button>
              )}
            </div>
          </section>

          <section className="la-compose" aria-labelledby="la-compose-title">
            <div className="la-section-head">
              <span id="la-compose-title">Your reply</span>
              <span>To {action.recipient}</span>
            </div>

            {action.status === 'drafting' && <div className="la-agent-state" role="status"><i className="fs-run-i" /> Hermes is drafting the reply body.</div>}
            {action.status === 'failed' && <div className="la-agent-state is-error" role="alert">{action.lastError ?? 'Hermes could not create the draft.'}</div>}
            {editable && (
              <>
                <label className="la-draft-label" htmlFor="la-draft-body">Email body</label>
                <textarea
                  ref={draftRef}
                  id="la-draft-body"
                  value={draft}
                  readOnly={!editable}
                  aria-readonly={!editable}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={50_000}
                />
                <div className="la-draft-meta">Draft revision {action.draftRevision} · recipient and Gmail thread are controlled by Fluid</div>
                <p className="la-simulation-note"><strong>Simulation only.</strong> Send records your approval here; it does not deliver an email to the customer.</p>
              </>
            )}
          </section>

          {action.status === 'simulated' && (
            <div className="la-simulation" role="status">
              <strong>Sent (simulation)</strong>
              <p>No Gmail request was made, no outbound Activity was created, and the customer did not receive this. The Action stays open until Fluid sees a real Gmail reply.</p>
            </div>
          )}

          <details className="la-details">
            <summary>Why this was suggested</summary>
            <p>{action.reason}</p>
          </details>
          {detail.events.length > 0 && (
            <details className="la-details la-audit">
              <summary>Activity ({detail.events.length})</summary>
              {detail.events.map((event) => <div key={event.id}><span>{event.event_type.replace(/_/g, ' ')}</span><small>{fmtAge(Date.parse(event.created_at), now)}</small></div>)}
            </details>
          )}
          {error && <div className="la-error" role="alert">{error}</div>}
          <span className="la-sr" aria-live="polite">{busy ? `${busy} in progress` : error ?? status}</span>
        </div>

        <footer className="la-actions">
          <button type="button" className="fc-chip" disabled={busy !== null} onClick={() => void run('dismiss', () => act.dismissAction(action.id), true)}>Cancel Action</button>
          <span />
          {action.status === 'failed' && <button type="button" className="fc-chip fc-chip-primary" disabled={busy !== null} onClick={() => void run('retry', () => act.retryAction(action.id))}>{busy === 'retry' ? 'Retrying…' : 'Retry draft'}</button>}
          {editable && changed && <button type="button" className="fc-chip" disabled={busy !== null || !draft.trim()} onClick={() => void run('save', () => act.updateActionDraft(action.id, action.draftRevision ?? 0, draft))}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>}
          {action.status === 'awaiting_approval' && <button type="button" className="fc-chip fc-chip-primary" disabled={busy !== null || changed || !draft.trim()} title={changed ? 'Save your edit before simulating Send' : 'Records a simulation only; Gmail is not called'} onClick={() => void run('send', () => act.simulateActionSend(action.id, action.draftRevision ?? 0))}>{busy === 'send' ? 'Recording…' : 'Send (simulation)'}</button>}
        </footer>
      </div>
    </div>
  );
}
