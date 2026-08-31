import { CHANNEL_LABEL } from '../channels';
import { ConversationDay, ConversationEvent, ConversationTurn, type TurnSide } from '../components/Conversation';
import {
  FormEvent,
  Fragment,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  CalendarPlus,
  CheckCircle2,
  Circle,
  History,
  Mail,
  MessageSquareText,
  Milestone,
  Phone,
  Send,
  Sparkles,
} from 'lucide-react';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '../components/ai-elements/conversation';
import { Message, MessageContent } from '../components/ai-elements/message';
import { fmtAge, fmtDue } from '../time';
import {
  PipelineDeal,
  PipelineEvidenceKind,
  PipelineStageHistory,
  PipelineTouchpoint,
  State,
  SignalDetail,
} from '../types';
import { statusOf } from '../variants/kit';
import { RoleTag, firstNameOf } from '../variants/shared';
import { formatDealAmount, leadSourceMeta, stageMetaOf } from './PipelineColumns';
import './pipeline.css';

function callDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function listPhrase(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function fullDate(at: number): string {
  return new Date(at).toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** "4:55 PM" — the only part of a timestamp that changes between messages in a day. */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Today", "Yesterday", or "Friday, Aug 21" — one divider per day, not per message. */
function dayLabel(at: number): string {
  const day = new Date(at); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString([], {
    weekday: 'long', month: 'short', day: 'numeric',
    ...(new Date(at).getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}

function dayKey(at: number): string {
  const day = new Date(at);
  return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
}

/** Initials for the thread avatar — two letters where a name gives them. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Milestones are not a channel, so they fall outside CHANNEL_LABEL's map. */
function channelLabel(channel: string): string {
  return (CHANNEL_LABEL as Record<string, string>)[channel] ?? channel;
}

/** Which system the message came through — Quo, Gmail, DripJobs. */
function sourceLabel(source: string): string {
  if (source === 'quo') return 'Quo';
  if (source === 'gmail') return 'Gmail';
  if (source === 'dripjobs') return 'DripJobs';
  return source;
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function evidenceLabel(evidence: PipelineEvidenceKind): string {
  if (evidence === 'exact') return 'Exact';
  if (evidence === 'observed') return 'Observed';
  if (evidence === 'inferred') return 'Estimated';
  return 'Unknown';
}

function connectedCall(touchpoint: PipelineTouchpoint): boolean {
  if (['voicemail', 'missed', 'no-answer', 'no_answer', 'ringing', 'failed']
    .includes((touchpoint.callStatus ?? '').toLowerCase())) return false;
  return (touchpoint.durationSeconds ?? 0) > 0
    || ['answered', 'connected'].includes((touchpoint.callStatus ?? '').toLowerCase());
}

function missedInboundCall(touchpoint: PipelineTouchpoint): boolean {
  return touchpoint.direction === 'inbound' && [
    'missed', 'no-answer', 'no_answer', 'cancelled', 'canceled', 'failed',
  ].includes((touchpoint.callStatus ?? '').toLowerCase());
}

function touchpointTitle(touchpoint: PipelineTouchpoint): string {
  if (touchpoint.kind === 'milestone') return touchpoint.subject;
  if (touchpoint.channel === 'call') {
    if ((touchpoint.callStatus ?? '').toLowerCase() === 'voicemail') return 'Voicemail received';
    if (missedInboundCall(touchpoint)) return 'Missed inbound call';
    if (touchpoint.direction === 'outbound') {
      return connectedCall(touchpoint) ? 'Connected outbound call' : 'Outbound call attempt';
    }
    return connectedCall(touchpoint) ? 'Connected inbound call' : 'Inbound call';
  }
  if (touchpoint.channel === 'sms') return touchpoint.direction === 'outbound' ? 'Text sent' : 'Text received';
  if (touchpoint.channel === 'email') return touchpoint.direction === 'outbound' ? 'Email sent' : 'Email received';
  return touchpoint.subject || 'Customer touchpoint';
}


function channelIcon(touchpoint: PipelineTouchpoint) {
  if (touchpoint.channel === 'call') return Phone;
  if (touchpoint.channel === 'email') return Mail;
  if (touchpoint.channel === 'sms') return MessageSquareText;
  return Milestone;
}

type ChannelCounts = { calls: number; texts: number; emails: number };

const CHANNEL_META = [
  { key: 'calls', Icon: Phone, one: 'call', many: 'calls' },
  { key: 'texts', Icon: MessageSquareText, one: 'text', many: 'texts' },
  { key: 'emails', Icon: Mail, one: 'email', many: 'emails' },
] as const;

function countChannels(touchpoints: readonly PipelineTouchpoint[]): ChannelCounts {
  return touchpoints.reduce<ChannelCounts>((total, touchpoint) => {
    if (touchpoint.channel === 'call') total.calls += 1;
    if (touchpoint.channel === 'sms') total.texts += 1;
    if (touchpoint.channel === 'email') total.emails += 1;
    return total;
  }, { calls: 0, texts: 0, emails: 0 });
}

/** Bare icon+digit reads as noise; the channel word is what makes it scannable. */
function renderChannelChips(counts: ChannelCounts, className: string) {
  return (
    <div
      className={className}
      aria-label={`${counts.calls} calls, ${counts.texts} texts, ${counts.emails} emails`}
    >
      {CHANNEL_META.filter(({ key }) => counts[key] > 0).map(({ key, Icon, one, many }) => (
        <span key={key}>
          <Icon aria-hidden="true" />
          <b>{counts[key]}</b> {counts[key] === 1 ? one : many}
        </span>
      ))}
    </div>
  );
}

type DealChatTurn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

/** A deal-scoped Hermes conversation with stage-aware communication history. */
export function LeadWorkspace({
  s,
  deal,
  personId,
  suspended,
  stageHistory,
  stageHistoryLoading,
  onClose,
  onLoadSignal,
  onOpenAction,
}: {
  s: State;
  deal: PipelineDeal;
  personId: string;
  /** A Signal/Action popup is stacked on top — leave Escape to it. */
  suspended: boolean;
  stageHistory: PipelineStageHistory | null;
  stageHistoryLoading: boolean;
  onClose: () => void;
  onLoadSignal: (signalId: string) => void;
  onOpenAction: (actionId: string) => void;
}) {
  const stage = stageMetaOf(deal);
  const person = s.people.find((candidate) => candidate.id === personId);
  const displayName = person?.name ?? deal.customerName;
  /** DripJobs often names the deal after the customer; don't say it twice. */
  const showDealName = deal.dealName.trim().length > 0
    && deal.dealName.trim().toLowerCase() !== displayName.trim().toLowerCase();
  const first = firstNameOf(displayName);
  const [chatInput, setChatInput] = useState('');
  const [chatTurns, setChatTurns] = useState<DealChatTurn[]>([]);
  const [chatPending, setChatPending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const timeline = useMemo(
    () => s.signals
      .filter((signal) => signal.personId === personId)
      .slice()
      .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id)),
    [s.signals, personId],
  );
  const openActions = s.actions.filter((action) => action.personId === personId);
  const openReminders = s.reminders.filter((reminder) => reminder.personId === personId && reminder.doneAt === null);
  const latest = timeline[timeline.length - 1];
  const latestAt = Math.max(latest?.at ?? 0, deal.latestSignalAt ?? 0, person?.latestSignalAt ?? 0) || null;
  const createdAt = stageHistory?.dealCreatedAt ?? deal.capturedAt;
  const createdEvidence = stageHistory?.dealCreatedEvidenceKind ?? 'observed';
  const createdLabel = stageHistory?.dealCreatedLabel ?? 'First seen by Fluid';

  useEffect(() => {
    if (suspended) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [suspended, onClose]);

  useEffect(() => {
    setChatInput('');
    setChatTurns([]);
    setChatPending(false);
    setChatError(null);
  }, [deal.id]);

  const signalById = new Map(timeline.map((signal) => [signal.id, signal]));
  const activityIds = useMemo(() => {
    if (!stageHistory) return [];
    // Call recordings/summaries require a separate request. Prefetch those for
    // this deal, but do not turn a long returning-customer history into
    // hundreds of network requests just to render the conversation.
    return [...stageHistory.unknownStage.touchpoints, ...stageHistory.stages.flatMap((item) => item.touchpoints)]
      .filter((touchpoint) => touchpoint.channel === 'call' && touchpoint.occurredAt >= createdAt)
      .flatMap((touchpoint) => touchpoint.activityId === null ? [] : [String(touchpoint.activityId)]);
  }, [createdAt, stageHistory]);

  const priorTouchpoints = useMemo(() => {
    if (!stageHistory) return [];
    const linked = [
      ...stageHistory.unknownStage.touchpoints,
      ...stageHistory.stages.flatMap((item) => item.touchpoints),
    ].filter((item) => item.kind === 'activity' && item.occurredAt < createdAt);
    return [...new Map(
      [...stageHistory.priorHistory.touchpoints, ...linked].map((item) => [item.id, item]),
    ).values()].sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
  }, [createdAt, stageHistory]);

  const lifecycleSections = useMemo(() => {
    const all = stageHistory
      ? [...stageHistory.unknownStage.touchpoints, ...stageHistory.stages.flatMap((item) => item.touchpoints)]
      : [];
    const unique = [...new Map(all.map((item) => [item.id, item])).values()]
      .filter((item) => item.occurredAt >= createdAt);
    const activities = unique
      .filter((item) => item.kind !== 'milestone')
      .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
    const milestones = unique.filter((item) => item.kind === 'milestone');
    const latestMilestone = (...types: string[]) => milestones
      .filter((item) => types.includes(item.eventType))
      .sort((left, right) => right.occurredAt - left.occurredAt)[0]?.occurredAt ?? null;
    const sections = [
      { key: 'lead-received', label: 'Lead received', at: createdAt, touchpoints: [] as PipelineTouchpoint[] },
      { key: 'appointment-scheduled', label: 'Appointment scheduled', at: latestMilestone('appointment_scheduled'), touchpoints: [] as PipelineTouchpoint[] },
      { key: 'proposal-sent', label: 'Proposal sent', at: latestMilestone('proposal_sent'), touchpoints: [] as PipelineTouchpoint[] },
      { key: 'deal-closed', label: 'Deal closed', at: latestMilestone('deal_closed', 'proposal_accepted'), touchpoints: [] as PipelineTouchpoint[] },
    ];
    activities.forEach((activity) => {
      let destination = sections[0];
      sections.forEach((section) => {
        if (section.at !== null && section.at <= activity.occurredAt && section.at >= (destination.at ?? 0)) destination = section;
      });
      destination.touchpoints.push(activity);
    });
    return sections;
  }, [createdAt, stageHistory]);
  const totalCounts = useMemo(
    () => countChannels(lifecycleSections.flatMap((section) => section.touchpoints)),
    [lifecycleSections],
  );
  const totalTouchpoints = totalCounts.calls + totalCounts.texts + totalCounts.emails;
  const contactSpan = useMemo(() => {
    const times = lifecycleSections
      .flatMap((section) => section.touchpoints.map((touchpoint) => touchpoint.occurredAt))
      .sort((left, right) => left - right);
    if (times.length === 0) return 'No contact recorded yet';
    const days = Math.max(1, Math.round((times[times.length - 1] - times[0]) / 86_400_000));
    return times.length === 1
      ? `On ${shortDate(times[0])}`
      : `${shortDate(times[0])} — ${shortDate(times[times.length - 1])} · ${days === 1 ? '1 day' : `${days} days`}`;
  }, [lifecycleSections]);
  const currentLifecycleKey = [...lifecycleSections].reverse().find((section) => section.at !== null)?.key ?? 'lead-received';

  useEffect(() => {
    activityIds.forEach((id) => {
      if (!s.signalDetails?.[id]) onLoadSignal(id);
    });
  }, [activityIds, onLoadSignal, s.signalDetails]);
  const askHermes = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = chatInput.trim();
    if (!question || chatPending) return;
    const userTurn: DealChatTurn = { id: crypto.randomUUID(), role: 'user', text: question };
    setChatInput('');
    setChatError(null);
    setChatPending(true);
    setChatTurns((current) => [...current, userTurn]);
    try {
      const response = await fetch('/api/hermes/deal-chat', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId: deal.id, message: question }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === 'object' && 'error' in payload
          && typeof payload.error === 'string' ? payload.error : 'Hermes could not answer right now.';
        throw new Error(message);
      }
      if (!payload || typeof payload !== 'object' || !('reply' in payload) || typeof payload.reply !== 'string') {
        throw new Error('Hermes returned an invalid response.');
      }
      const reply = payload.reply;
      setChatTurns((current) => [...current, {
        id: crypto.randomUUID(), role: 'assistant', text: reply,
      }]);
    } catch (cause) {
      setChatError(cause instanceof Error ? cause.message : 'Hermes could not answer right now.');
    } finally {
      setChatPending(false);
    }
  };

  /** Recording, summary and transcript for a call — the same evidence as before,
      now attached to a timeline event instead of a speech bubble. */
  const renderCallEvidence = (touchpoint: PipelineTouchpoint, detail: SignalDetail | null | undefined) => {
          if (detail === null || detail === undefined) {
            return (
              <div className="fd-sel-evidence lw-call-evidence">
                {touchpoint.transcriptStatus === 'available' && touchpoint.transcriptExcerpt ? (
                  <p className="lw-call-pending">Transcript preview: {touchpoint.transcriptExcerpt}</p>
                ) : (
                  <p className="lw-call-pending">
                    {touchpoint.transcriptStatus === 'pending' ? 'Transcript pending' : 'No transcript recorded'}
                  </p>
                )}
              </div>
            );
          }
          const recordings = detail?.recordings ?? null;
          const summary = detail?.callSummary ?? null;
          const transcript = detail?.transcript ?? null;
          const waiting: string[] = [];
          const missing: string[] = [];
          ([
            ['recording', recordings?.status],
            ['summary', summary?.status],
            ['transcript', transcript?.status],
          ] as const).forEach(([label, status]) => {
            if (status === 'available') return;
            (status === 'unavailable' ? missing : waiting).push(label);
          });
          const showRecordings = recordings !== null && recordings.status === 'available' && recordings.items.length > 0;
          const showSummary = summary !== null && summary.status === 'available'
            && (summary.summary.length > 0 || summary.nextSteps.length > 0);
          const showTranscript = transcript !== null && transcript.status === 'available' && transcript.text !== null;
          const pendingNote = [
            waiting.length > 0 ? `${listPhrase(waiting)} on the way from Quo` : null,
            missing.length > 0 ? `no ${listPhrase(missing)} for this call` : null,
          ].filter(Boolean).join(' · ');
          return (
            <div className="fd-sel-evidence lw-call-evidence">
              {showRecordings && recordings.items.map((recording, index) => (
                <div className="fd-call-recording" key={recording.id ?? `${recording.url}:${index}`}>
                  <span>Recording{recordings.items.length > 1 ? ` ${index + 1}` : ''}{recording.duration === null ? '' : ` · ${callDuration(Math.round(recording.duration))}`}</span>
                  <audio controls preload="none" src={recording.url}>Your browser cannot play this call recording.</audio>
                </div>
              ))}
              {showSummary && (
                <div className="fd-call-summary-content">
                  {summary.summary.length > 0 && <ul>{summary.summary.map((item, index) => <li key={`summary:${index}`}>{item}</li>)}</ul>}
                  {summary.nextSteps.length > 0 && <div><strong>Next steps</strong><ul>{summary.nextSteps.map((item, index) => <li key={`next:${index}`}>{item}</li>)}</ul></div>}
                </div>
              )}
              {showTranscript && (
                <div className="fd-sel-transcript">
                  <details><summary>Read full transcript</summary><pre>{transcript.text}</pre></details>
                </div>
              )}
              {pendingNote && (
                <p className="lw-call-pending">{pendingNote.charAt(0).toUpperCase() + pendingNote.slice(1)}</p>
              )}
            </div>
          );
  };

  /** Day dividers belong between messages, not stamped on every one of them. */
  const renderStream = (touchpoints: PipelineTouchpoint[]) => {
    let lastDay: string | null = null;
    let lastSender: string | null = null;
    return touchpoints.map((touchpoint) => {
      const day = dayKey(touchpoint.occurredAt);
      const newDay = day !== lastDay;
      lastDay = day;
      const sender = touchpoint.kind === 'milestone' || touchpoint.channel === 'call'
        ? null
        : `${touchpoint.direction}`;
      const grouped = !newDay && sender !== null && sender === lastSender;
      lastSender = sender;
      return (
        <Fragment key={touchpoint.id}>
          {newDay && <ConversationDay label={dayLabel(touchpoint.occurredAt)} />}
          {renderTouchpoint(touchpoint, grouped)}
        </Fragment>
      );
    });
  };

  const renderTouchpoint = (touchpoint: PipelineTouchpoint, grouped = false) => {
    const signal = touchpoint.activityId === null ? null : signalById.get(String(touchpoint.activityId));
    const signalId = touchpoint.activityId === null ? null : String(touchpoint.activityId);
    const detail = signalId ? s.signalDetails?.[signalId] : null;
    const review = signal ? statusOf(s, signal) : null;
    const preview = touchpoint.preview.trim();
    const Icon = channelIcon(touchpoint);
    const title = touchpointTitle(touchpoint);
    const duration = touchpoint.channel === 'call' && (touchpoint.durationSeconds ?? 0) > 0
      ? callDuration(touchpoint.durationSeconds as number)
      : null;

    if (touchpoint.kind === 'milestone') {
      return (
        <div className="lw-chat-system-event" key={touchpoint.id}>
          <Milestone aria-hidden="true" />
          <strong>{touchpoint.subject}</strong>
          <span>{fullDate(touchpoint.occurredAt)}</span>
        </div>
      );
    }

    // Ours right, theirs left — the thread is unreadable when both sides stack
    // in one column wearing the same colour.
    // A touchpoint with no recorded direction stays full width rather than
    // claiming a side it cannot prove.
    const side: TurnSide = touchpoint.direction === 'outbound'
      ? 'you'
      : touchpoint.direction === 'inbound' ? 'them' : 'none';

    // A call is something that happened, not something that was said, so it
    // reads as a timeline event rather than another speech bubble.
    if (touchpoint.channel === 'call') {
      return (
        <ConversationEvent
          key={touchpoint.id}
          side={touchpoint.direction === 'outbound' ? 'you' : touchpoint.direction === 'inbound' ? 'them' : 'none'}
          icon={<Icon aria-hidden="true" />}
          title={title}
          detail={duration}
          time={clockTime(touchpoint.occurredAt)}
        >
          {renderCallEvidence(touchpoint, detail)}
        </ConversationEvent>
      );
    }

    const who = touchpoint.direction === 'outbound' ? 'Ottawa Painters' : displayName;

    return (
      <ConversationTurn
        key={touchpoint.id}
        side={side}
        sender={who}
        avatar={<span className="cv-initials">{initials(who)}</span>}
        meta={<>{channelLabel(touchpoint.channel)} · {sourceLabel(touchpoint.source)}</>}
        time={clockTime(touchpoint.occurredAt)}
        automated={touchpoint.isAutomated}
        grouped={grouped}
        subject={touchpoint.channel === 'email' ? touchpoint.subject : null}
        flags={review?.key === 'action' ? <span className="lw-flag lw-flag-action">draft in Actions</span> : null}
        footer={touchpoint.evidenceKind === 'inferred'
          ? <div className="lw-chat-badges"><span>Estimated stage</span></div>
          : null}
      >
        {preview || title}
      </ConversationTurn>
    );
  };

  const renderLifecycleSection = (section: typeof lifecycleSections[number]) => {
    const reached = section.at !== null;
    const current = section.key === currentLifecycleKey;
    return (
      <section
        className={`lw-chat-stage lw-chat-stage-compact lw-stage-card lw-lifecycle-section${reached ? '' : ' is-unreached'}${current ? ' is-current' : ''}`}
        key={section.key}
      >
        <div className="fc-day lw-stage-divider">
          <span className="lw-milestone-dot" aria-hidden="true">
            {reached ? <CheckCircle2 /> : <Circle />}
          </span>
          <span className="lw-milestone-label">
            <strong>{section.label}</strong>
            {section.at === null ? ' · Not reached' : ` · ${fullDate(section.at)}`}
          </span>
        </div>
        {section.touchpoints.length > 0 && (
          <div className="lw-chat-stage-stream cv-thread">{renderStream(section.touchpoints)}</div>
        )}
      </section>
    );
  };

  const renderPriorHistory = () => {
    if (priorTouchpoints.length === 0) return null;
    const firstAt = stageHistory?.priorHistory.earliestAt ?? priorTouchpoints[0].occurredAt;
    const lastAt = stageHistory?.priorHistory.latestAt ?? priorTouchpoints[priorTouchpoints.length - 1].occurredAt;
    const priorTotal = Math.max(stageHistory?.priorHistory.total ?? 0, priorTouchpoints.length);
    const dateSpan = firstAt === lastAt
      ? shortDate(firstAt)
      : `${shortDate(firstAt)} — ${shortDate(lastAt)}`;
    return (
      <section className="lw-chat-stage lw-stage-card lw-prior-history">
        <div className="fc-day lw-stage-divider">
          <span className="lw-milestone-dot" aria-hidden="true"><History /></span>
          <span className="lw-milestone-label">
            <strong>Before this deal</strong>
            {` · ${priorTotal} earlier ${priorTotal === 1 ? 'communication' : 'communications'} · ${dateSpan}`}
          </span>
        </div>
        <div className="lw-chat-stage-stream cv-thread">{renderStream(priorTouchpoints)}</div>
      </section>
    );
  };

  return (
    <div className="fl-scrim" onClick={onClose}>
      <div className="fc lw" role="dialog" aria-modal="true" aria-label={`${displayName} deal workspace`} onClick={(event) => event.stopPropagation()}>
        <header className="fc-head lw-head">
          <div className="lw-contact-avatar" aria-hidden="true">{displayName.trim().charAt(0).toUpperCase()}</div>
          <div className="fc-head-main">
            <span className="lw-head-name">
              <b>{displayName}</b>
              {person && <RoleTag role={person.role} />}
            </span>
            <span className="fc-head-sub">
              <span className="lw-head-stage">{stage.icon} {stage.label}</span>
              {showDealName && <span className="lw-head-deal">{deal.dealName}</span>}
            </span>
          </div>
          <div className="lw-head-side">
            {(deal.email || deal.phone) && (
              <span className="lw-contact">
                {deal.email && <a href={`mailto:${deal.email}`}>{deal.email}</a>}
                {deal.email && deal.phone && <span aria-hidden="true">·</span>}
                {deal.phone && <a href={`tel:${deal.phone}`}>{deal.phone}</a>}
              </span>
            )}
            <span className="lw-chat-titlebar">
              {latestAt ? `Last activity ${fmtAge(latestAt, s.now)}` : 'No activity yet'}
            </span>
          </div>
          <button className="fl-x" onClick={onClose} title="Close (Esc)" aria-label="Close deal workspace">✕</button>
        </header>

        <div className="lw-layout">
          <main className="lw-chat-panel">
            <Conversation className="lw-conversation">
              <ConversationContent className="lw-conversation-content">
                {stageHistoryLoading && !stageHistory && (
                  <div className="lw-chat-loading"><Sparkles aria-hidden="true" />Hermes is assembling the deal journey…</div>
                )}

                {stageHistory && (
                  <div className="lw-timeline">
                    {renderPriorHistory()}
                    {lifecycleSections.map(renderLifecycleSection)}
                  </div>
                )}

                {!stageHistoryLoading && stageHistory && totalTouchpoints === 0 && (
                  <p className="lw-chat-notice">No communication has been recorded for this deal yet.</p>
                )}

                {stageHistory && stageHistory.attribution.unassignedActivityCount > 0 && (
                  <div className="lw-chat-notice">
                    {stageHistory.attribution.unassignedActivityCount} contact activit{stageHistory.attribution.unassignedActivityCount === 1 ? 'y is' : 'ies are'} not shown because Fluid cannot safely choose a deal.
                  </div>
                )}
                {stageHistory?.touchpointsTruncated && (
                  <div className="lw-chat-notice">Showing the latest 1,000 communications; stage totals still include the full history.</div>
                )}
                {stageHistory?.priorHistory.truncated && (
                  <div className="lw-chat-notice">Showing the latest 1,000 communications from before this deal.</div>
                )}

                {chatTurns.map((turn) => (
                  <Message from={turn.role} className={`lw-live-chat-turn is-${turn.role}`} key={turn.id}>
                    <div className="lw-chat-author"><span>{turn.role === 'assistant' ? 'Hermes' : 'You'}</span></div>
                    <MessageContent className={turn.role === 'assistant' ? 'lw-hermes-bubble' : 'lw-live-user-bubble'}>
                      {turn.text}
                    </MessageContent>
                  </Message>
                ))}
                {chatPending && (
                  <Message from="assistant" className="lw-live-chat-turn is-assistant">
                    <div className="lw-chat-author"><span>Hermes</span></div>
                    <MessageContent className="lw-hermes-bubble lw-hermes-thinking"><i /><i /><i /><span className="sr-only">Hermes is thinking</span></MessageContent>
                  </Message>
                )}
              </ConversationContent>
              <ConversationScrollButton className="lw-scroll-button" aria-label="Jump to current stage" />
            </Conversation>

            <footer className="lw-chat-footer">
              {(openActions.length > 0 || openReminders.length > 0) && <div className="lw-next-actions">
                {openActions.map((action) => (
                  <button className="fc-chip fc-chip-primary" key={action.id} onClick={() => onOpenAction(action.id)}>✦ {action.title}</button>
                ))}
                {openReminders.map((reminder) => (
                  <span className="fc-chip" key={reminder.id}>⏰ {reminder.note} · {fmtDue(reminder.dueAt, s.now)}</span>
                ))}
              </div>}
              {chatError && <div className="lw-chat-error" role="alert">{chatError}</div>}
              <form className="lw-chat-composer" onSubmit={askHermes}>
                <textarea
                  aria-label={`Message Hermes about ${displayName}`}
                  placeholder={`Ask Hermes about ${first}…`}
                  rows={1}
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <button type="submit" aria-label="Send message to Hermes" disabled={chatPending || chatInput.trim().length === 0}>
                  <Send aria-hidden="true" />
                </button>
              </form>
            </footer>
          </main>

          <aside className="lw-journey-rail" aria-label="Deal stage journey">
            <div className="lw-journey-rail-head">
              <span>Journey</span>
              <span className="lw-rail-source">{leadSourceMeta(deal.source).label}</span>
            </div>

            <div className="lw-touch-summary">
              <strong>{totalTouchpoints === 1 ? '1 touchpoint' : `${totalTouchpoints} touchpoints`}</strong>
              <span>{contactSpan}</span>
            </div>

            <ol className="lw-journey-tree">
              {lifecycleSections.map((item) => {
                const current = item.key === currentLifecycleKey;
                const reached = item.at !== null;
                const counts = countChannels(item.touchpoints);
                return (
                  <li className={`${reached ? 'is-reached' : 'is-unreached'}${current ? ' is-current' : ''}`} key={item.key}>
                    <div className="lw-tree-node">
                      <span className="lw-tree-dot">
                        {item.key === 'lead-received' ? <CalendarPlus /> : reached ? <CheckCircle2 /> : <Circle />}
                      </span>
                      <span className="lw-tree-copy">
                        <span className="lw-tree-stage-name"><strong>{item.label}</strong>{current && <em>Now</em>}</span>
                        <small>{item.at === null ? 'Not reached' : shortDate(item.at)}</small>
                        {renderChannelChips(counts, 'lw-tree-counts')}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>

            <dl className="lw-deal-meta">
              {deal.amountCents > 0 && <div><dt>Value</dt><dd>{formatDealAmount(deal.amountCents)}</dd></div>}
              <div><dt>Owner</dt><dd>{deal.salesperson ?? 'Unassigned'}</dd></div>
              <div>
                <dt>Created</dt>
                <dd title={createdLabel}>
                  {shortDate(createdAt)}
                  {createdEvidence !== 'exact' && createdEvidence !== 'observed' && <em className="lw-meta-qualifier"> · {evidenceLabel(createdEvidence)}</em>}
                </dd>
              </div>
            </dl>
          </aside>
        </div>
      </div>
    </div>
  );
}
