import { MouseEvent, useState } from 'react';
import { fmtAge } from '../time';
import { Channel, LeadCandidate, LeadCandidateDisposition, Signal } from '../types';
import { Empty, SourceTag } from '../variants/shared';
import { StageTouches } from './PipelineColumns';
import './potential-leads.css';

export const POTENTIAL_LEADS_META = {
  icon: '🧲',
  label: 'Potential Leads',
  hint: 'The Potential Lead Classifier flags unknown inbound email, text, and calls here for human review.',
};

const MISSED_CALL = new Set(['missed', 'no-answer', 'no_answer', 'voicemail', 'cancelled', 'canceled', 'failed', 'ringing']);

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return value;
}

export function candidateChannel(eventType: string, source: 'gmail' | 'quo'): Channel {
  return eventType === 'call.completed' ? 'call' : source === 'gmail' ? 'email' : 'sms';
}

/** Who the card is about, from the best evidence available. */
export function candidateName(candidate: LeadCandidate): string {
  return candidate.name?.trim()
    || candidate.claimedName?.trim()
    || candidate.signal.actorName?.trim()
    || candidate.email
    || (candidate.phone ? formatPhone(candidate.phone) : '')
    || 'Unknown';
}

/** What they wanted, in one line: the agent's summary first, then the Quo
 *  call summary, then whatever the provider gave us. */
export function candidateSummary(candidate: LeadCandidate): string {
  const summary = candidate.summary.trim();
  if (summary) return summary;
  const callSummary = candidate.signal.callSummary.find((line) => line.trim());
  if (callSummary) return callSummary.trim();
  if (candidate.channel === 'call') {
    const status = (candidate.signal.callStatus ?? '').toLowerCase();
    if (status === 'voicemail') return 'Left a voicemail';
    if (MISSED_CALL.has(status) || !candidate.signal.durationSeconds) return 'Missed call';
    return 'Called in';
  }
  return candidate.signal.preview.trim() || candidate.signal.subject.trim() || '(no message text)';
}

/** A Signal-shaped stand-in so the popup can open before the detail loads. */
export function candidateSignal(candidate: LeadCandidate): Signal {
  return {
    id: candidate.activityId,
    personId: `candidate:${candidate.id}`,
    channel: candidate.channel,
    at: candidate.signal.occurredAt,
    text: candidate.signal.preview.trim() || candidateSummary(candidate),
    requiresReply: false,
    title: candidate.signal.subject,
    source: candidate.signal.source,
    eventType: candidate.signal.eventType,
    direction: 'inbound',
    actorEmail: candidate.email,
    actorPhone: candidate.phone,
    readAt: undefined,
  };
}

function verdictLabel(disposition: LeadCandidateDisposition): string {
  return disposition === 'lead' ? '✓ Lead' : disposition === 'not_lead' ? '✕ Not a lead' : 'Needs a verdict';
}

function stop(event: MouseEvent) {
  event.stopPropagation();
}

/** The Lead / Not a lead pair, or the decision with an Undo. */
export function VerdictControls({
  candidate,
  now,
  pending,
  onDecide,
}: {
  candidate: LeadCandidate;
  now: number;
  pending: boolean;
  onDecide: (disposition: LeadCandidateDisposition) => void;
}) {
  if (candidate.disposition === 'undecided') {
    return (
      <div className="potential-lead-actions" onClick={stop}>
        <button
          type="button"
          className="potential-lead-btn is-lead"
          disabled={pending}
          onClick={() => onDecide('lead')}
        >
          Lead
        </button>
        <button
          type="button"
          className="potential-lead-btn is-not"
          disabled={pending}
          onClick={() => onDecide('not_lead')}
        >
          Not a lead
        </button>
      </div>
    );
  }
  return (
    <div className="potential-lead-actions" onClick={stop}>
      <span className="potential-lead-decided">
        {candidate.disposition === 'lead'
          ? 'Lead · waiting for a CRM Contact'
          : `Not a lead${candidate.decidedAt ? ` · ${fmtAge(candidate.decidedAt, now)}` : ''}`}
      </span>
      <button
        type="button"
        className="potential-lead-btn is-undo"
        disabled={pending}
        onClick={() => onDecide('undecided')}
        title="Put it back with the undecided ones"
      >
        Undo
      </button>
    </div>
  );
}

