import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type Act } from '../board/contract';
import { candidateName, PotentialLeadBand } from '../board/PotentialLeads';
import { ConversationSkeleton, ConversationTurn } from '../components/Conversation';
import { LeadNotification, leadHeadline, parseLeadNotification } from '../components/LeadNotification';
import { DAY, fmtAge, MIN } from '../time';
import { type LeadCandidate, type Person, type Signal, type SignalAgentEvent, type SignalDetail, type SignalRecordingItem, type State } from '../types';
import {
  Avatar,
  Burst,
  classifyIntent,
  type Derived,
  DirectionTag,
  Empty,
  firstNameOf,
  groupStreamByDay,
  INTENT_META,
  PaneHead,
  RoleTag,
  SourceTag,
} from './shared';

export type SigStatus = {
  key: 'open' | 'action' | 'quiet';
  icon: string;
  label: string;
};

export function statusOf(state: State, signal: Signal): SigStatus {
  if (signal.reviewStatus === 'pending') {
    return { key: 'open', icon: '●', label: 'needs you' };
  }
  if (
    signal.reviewStatus === 'action_open' ||
    state.actions.some((action) => action.sourceSignalId === signal.id)
  ) {
    return { key: 'action', icon: '✦', label: 'action open' };
  }
  if (signal.reviewStatus === 'settled') {
    return { key: 'quiet', icon: '✓', label: 'settled' };
  }
  if (signal.requiresReply) {
    return { key: 'open', icon: '●', label: 'needs you' };
  }
  return { key: 'quiet', icon: '·', label: 'no action needed' };
}

function signalTitle(signal: Signal): string {
  if (signal.title?.trim() && signal.title !== '(no subject)') return signal.title;
  const text = signal.text;
  const intent = classifyIntent(signal);
  const amount = /\$[\d,]+(?:\.\d+)?/.exec(text)?.[0];
  const date = /the (\d{1,2})(?:st|nd|rd|th)?\b/i.exec(text)?.[0];
  const weekday = /before (friday|monday|tuesday|wednesday|thursday|saturday|sunday)/i
    .exec(text)?.[1];
  const quoteNumber = /quote #(\d+)/i.exec(text)?.[0];
  const months = /((?:three|two|3|2|\d+)\s*months)/i.exec(text)?.[1];

  switch (intent) {
    case 'bill':
      return `Invoice to pay${amount ? ` — ${amount}` : ''}`;
    case 'paid':
      return `Payment received${amount ? ` — ${amount}` : ''}`;
    case 'ready':
      if (quoteNumber) {
        return `${quoteNumber.charAt(0).toUpperCase()}${quoteNumber.slice(1)} accepted`;
      }
      return date ? `Green light — confirms ${date}` : 'Green light to start';
    case 'lead': {
      const subject = /cabinet/i.test(text)
        ? 'cabinet work'
        : /exterior/i.test(text)
          ? 'exterior repaint'
          : /interior/i.test(text)
            ? 'interior repaint'
            : /deck/i.test(text)
              ? 'deck staining'
              : /colonial|ranch|story|house|home/i.test(text)
                ? 'a house repaint'
                : null;
      return subject ? `New inquiry — ${subject}` : 'New inquiry';
    }
    case 'urgent':
      return weekday
        ? `Urgent — needed before ${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}`
        : 'Urgent request';
    case 'love':
      return /number|referr|neighbor/i.test(text)
        ? 'Referred you to someone'
        : 'Happy with the work';
    case 'sched':
      if (/gate code/i.test(text)) return 'New gate code shared';
      if (/keys/i.test(text)) return 'Keys ready for the crew';
      if (/hour later|start.*later/i.test(text)) return 'Wants a later start time';
      if (/unlocked/i.test(text)) return 'Gate left open for the crew';
      if (/parking|access/i.test(text)) return 'Site access sorted';
      return 'Job logistics update';
    case 'future':
      return `Future work — check back in ${months ?? 'a few months'}`;
    case 'ask':
      if (/color code/i.test(text)) return 'Wants the old color code';
      if (/garage/i.test(text)) return 'Wants to add the garage door';
      if (/estimate|quote/i.test(text)) return 'Chasing the estimate';
      if (/do you handle|refinishing/i.test(text)) return 'Asking what you handle';
      if (/warehouse/i.test(text)) return 'Warehouse job question';
      return 'Waiting on your answer';
    default:
      if (/wrapped|patched|sanded|prep/i.test(text)) return 'Prep work finished';
      if (/confirmed for|both days|day rate/i.test(text)) return 'Sub confirmed for the job';
      if (/po attached|approval form|w-9|signed/i.test(text)) return 'Paperwork received';
      if (/walkthrough notes|satin|trim color|listing|turnover|eggshell/i.test(text)) {
        return 'Job specs shared';
      }
      if (/final walkthrough|accounting/i.test(text)) return 'Job wrap-up note';
      return 'General update';
  }
}

function formatSignalPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return value;
}

function SignalContactTag({ signal, person }: { signal: Signal; person?: Person }) {
  if (signal.identityResolution?.status === 'conflict') {
    return (
      <span className="fl-role role-conflict" title={signal.identityResolution.reason}>
        ⚠ duplicate contacts
      </span>
    );
  }
  if (signal.identityResolution?.status === 'unresolved') {
    return (
      <span className="fl-role role-unresolved" title={signal.identityResolution.reason}>
        unresolved contact
      </span>
    );
  }
  return person ? <RoleTag role={person.role} /> : null;
}

export function SignalsCol({
  s,
  act,
  d,
  onOpen,
  selId,
  onLoadMore,
  hasMore = false,
  loading = false,
  unreadCount = 0,
}: {
  s: State;
  act: Act;
  d: Derived;
  onOpen: (signal: Signal) => void;
  selId?: string | null;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  /** Column-wide unread total from the API, not the loaded page. */
  unreadCount?: number;
}) {
  const focusName = d.focusPerson?.name ?? null;
  const statuses = new Map(d.streams.map((signal) => [signal.id, statusOf(s, signal)]));
  const openSignals = d.streams.filter((signal) => (
    ['open', 'action'].includes(statuses.get(signal.id)?.key ?? '')
  ));
  const settledSignals = d.streams.filter((signal) => (
    !['open', 'action'].includes(statuses.get(signal.id)?.key ?? '')
  ));

  const renderCard = (signal: Signal) => {
    const person = s.people.find((candidate) => candidate.id === signal.personId);
    const fresh = s.now - signal.at < 4_000;
    const intent = signal.source ? null : classifyIntent(signal);
    const intentMeta = intent ? INTENT_META[intent] : null;
    const money = intent === 'ready' || intent === 'paid';
    const status = statuses.get(signal.id) ?? statusOf(s, signal);
    const settled = !['open', 'action'].includes(status.key);
    // null is unread; a timestamp is read; undefined is a payload that never
    // said, which must not be dressed up as either.
    const unread = signal.readAt === null;
    const read = typeof signal.readAt === 'number';
    return (
      <article
        key={signal.id}
        className={`card fl-sig st-${status.key}${settled ? ' settled' : ''}${unread ? ' is-unread' : read ? ' is-read' : ''}${fresh ? ' fresh' : ''}${intent ? ` int-${intent}` : ''}${selId === signal.id ? ' selected' : ''}`}
        onClick={() => onOpen(signal)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(signal);
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={`Open ${unread ? 'unread ' : ''}Signal from ${person?.name ?? 'unknown contact'}: ${signalTitle(signal)}`}
      >
        {money && fresh && <Burst emojis={['💰', '✨', '🎉']} />}
        <div className="fl-sig-head">
          {unread && <span className="fl-sig-unread" title="Unread" aria-hidden="true" />}
          <span className="fl-sig-identity">
            <span className="fl-sig-name">{person?.name ?? 'Unknown'}</span>
            {signal.actorPhone ? (
              <span className="fl-sig-phone">{formatSignalPhone(signal.actorPhone)}</span>
            ) : null}
          </span>
          <SignalContactTag signal={signal} person={person} />
          {status.key === 'action' && <span className="fl-sig-status">Draft in Actions</span>}
        </div>
        <h3 className="fl-act-title">
          {intentMeta?.emoji ?? (
            signal.channel === 'call' ? '📞' : signal.channel === 'form' ? '🌐' : '💬'
          )}{' '}
          {signalTitle(signal)}
        </h3>
        <p className="card-text">{cardPreview(signal)}</p>
        <div className="card-sub">
          <SourceTag channel={signal.channel} />
          <span className="card-age">{fmtAge(signal.at, s.now)}</span>
        </div>
      </article>
    );
  };

  return (
    <section className="pane fl-signals">
      <PaneHead
        title="Signals"
        count={unreadCount}
        countTitle={unreadCount === 1 ? '1 unread Signal' : `${unreadCount} unread Signals`}
        countTone={unreadCount > 0 ? 'alert' : undefined}
        focusName={focusName}
        onClear={() => act.focus(null)}
      />
      <div
        className="pane-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          if (
            hasMore &&
            !loading &&
            element.scrollHeight - element.scrollTop - element.clientHeight < 240
          ) {
            onLoadMore?.();
          }
        }}
      >
        {groupStreamByDay(openSignals, s.now).map((group) => (
          <div key={group.label} className="sday">
            <div className="sday-label">{group.label}</div>
            {group.items.map(renderCard)}
          </div>
        ))}
        {openSignals.length === 0 && (
          <Empty>
            Nothing needs you right now{focusName ? ` from ${focusName}` : ''} — all settled. 🏁
          </Empty>
        )}
        {settledSignals.length > 0 && (
          <>
            <h4 className="autos-h">Settled</h4>
            {groupStreamByDay(settledSignals, s.now).map((group) => (
              <div key={group.label} className="sday">
                <div className="sday-label">{group.label}</div>
                {group.items.map(renderCard)}
              </div>
            ))}
          </>
        )}
        {loading && <Empty>Loading Signals…</Empty>}
      </div>
    </section>
  );
}

