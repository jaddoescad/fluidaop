import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Act } from '../board/contract';
import { ActionDetail, Person } from '../types';
import { fmtAge } from '../time';
import { Avatar, DirectionTag, SourceTag } from '../variants/shared';
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
  const [showFullMessage, setShowFullMessage] = useState(false);
  const [busy, setBusy] = useState<'send' | 'retry' | 'dismiss' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // draft editing lives inside the email component, not in the composer
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const awaiting = action?.status === 'awaiting_approval';

  useEffect(() => {
    setEditing(false);
    setEditDraft('');
  }, [action?.id]);
  useEffect(() => { setShowFullMessage(false); }, [detail?.sourceSignal?.id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);
  // the in-component editor grows with the draft body
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editDraft, editing]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [action?.status, editing]);

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
    return <div className="fl-scrim" onClick={onClose}><div className="fc la-popup" onClick={(event) => event.stopPropagation()}><div className="la-state la-state-error">{detail.error ?? 'Action not found'}</div></div></div>;
  }

  const source = detail.sourceSignal;
  const savedDraft = action.draftBody ?? '';
  const canApprove = awaiting && busy === null && !editing && savedDraft.trim().length > 0;
  const status = action.status === 'drafting' ? 'Hermes drafting'
    : action.status === 'awaiting_approval' ? 'Needs your approval'
      : action.status === 'simulated' ? 'Sent (simulation)'
        : action.status === 'failed' ? 'Drafting failed' : action.status;
  const latestMessage = source?.text.trim() || 'The source message could not be loaded.';
  const messageMayOverflow = latestMessage.length > 420 || latestMessage.split(/\r?\n/).length > 6;
  const threadCount = Math.max(source?.threadMessageCount ?? 1, 1);
  const displayName = person?.name ?? action.recipient ?? '—';

  const approve = () => {
    if (!canApprove) return;
    void run('send', () => act.simulateActionSend(action.id, action.draftRevision ?? 0));
  };

  const openEditor = () => {
    setEditDraft(savedDraft);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditDraft('');
  };
  const saveEdit = () => {
    if (busy !== null || editDraft.trim().length === 0) return;
    if (editDraft.trim() === savedDraft.trim()) { cancelEdit(); return; }
    void run('save', async () => {
      await act.updateActionDraft(action.id, action.draftRevision ?? 0, editDraft);
      setEditing(false);
      setEditDraft('');
    });
  };

  const emailCard = (sent: boolean): ReactNode => (
    <div className="fd-work la-email">
      <div className="la-email-head">
        <span className={`fd-work-tag${sent ? ' sent' : ''}`}>{sent ? 'Sent (simulation) ✓' : 'Draft email'}</span>
        {awaiting && !editing && (
          <button type="button" className="la-email-edit" disabled={busy !== null} onClick={openEditor}>
            Edit
          </button>
        )}
      </div>
      <div className="la-email-meta">
        <span>To {action.recipient}</span>
        <span>Subject: {action.subject}</span>
      </div>
      {editing ? (
        <div className="la-email-editor">
          <label className="la-sr" htmlFor="la-email-editor-input">Edit the draft email body</label>
          <textarea
            ref={editorRef}
            id="la-email-editor-input"
            className="fc-input la-email-input"
            rows={1}
            value={editDraft}
            maxLength={50_000}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.stopPropagation(); cancelEdit(); }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); saveEdit(); }
            }}
          />
          <div className="la-email-editor-actions">
            <button type="button" className="fc-chip fc-chip-primary" disabled={busy !== null || editDraft.trim().length === 0} onClick={saveEdit}>
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </button>
            <button type="button" className="fc-chip" disabled={busy !== null} onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="la-email-body">{savedDraft}</p>
      )}
      {sent ? (
        <div className="la-simulation" role="status">
          <strong>Sent (simulation)</strong> · No Gmail request was made, no outbound Signal was created, and the customer did not receive this. The Action stays open until Fluid sees a real Gmail reply.
        </div>
      ) : (
        <div className="la-sim-note">
          Simulation · approving records the decision only — Gmail is never called and nothing is delivered to {displayName}.
        </div>
      )}
    </div>
  );

  return (
    <div className="fl-scrim" onClick={onClose}>
      <div className="fc la-popup" role="dialog" aria-modal="true" aria-label={`Reply to ${displayName}`} onClick={(event) => event.stopPropagation()}>
        <header className="fc-head">
          <div className="fc-head-main">
            <b>Reply to {displayName}</b>
            <span className="fc-head-sub">{action.subject} · <span className={`fc-status la-status is-${action.status}`}>{status}</span></span>
          </div>
          <button className="fl-x" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
        </header>

        <div className="fc-body" ref={scrollRef}>
          <div className="fc-day"><span>Latest message</span></div>

          <div className="fd-turn">
            <span className="fd-avatar"><Avatar name={displayName} /></span>
            <div className="fd-main">
              <div className="fd-name">
                <b>{displayName}</b>
                {source && (
                  <span className="fd-meta fd-meta-signal la-source-meta">
                    <SourceTag channel={source.channel} />
                    <DirectionTag direction={source.direction ?? 'inbound'} />
                    <span>· {fmtAge(source.at, now)}</span>
                  </span>
                )}
              </div>
              <p id="la-latest-message" className={`fd-text la-latest-message ${showFullMessage ? 'is-expanded' : 'is-clamped'}`}>{latestMessage}</p>
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
            </div>
          </div>

          <div className="fc-day"><span>Draft & approval</span></div>

          <div className="fd-turn">
            <span className="fd-avatar fd-avatar-agent" aria-hidden="true">✦</span>
            <div className="fd-main">
              <div className="fd-name">
                <b className="fd-name-accent">Hermes</b>
              </div>
              <div className="fd-text">
                {action.status === 'drafting' && (
                  <span className="la-agent-state" role="status"><i className="fs-run-i" /> Drafting the reply body now…</span>
                )}
                {action.status === 'failed' && (
                  <span className="la-agent-state is-error" role="alert">
                    {action.lastError ?? 'I could not create the draft.'} Nothing went out — retry to get a new draft.
                  </span>
                )}
                {awaiting && (
                  <>
                    Here’s my draft. Approve it below, or edit it first.
                    {emailCard(false)}
                  </>
                )}
                {action.status === 'simulated' && (
                  <>
                    Here’s the reply you approved.
                    {emailCard(true)}
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="fc-replies">
            {awaiting && (
              <button
                type="button"
                className="fc-chip fc-chip-primary"
                disabled={!canApprove}
                title="Records a simulation only; Gmail is not called"
                onClick={approve}
              >
                {busy === 'send' ? 'Recording…' : 'Send (simulation)'}
              </button>
            )}
            {action.status === 'failed' && (
              <button type="button" className="fc-chip fc-chip-primary" disabled={busy !== null} onClick={() => void run('retry', () => act.retryAction(action.id))}>
                {busy === 'retry' ? 'Retrying…' : 'Retry draft'}
              </button>
            )}
          </div>

          <details className="la-details">
            <summary>Why this was suggested</summary>
            <p>{action.reason}</p>
          </details>
          <details className="la-details">
            <summary>Action details</summary>
            <p className="la-detail-meta">Draft revision {action.draftRevision} · recipient and Gmail thread are controlled by Fluid.</p>
            <button type="button" className="la-cancel" disabled={busy !== null} onClick={() => void run('dismiss', () => act.dismissAction(action.id), true)}>
              {busy === 'dismiss' ? 'Cancelling…' : 'Cancel this Action'}
            </button>
          </details>
          {detail.events.length > 0 && (
            <details className="la-details la-audit">
              <summary>History ({detail.events.length})</summary>
              {detail.events.map((event) => <div key={event.id}><span>{event.event_type.replace(/_/g, ' ')}</span><small>{fmtAge(Date.parse(event.created_at), now)}</small></div>)}
            </details>
          )}
          {error && <div className="la-error" role="alert">{error}</div>}
          <span className="la-sr" aria-live="polite">{busy ? `${busy} in progress` : error ?? status}</span>
        </div>

      </div>
    </div>
  );
}