function PotentialLeadCard({
  candidate,
  now,
  selected,
  pending,
  error,
  onOpen,
  onDecide,
}: {
  candidate: LeadCandidate;
  now: number;
  selected: boolean;
  pending: boolean;
  error: string | null;
  onOpen: (candidate: LeadCandidate) => void;
  onDecide: (candidate: LeadCandidate, disposition: LeadCandidateDisposition) => void;
}) {
  const name = candidateName(candidate);
  // The whole card is a click target for the mouse, but the keyboard stop is
  // the name button: an article that is itself a button cannot contain the
  // verdict buttons and contact links without nesting interactive controls.
  return (
    <article
      className={`pipeline-card potential-lead is-clickable is-${candidate.disposition}${selected ? ' is-selected' : ''}`}
      onClick={() => onOpen(candidate)}
      data-candidate-id={candidate.id}
    >
      <div className="potential-lead-top">
        <h3>
          <button
            type="button"
            className="pipeline-card-open"
            aria-label={`Open potential lead ${name}: ${candidateSummary(candidate)}`}
            onClick={(event) => { event.stopPropagation(); onOpen(candidate); }}
          >
            {name}
          </button>
        </h3>
        {candidate.disposition !== 'undecided' && (
          <span className={`potential-lead-verdict is-${candidate.disposition}`}>
            {verdictLabel(candidate.disposition)}
          </span>
        )}
      </div>
      <div className="potential-lead-contact">
        {candidate.email && <a href={`mailto:${candidate.email}`} onClick={stop}>{candidate.email}</a>}
        {candidate.phone && <a href={`tel:${candidate.phone}`} onClick={stop}>{formatPhone(candidate.phone)}</a>}
      </div>
      <p className="pipeline-card-message">{candidateSummary(candidate)}</p>
      <div className="card-sub">
        <SourceTag channel={candidate.channel} />
        {candidate.signalCount > 1 && (
          <span className="potential-lead-count" title={`${candidate.signalCount} signals from this contact`}>
            {candidate.signalCount} signals
          </span>
        )}
        <span className="card-age">{fmtAge(candidate.lastSeenAt, now)}</span>
      </div>
      {/* How often anyone has been in touch since they first wrote — the
          same squares as the pipeline, so silence looks the same here. */}
      <StageTouches touches={candidate.touches} now={now} variant="candidate" />
      {error && <p className="potential-lead-error" role="alert">{error}</p>}
      <VerdictControls
        candidate={candidate}
        now={now}
        pending={pending}
        onDecide={(disposition) => onDecide(candidate, disposition)}
      />
    </article>
  );
}

/** Marked leads first — they still need a canonical CRM Contact — then the rest,
 *  each group keeping the server's newest-decision-first order. */
export function splitCandidates(candidates: readonly LeadCandidate[]): {
  undecided: LeadCandidate[];
  decided: LeadCandidate[];
} {
  const undecided = candidates.filter((candidate) => candidate.disposition === 'undecided');
  const leads = candidates.filter((candidate) => candidate.disposition === 'lead');
  const notLeads = candidates.filter((candidate) => candidate.disposition === 'not_lead');
  return { undecided, decided: [...leads, ...notLeads] };
}