function canonicalLabelStyle(color: string | null | undefined): CSSProperties | undefined {
  return color ? ({ ['--label-color' as string]: color } as CSSProperties) : undefined;
}

function normalizeEmailText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What the card shows of a signal. A lead notification is summarised as who
 *  the lead is and where they came from, rather than the top of its form. */
function cardPreview(signal: Signal): string {
  if (signal.channel !== 'email') return signal.text;
  const normalized = normalizeEmailText(signal.text);
  const lead = parseLeadNotification(normalized);
  if (!lead) return normalized;
  const headline = leadHeadline(lead);
  return headline === '' ? normalized : `New lead — ${headline}`;
}

/** Body for a history turn: a lead notification as fields, anything else as text. */
function emailTurnBody(item: Signal) {
  if (item.channel !== 'email') return item.text;
  const normalized = normalizeEmailText(item.text);
  const lead = parseLeadNotification(normalized);
  return lead ? <LeadNotification fields={lead} /> : normalized;
}

function splitSelectedEmailBody(signal: Signal): { reply: string; quoted: string | null } {
  const reply = signal.channel === 'email' ? normalizeEmailText(signal.text) : signal.text;
  const quoted = signal.quotedText?.trim()
    ? signal.channel === 'email'
      ? normalizeEmailText(signal.quotedText)
      : signal.quotedText.trim()
    : null;
  return { reply, quoted };
}

function fmtClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A compact, theme-native recording player. The browser's own control is a
 *  light-mode slab that swallows the whole turn. */
function CallRecordingPlayer({ recording, label }: {
  recording: SignalRecordingItem;
  label: string | null;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState(recording.duration ?? 0);
  const progress = length > 0 ? Math.min(1, position / length) : 0;
  return (
    <div className="fd-rec">
      <button
        type="button"
        className="fd-rec-btn"
        aria-label={playing ? 'Pause the call recording' : 'Play the call recording'}
        onClick={() => {
          const audio = audioRef.current;
          if (!audio) return;
          if (playing) audio.pause();
          else void audio.play().catch(() => setPlaying(false));
        }}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      {label && <span className="fd-rec-label">{label}</span>}
      <div
        className="fd-rec-bar"
        onClick={(event) => {
          const audio = audioRef.current;
          if (!audio || length <= 0) return;
          const bar = event.currentTarget.getBoundingClientRect();
          audio.currentTime = Math.max(0, Math.min(1, (event.clientX - bar.left) / bar.width)) * length;
        }}
      >
        <span style={{ width: `${progress * 100}%` }} />
      </div>
      <span className="fd-rec-time">
        {playing || position > 0 ? fmtClock(position) : fmtClock(length)}
      </span>
      <audio
        ref={audioRef}
        src={recording.url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPosition(0); }}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          if (Number.isFinite(event.currentTarget.duration) && event.currentTarget.duration > 0) {
            setLength(event.currentTarget.duration);
          }
        }}
      />
    </div>
  );
}

/** Only evidence that exists gets pixels: a playable recording, a summary
 *  with content, a transcript worth opening. Whatever Quo has not produced
 *  yet is one quiet line; whatever it will never produce is silence. */