export function PotentialLeadsColumn({
  candidates,
  undecidedCount,
  loading,
  now,
  selectedId,
  onOpen,
  onDecide,
}: {
  candidates: LeadCandidate[];
  undecidedCount: number;
  loading: boolean;
  now: number;
  selectedId: number | null;
  onOpen: (candidate: LeadCandidate) => void;
  onDecide: (candidateId: number, disposition: LeadCandidateDisposition) => Promise<void>;
}) {
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const { undecided, decided } = splitCandidates(candidates);

  const decide = (candidate: LeadCandidate, disposition: LeadCandidateDisposition) => {
    if (pendingId !== null) return;
    setPendingId(candidate.id);
    setErrors((current) => {
      const next = { ...current };
      delete next[candidate.id];
      return next;
    });
    void onDecide(candidate.id, disposition)
      .catch((cause) => setErrors((current) => ({
        ...current,
        [candidate.id]: cause instanceof Error ? cause.message : 'Could not save the decision',
      })))
      .finally(() => setPendingId((current) => current === candidate.id ? null : current));
  };

  const renderCard = (candidate: LeadCandidate) => (
    <PotentialLeadCard
      key={candidate.id}
      candidate={candidate}
      now={now}
      selected={selectedId === candidate.id}
      // One save at a time: while any verdict is in flight every verdict
      // button waits, rather than one card's click being quietly dropped.
      pending={pendingId !== null}
      error={errors[candidate.id] ?? null}
      onOpen={onOpen}
      onDecide={decide}
    />
  );

  return (
    <section className="pane pipeline-stage potential-leads" data-stage="potential_leads">
      <header className="pane-head pipeline-stage-head" title={POTENTIAL_LEADS_META.hint}>
        <span className="pipeline-stage-icon" aria-hidden="true">{POTENTIAL_LEADS_META.icon}</span>
        <h2>{POTENTIAL_LEADS_META.label}</h2>
        <span
          className={`pane-count${undecidedCount > 0 ? ' is-alert' : ''}`}
          title={`${undecidedCount} waiting for a verdict`}
          aria-hidden="true"
        >
          {undecidedCount}
        </span>
        <span className="sr-only">{undecidedCount} waiting for a verdict</span>
      </header>
      <div className="pane-scroll pipeline-stage-scroll">
        {undecided.map(renderCard)}
        {undecided.length === 0 && !loading && (
          <Empty>
            Nothing new. The Potential Lead Classifier adds unknown inbound email, text, and calls here for review.
          </Empty>
        )}
        {loading && candidates.length === 0 && <Empty>Loading Potential Leads…</Empty>}
        {decided.length > 0 && (
          <>
            <div className="pipeline-archive-divider">
              <span>Decided</span>
              <span>{decided.length.toLocaleString()}</span>
            </div>
            {decided.map(renderCard)}
          </>
        )}
      </div>
    </section>
  );
}

/** The band at the top of a candidate's Signal popup: who, how to reach
 *  them, what the Potential Lead Classifier found, and the verdict controls. */
export function PotentialLeadBand({
  candidate,
  now,
  onDecide,
}: {
  candidate: LeadCandidate;
  now: number;
  onDecide: (candidateId: number, disposition: LeadCandidateDisposition) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confidence = candidate.confidence === null ? null : Math.round(candidate.confidence * 100);

  const decide = (disposition: LeadCandidateDisposition) => {
    if (pending) return;
    setPending(true);
    setError(null);
    void onDecide(candidate.id, disposition)
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not save the decision'))
      .finally(() => setPending(false));
  };

  return (
    <section className="potential-lead-band" aria-label="Potential lead">
      <div className="potential-lead-band-head">
        <span>{POTENTIAL_LEADS_META.icon} Potential lead</span>
        <span className={`potential-lead-verdict is-${candidate.disposition}`}>
          {verdictLabel(candidate.disposition)}
        </span>
      </div>
      <dl>
        <dt>Name</dt>
        <dd>{candidate.name?.trim() || candidate.signal.actorName?.trim() || 'Not given'}</dd>
        <dt>Email</dt>
        <dd>{candidate.email ? <a href={`mailto:${candidate.email}`}>{candidate.email}</a> : 'Not given'}</dd>
        <dt>Phone</dt>
        <dd>{candidate.phone ? <a href={`tel:${candidate.phone}`}>{formatPhone(candidate.phone)}</a> : 'Not given'}</dd>
      </dl>
      {(candidate.claimedName || candidate.claimedEmail || candidate.claimedPhone) && (
        <p className="potential-lead-claimed">
          They shared: {[
            candidate.claimedName,
            candidate.claimedEmail,
            candidate.claimedPhone ? formatPhone(candidate.claimedPhone) : null,
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      <p className="potential-lead-band-meta">
        {candidate.signalCount === 1 ? '1 signal' : `${candidate.signalCount} signals`}
        {' · first seen '}{fmtAge(candidate.firstSeenAt, now)}
      </p>
      <p className="potential-lead-band-hermes">
        {candidateSummary(candidate)}
        {(candidate.reason.trim() || confidence !== null) && (
          <small>
            Potential Lead Classifier{confidence !== null ? ` · ${confidence}% sure` : ''}
            {candidate.reason.trim() ? ` · ${candidate.reason.trim()}` : ''}
          </small>
        )}
      </p>
      <StageTouches touches={candidate.touches} now={now} variant="candidate" />
      {error && <p className="potential-lead-error" role="alert">{error}</p>}
      <VerdictControls candidate={candidate} now={now} pending={pending} onDecide={decide} />
    </section>
  );
}