function SignalEvidence({ signal, detail }: { signal: Signal; detail?: SignalDetail }) {
  const isCall = signal.channel === 'call';
  const attachments = detail?.attachments ?? [];

  const recordings = detail?.recordings?.status === 'available' ? detail.recordings.items : [];
  const callSummary = detail?.callSummary?.status === 'available' &&
    (detail.callSummary.summary.length > 0 || detail.callSummary.nextSteps.length > 0)
    ? detail.callSummary
    : null;
  const transcriptText = detail?.transcript?.status === 'available' ? detail.transcript.text : null;
  const settled = (status: string | null | undefined) => status === 'available' || status === 'unavailable';
  const preparing = isCall && detail ? [
    !settled(detail.recordings?.status) ? 'recording' : null,
    !settled(detail.callSummary?.status) ? 'summary' : null,
    !settled(detail.transcript?.status) ? 'transcript' : null,
  ].filter((item): item is string => item !== null) : [];

  if (attachments.length === 0 && recordings.length === 0 &&
    !callSummary && !transcriptText && preparing.length === 0) {
    return null;
  }

  return (
    <div className="fd-sel-evidence">
      {attachments.map((attachment) => (
        <div className="fd-sel-evidence-row" key={attachment.attachmentKey}>
          <span>Attachment: <b>{attachment.filename}</b> · {attachment.status}</span>
          {attachment.extractedText ? <span>{attachment.extractedText.slice(0, 800)}</span> : null}
        </div>
      ))}
      {recordings.map((recording, index) => (
        <CallRecordingPlayer
          key={recording.id ?? `${recording.url}:${index}`}
          recording={recording}
          label={recordings.length > 1 ? `Recording ${index + 1}` : null}
        />
      ))}
      {callSummary && (
        <div className="fd-sel-evidence-row fd-sel-call-summary">
          <span><b>Call summary</b></span>
          <div className="fd-call-summary-content">
            {callSummary.summary.length > 0 && (
              <ul>
                {callSummary.summary.map((item, index) => (
                  <li key={`summary:${index}`}>{item}</li>
                ))}
              </ul>
            )}
            {callSummary.nextSteps.length > 0 && (
              <div>
                <strong>Next steps</strong>
                <ul>
                  {callSummary.nextSteps.map((item, index) => (
                    <li key={`next:${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
      {transcriptText && (
        <div className="fd-sel-evidence-row fd-sel-transcript">
          <details>
            <summary>Read the call transcript</summary>
            <pre>{transcriptText}</pre>
          </details>
        </div>
      )}
      {preparing.length > 0 && (
        <p className="fd-evidence-pending">
          Quo is still preparing the {preparing.join(' and ')} for this call.
        </p>
      )}
    </div>
  );
}

const AGENT_STATUS_WORDS: Record<SignalAgentEvent['status'], string> = {
  queued: 'queued',
  claimed: 'claimed',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
  superseded: 'superseded',
  retired: 'retired',
  orphaned: 'orphaned',
};

/** Eligibility-gate reasons, translated from their stored slugs. */
const AGENT_SKIP_REASONS: Record<string, string> = {
  'known-contact': 'the sender is already a known contact',
  'automated': 'the sender is automated',
  'unreachable': 'there is no way to reach the sender back',
  'before-start': 'it arrived before this agent went live',
  'system-identity': 'the sender is a system address',
  'not-inbound': 'it is an outbound message',
  'unsupported-event': 'this kind of Signal is outside its scope',
  'unsupported-source': 'this source is outside its scope',
  'disabled': 'the agent was switched off',
  'superseded': 'a newer version of this Signal replaced it',
};

function agentEventLine(event: SignalAgentEvent): string {
  if (event.orphaned || event.status === 'orphaned') return 'Orphaned — no verified active Hermes consumer can claim this work.';
  if (event.status === 'queued') return 'Queued for this automation.';
  if (event.status === 'claimed') return 'Claimed by the Hermes worker.';
  if (event.status === 'running') return 'Started processing this Signal.';
  if (event.status === 'failed') return 'This attempt failed.';
  if (event.status === 'skipped') {
    const reason = event.skipReason
      ? AGENT_SKIP_REASONS[event.skipReason] ?? event.skipReason
      : 'nothing was left to do';
    return `Skipped it — ${reason}.`;
  }
  if (event.status === 'superseded') return 'Superseded by a newer Signal revision.';
  if (event.status === 'retired') return 'Was retired before it could finish.';
  if (event.verdict === 'lead') {
    const confidence = event.confidence === null ? '' : ` (${Math.round(event.confidence * 100)}% confident)`;
    return `Read it and flagged a potential lead${confidence}.`;
  }
  if (event.verdict === 'not_lead') return 'Read it and decided it is not a lead.';
  if (event.triage) {
    const name = event.triage.proposedDisplayName;
    switch (event.triage.outcome) {
      case 'suggested': return `Read it and suggested creating ${name ? `“${name}”` : 'a new contact'}.`;
      case 'existing': return 'Read it and matched the sender to an existing contact.';
      case 'ignored': return 'Read it and left the sender unlinked.';
      case 'conflict': return 'Read it and found conflicting identities for the sender.';
      case 'below-threshold': return 'Read it but was not confident enough to decide who sent it.';
      default: return 'Read it and recorded a triage decision.';
    }
  }
  if (event.recommendationCount !== null) {
    return event.recommendationCount === 0
      ? 'Read it and had nothing to recommend.'
      : `Read it and prepared ${event.recommendationCount} recommendation${event.recommendationCount === 1 ? '' : 's'}.`;
  }
  return event.result?.summary ?? 'Completed this Signal run.';
}

/** Which agents interacted with the selected Signal — including the ones that
 *  looked and declined, so a quiet Signal is explained rather than silent. */
function SignalAgentActivity({ events, loading, now }: {
  events: SignalAgentEvent[] | null;
  loading: boolean;
  now: number;
}) {
  const ordered = [...events ?? []].sort((left, right) => left.at - right.at);
  return (
    <section className="fc-side-section" aria-label="Agent activity">
      <h4 className="fc-side-head">Agent activity</h4>
      {events === null ? (
        loading ? (
          <div className="fc-side-skel" aria-hidden="true"><span /><span /><span /></div>
        ) : (
          <p className="fc-side-empty">No agent activity recorded.</p>
        )
      ) : ordered.length === 0 ? (
        <p className="fc-side-empty">No agent has looked at this Signal.</p>
      ) : ordered.map((event) => {
        const status = event.orphaned ? 'orphaned' : AGENT_STATUS_WORDS[event.status];
        const content = (
          <>
            <span className="fd-agents-name">
              <b>{event.automationName || event.agentKey}</b>
              <span className={`fd-agents-chip is-${event.orphaned ? 'orphaned' : event.status}`}>{status}</span>
            </span>
            <span className="fd-agents-line" title={event.error ?? event.summary ?? undefined}>
              {agentEventLine(event)}{' '}
              <span className="fd-agents-time">{fmtAge(event.at, now)}</span>
            </span>
          </>
        );
        return event.activityId ? (
          <a className="fd-agents-row is-linked" href={`/activity/${encodeURIComponent(event.activityId)}`} key={event.id}>
            {content}
          </a>
        ) : (
          <details className="fd-agents-row" key={event.id}>
            <summary>{content}</summary>
            <div className="fd-agents-detail">
              <span>Queue job {event.jobId} · attempt {event.queue?.attempt ?? 0}</span>
              {event.warning ? <span>{event.warning}</span> : null}
              {event.legacy ? <span>This event predates Hermes runtime correlation.</span> : null}
            </div>
          </details>
        );
      })}
    </section>
  );
}

export type RunSubject = { type: 'signal'; id: string };

type PopupNotice = { tone: 'status' | 'error'; text: string };

export function RunPopup({
  s,
  act,
  subject,
  onClose,
  onLoadMoreHistory,
  onOpenAction,
  sideBySide = false,
  candidate = null,
  fallbackSignal = null,
}: {
  s: State;
  act: Act;
  subject: RunSubject;
  onClose: () => void;
  onLoadMoreHistory?: (signalId: string) => void;
  onOpenAction?: (actionId: string) => void;
  sideBySide?: boolean;
  /** Opened from Potential Leads: show who they are and take the verdict here. */
  candidate?: LeadCandidate | null;
  /** A Signal-shaped stand-in for one that is not in the loaded column. */
  fallbackSignal?: Signal | null;
}) {
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<PopupNotice | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyScrollAnchorRef = useRef<{
    historyId: string | null;
    historyLength: number;
    viewportTop: number;
  } | null>(null);
  const previousHistoryLengthRef = useRef(0);
  const previousSubjectRef = useRef('');

  // A Signal opened from Potential Leads is usually not in the loaded column,
  // so the loaded detail — or the caller's stand-in — has to be able to carry
  // the popup on its own.
  const detail = s.signalDetails?.[subject.id];
  const signal = s.signals.find((item) => item.id === subject.id) ?? detail?.signal ?? fallbackSignal ?? undefined;
  const selectedSignal = detail?.signal ?? signal;
  const history = [...new Map((detail?.history ?? []).map((item) => [item.id, item])).values()]
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  const subjectKey = `signal:${subject.id}`;
  // The list card has enough data to render the selected Signal immediately,
  // but doing so before its first history page arrives makes that message jump
  // when the history is inserted above it. Treat the initial detail request as
  // one conversation payload; pagination remains incremental after it lands.
  const initialConversationLoading = detail === undefined
    || (detail.loading && detail.signal === null);

  useEffect(() => {
    setAcceptingId(null);
    setNotice(null);
  }, [subject.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let stabilizeLayout: (() => void) | null = null;

    if (previousSubjectRef.current !== subjectKey) {
      previousSubjectRef.current = subjectKey;
      previousHistoryLengthRef.current = history.length;
      historyScrollAnchorRef.current = null;
      element.scrollTop = element.scrollHeight;
      stabilizeLayout = () => {
        const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop;
        if (distanceFromBottom < 48) element.scrollTop = element.scrollHeight;
      };
    } else {
      const anchor = historyScrollAnchorRef.current;
      if (anchor && history.length > anchor.historyLength) {
        const keepHistoryAnchor = () => {
          const anchoredMessage = anchor.historyId === null
            ? null
            : [...element.querySelectorAll<HTMLElement>('[data-history-id]')]
              .find((item) => item.dataset.historyId === anchor.historyId);
          if (!anchoredMessage) return;
          const drift = anchoredMessage.getBoundingClientRect().top - anchor.viewportTop;
          if (Math.abs(drift) < 48) element.scrollTop += drift;
        };
        const anchoredMessage = anchor.historyId === null
          ? null
          : [...element.querySelectorAll<HTMLElement>('[data-history-id]')]
            .find((item) => item.dataset.historyId === anchor.historyId);
        if (anchoredMessage) {
          element.scrollTop += anchoredMessage.getBoundingClientRect().top - anchor.viewportTop;
          stabilizeLayout = keepHistoryAnchor;
        }
        historyScrollAnchorRef.current = null;
      } else if (anchor && detail?.loading === false) {
        historyScrollAnchorRef.current = null;
      } else if (previousHistoryLengthRef.current === 0 && history.length > 0) {
        element.scrollTop = element.scrollHeight;
        stabilizeLayout = () => {
          const distanceFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop;
          if (distanceFromBottom < 48) element.scrollTop = element.scrollHeight;
        };
      }
      previousHistoryLengthRef.current = history.length;
    }

    if (!stabilizeLayout) return;
    let cancelled = false;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      if (scrollRef.current !== element || previousSubjectRef.current !== subjectKey) return;
      stabilizeLayout?.();
      secondFrame = window.requestAnimationFrame(() => {
        if (scrollRef.current === element && previousSubjectRef.current === subjectKey) {
          stabilizeLayout?.();
        }
      });
    });
    void document.fonts?.ready.then(() => {
      if (!cancelled && scrollRef.current === element && previousSubjectRef.current === subjectKey) {
        stabilizeLayout?.();
      }
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [detail?.loading, history.length, subjectKey]);

  if (!signal || !selectedSignal) return null;

  const person = s.people.find((item) => item.id === signal.personId);
  // For a potential lead the candidate is the authority on who this is: the
  // column's own hidden actor for the same activity only knows the raw
  // provider identity.
  const displayName = candidate
    ? candidateName(candidate)
    : person?.name ?? signal.identityResolution?.displayName ?? null;
  const firstName = firstNameOf(displayName ?? 'them');
  const status = statusOf(s, selectedSignal);
  const recommendations = status.key === 'open' ? detail?.recommendations ?? [] : [];
  const laterOutboundSignals = history.filter((item) => (
    item.direction === 'outbound' &&
    item.at > selectedSignal.at &&
    item.at - selectedSignal.at <= 14 * DAY
  ));
  const laterOutbound = laterOutboundSignals[laterOutboundSignals.length - 1];
  const action = s.actions.find((candidate) => candidate.sourceSignalId === signal.id);
  const title = signalTitle(signal);
  const selectedBody = splitSelectedEmailBody(selectedSignal);
  // These notifications are form submissions, not messages, so they render as
  // the record they are rather than as a paragraph to be read.
  const selectedLead = selectedSignal.channel === 'email'
    ? parseLeadNotification(selectedBody.reply)
    : null;
  const popupStatus = status.key === 'open'
    ? { key: 'review', word: 'needs a decision' }
    : status.key === 'action'
      ? { key: 'run', word: 'Action open' }
      : { key: 'queued', word: status.label };

  let lastSpeaker: 'them' | 'you' | null = null;
  let lastSignalMeta: { channel: string; at: number } | null = null;

  const day = (key: string, label: string) => {
    lastSpeaker = null;
    lastSignalMeta = null;
    return <div className="fc-day" key={key}><span>{label}</span></div>;
  };

  const system = (key: string, body: ReactNode) => {
    lastSpeaker = null;
    return <div className="fc-sys" key={key}>{body}</div>;
  };

  const hermesTurn = (key: string, body: ReactNode) => (
    <div className="fd-turn" key={key}>
      <span className="fd-avatar fd-avatar-agent">✦</span>
      <div className="fd-main">
        <div className="fd-name"><b className="fd-name-accent">Hermes</b></div>
        <div className="fd-text">{body}</div>
      </div>
    </div>
  );

  const outboundTurn = (item: Signal) => {
    const grouped = lastSpeaker === 'you';
    lastSpeaker = 'you';
    return (
      <ConversationTurn
        key={item.id}
        side="you"
        sender="You"
        avatar={<Avatar name="Jad" />}
        meta={<><SourceTag channel={item.channel} /><DirectionTag direction="outbound" /></>}
        grouped={grouped}
        time={fmtAge(item.at, s.now)}
        historyId={item.id}
      >
        {emailTurnBody(item)}
      </ConversationTurn>
    );
  };

  const inboundTurn = (item: Signal) => {
    const grouped = lastSpeaker === 'them' &&
      lastSignalMeta?.channel === item.channel &&
      item.at - lastSignalMeta.at < 5 * MIN;
    lastSpeaker = 'them';
    lastSignalMeta = { channel: item.channel, at: item.at };
    return (
      <ConversationTurn
        key={item.id}
        side="them"
        sender={displayName ?? '—'}
        avatar={<Avatar name={displayName ?? '—'} />}
        meta={<>
          <SourceTag channel={item.channel} />
          <DirectionTag direction={item.direction ?? 'inbound'} />
        </>}
        grouped={grouped}
        time={fmtAge(item.at, s.now)}
        historyId={item.id}
      >
        {emailTurnBody(item)}
      </ConversationTurn>
    );
  };

  const loadEarlierHistory = () => {
    if (!onLoadMoreHistory || detail?.loading) return;
    const element = scrollRef.current;
    if (element) {
      const firstHistoryId = history[0]?.id ?? null;
      const firstHistoryMessage = firstHistoryId === null
        ? null
        : [...element.querySelectorAll<HTMLElement>('[data-history-id]')]
          .find((item) => item.dataset.historyId === firstHistoryId);
      historyScrollAnchorRef.current = {
        historyId: firstHistoryId,
        historyLength: history.length,
        viewportTop: firstHistoryMessage?.getBoundingClientRect().top ??
          element.getBoundingClientRect().top,
      };
    }
    onLoadMoreHistory(signal.id);
  };

  // For a potential lead the verdict band above the thread is the decision;
  // the review copy below would only contradict it.
  const decisionSummary = candidate
    ? null
    : status.key === 'open'
    ? selectedSignal.direction === 'outbound'
      ? null
      : laterOutbound
        ? <>
            Your <span className="fd-inline-source">
              <SourceTag channel={laterOutbound.channel} />
              <DirectionTag direction="outbound" />
            </span>{' '}
            reply went out {fmtAge(laterOutbound.at, s.now)}.
          </>
        : recommendations[0]?.reason ?? null
    : status.key === 'action'
      ? <>A reply draft is ready in Actions.</>
      : selectedSignal.reviewResolution === 'no_action'
        ? <>
            This Signal was settled
            {selectedSignal.reviewedAt ? ` ${fmtAge(selectedSignal.reviewedAt, s.now)}` : ''}.
          </>
        : <>{status.label} ✓ Nothing is left here.</>;

  return (
    <div
      className={`fl-scrim${sideBySide ? ' fc-inspector-scrim' : ''}`}
      onClick={sideBySide ? undefined : onClose}
    >
      <div
        className={`fc fc-signal${sideBySide ? ' fc-inspector' : ''}`}
        role={sideBySide ? 'complementary' : 'dialog'}
        aria-label={sideBySide ? `Inspect ${title}` : title}
        aria-modal={sideBySide ? undefined : true}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="fc-head">
          <div className="fc-head-main">
            <b>{title}</b>
            <span className="fc-head-sub">
              {candidate ? (
                <>
                  for {displayName ?? '—'}
                  {' · '}
                  <span className="fc-status fc-status-review">potential lead</span>
                </>
              ) : signal.identityResolution ? (
                <>
                  for {signal.identityResolution.displayName ??
                    signal.identityResolution.displayValue ??
                    person?.name ??
                    'Unknown contact'}
                  {' · '}
                  <span className={`fc-status fc-status-${signal.identityResolution.status === 'conflict' ? 'fail' : 'queued'}`}>
                    {signal.identityResolution.status === 'conflict'
                      ? 'identity conflict'
                      : 'unresolved contact'}
                  </span>
                </>
              ) : (
                <>for {person?.name ?? '—'} ({person?.role ?? '—'})</>
              )}
              {!candidate && (
                <>
                  {' · '}
                  <span className={`fc-status fc-status-${popupStatus.key}`}>{popupStatus.word}</span>
                </>
              )}
            </span>
          </div>
          <button className="fl-x" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </header>

        {candidate && (
          <PotentialLeadBand
            candidate={candidate}
            now={s.now}
            onDecide={act.decideLeadCandidate}
          />
        )}

        {/* Chat in the middle; the straight information rail beside it. */}
        <div className="fc-columns">
        <div className="fc-body cv-thread" ref={scrollRef}>
          {day('d-hist', `History with ${firstName}`)}
          {initialConversationLoading ? <ConversationSkeleton /> : (
            <>
              {detail?.historyNextCursor && system('history-more', (
                <button className="fc-chip" onClick={loadEarlierHistory} disabled={detail.loading}>
                  {detail.loading ? 'Loading history…' : 'Load earlier history'}
                </button>
              ))}
              {history.map((item) => item.direction === 'outbound'
                ? outboundTurn(item)
                : inboundTurn(item))}

              <ConversationTurn
                side={selectedSignal.direction === 'outbound' ? 'you' : 'them'}
                sender={selectedSignal.direction === 'outbound' ? 'You' : displayName ?? '—'}
                avatar={<Avatar name={selectedSignal.direction === 'outbound' ? 'Jad' : displayName ?? '—'} />}
                meta={<>
                  <SourceTag channel={selectedSignal.channel} />
                  <DirectionTag direction={selectedSignal.direction ?? 'inbound'} />
                </>}
                time={fmtAge(selectedSignal.at, s.now)}
                marker="this one"
                highlighted
                historyId={selectedSignal.id}
                subject={selectedSignal.channel === 'email'
                  ? selectedSignal.title?.trim() || '(no subject)'
                  : null}
                tags={selectedSignal.topic || selectedSignal.urgency ? (
                  <div className="fd-sel-tags" aria-label="Signal labels">
                    {selectedSignal.topic && (
                      <span
                        className="fl-plabel canonical-label"
                        style={canonicalLabelStyle(selectedSignal.topicColor)}
                      >
                        {selectedSignal.topic}
                      </span>
                    )}
                    {selectedSignal.urgency && (
                      <span
                        className="fl-plabel canonical-label"
                        style={canonicalLabelStyle(selectedSignal.urgencyColor)}
                      >
                        {selectedSignal.urgency}
                      </span>
                    )}
                  </div>
                ) : null}
              >
                {selectedSignal.channel !== 'call' && (
                  <div className="fd-sel-text">
                    {selectedLead
                      ? <LeadNotification fields={selectedLead} />
                      : <p className="fd-sel-text-reply">{selectedBody.reply}</p>}
                    {selectedBody.quoted && (
                      <details className="fd-sel-quote">
                        <summary>
                          <span className="fd-sel-quote-show">Show quoted history</span>
                          <span className="fd-sel-quote-hide">Hide quoted history</span>
                        </summary>
                        <p className="fd-sel-text-quoted">{selectedBody.quoted}</p>
                      </details>
                    )}
                  </div>
                )}
                <SignalEvidence signal={selectedSignal} detail={detail} />
              </ConversationTurn>

              {detail?.error && hermesTurn(
                'detail-error',
                <>I could not load trustworthy context: {detail.error}</>,
              )}
              {status.key === 'open' && action && hermesTurn(
                'draft-status',
                action.status === 'drafting'
                  ? <>Scribe’s already drafting the reply—check Actions for it.</>
                  : action.status === 'failed'
                    ? <>Scribe tried the reply but hit a wall—it needs you in Actions.</>
                    : <>Scribe drafted a reply—it’s waiting on your review in Actions.</>,
              )}
              {decisionSummary && (
                <article className="fd-dec">
                  <p className="fd-dec-summary">{decisionSummary}</p>
                </article>
              )}
              {notice && (
                <div
                  className={notice.tone === 'error' ? 'fc-sys is-error' : 'fc-sys'}
                  role={notice.tone === 'error' ? 'alert' : 'status'}
                >
                  {notice.text}
                </div>
              )}
              <div className="fc-replies">
                {status.key === 'action' && action && (
                  <button
                    className="fc-chip fc-chip-primary"
                    onClick={() => onOpenAction?.(action.id)}
                  >
                    Open draft action
                  </button>
                )}
                {recommendations.map((recommendation) => (
                  <button
                    key={recommendation.id}
                    className={`fc-chip${recommendation.available ? ' fc-chip-primary' : ''}`}
                    disabled={!recommendation.available || acceptingId !== null}
                    aria-disabled={!recommendation.available}
                    title={recommendation.available
                      ? recommendation.reason
                      : `${recommendation.reason} · Capability unavailable.`}
                    onClick={() => {
                      if (!recommendation.available) return;
                      setAcceptingId(recommendation.id);
                      setNotice(null);
                      void act.acceptRecommendation(signal.id, recommendation.id)
                        .then(() => setNotice({
                          tone: 'status',
                          text: 'Action created. Hermes is drafting it now; review it in Actions.',
                        }))
                        .catch((cause) => setNotice({
                          tone: 'error',
                          text: cause instanceof Error ? cause.message : 'Could not create the Action',
                        }))
                        .finally(() => setAcceptingId(null));
                    }}
                  >
                    {recommendation.available
                      ? acceptingId === recommendation.id ? 'Creating…' : recommendation.label
                      : `🔒 ${recommendation.label}`}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Always mounted: the rail is part of the popup's shape, so nothing
            jumps when its data lands a beat after the chat. */}
        <aside className="fc-side" aria-label="Signal information">
          <SignalAgentActivity
            events={detail?.agentActivity ?? null}
            loading={!detail || (detail.loading && !detail.agentActivity)}
            now={s.now}
          />
        </aside>
        </div>
      </div>
    </div>
  );
}
