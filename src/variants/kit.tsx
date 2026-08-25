import { ReactNode, useEffect, useRef, useState } from 'react';
import { CHANNEL_LABEL } from '../data';
import { agentFor } from '../engine';
import { HermesStatus } from '../agents/hermes';
import { DAY, dayLabel, fmtAge, fmtClock, fmtDue, MIN } from '../time';
import { ActionCard, AgentRun, Person, Signal, State } from '../types';
import { Act } from '../useFluid';
import {
  Avatar,
  Burst,
  classifyIntent,
  Derived,
  DueChip,
  Empty,
  firstNameOf,
  groupStreamByDay,
  INTENT_META,
  KIND_LABEL,
  PaneHead,
  Prov,
  RemProv,
  RoleTag,
  SourceTag,
} from './shared';

// =======================================================================
// Shared machinery for the board: plays, settled states, thread view,
// and the columns Zen composes.
// =======================================================================

export const SHORT_CHANNEL: Record<Signal['channel'], string> = {
  sms: 'Text',
  email: 'Email',
  call: 'Call',
  form: 'Website',
};

// ---------- plays: what the app suggests for a signal ----------

export type PlaySpec =
  | { key: string; icon: string; kind: 'reminder'; label: string; detail: string; configurable: boolean; note: string; dueInMs: number }
  | { key: string; icon: string; kind: 'action'; label: string; detail: string; configurable: boolean; title: string }
  | { key: string; icon: string; kind: 'automation'; label: string; detail: string; configurable: boolean; seqId: string };

function futureMonths(text: string): number {
  const digit = /(\d+)\s*month/.exec(text);
  if (digit) return parseInt(digit[1] ?? '2', 10);
  if (/three\s*month/i.test(text)) return 3;
  return 2;
}

/** Suggested next steps for a signal, derived from what the message says. */
export function playsFor(sig: Signal, s: State): PlaySpec[] {
  const intent = classifyIntent(sig);
  const first = firstNameOf(s.people.find((x) => x.id === sig.personId)?.name ?? 'them');
  const rem = (key: string, label: string, note: string, dueInMs: number): PlaySpec => ({
    key,
    icon: '⏰',
    kind: 'reminder',
    label,
    detail: `reminder · due ${fmtDue(s.now + dueInMs, s.now)} · nothing to set up`,
    configurable: false,
    note,
    dueInMs,
  });
  const act = (key: string, icon: string, label: string, title: string, detail: string): PlaySpec => ({
    key,
    icon,
    kind: 'action',
    label,
    detail,
    configurable: true,
    title,
  });

  switch (intent) {
    case 'future': {
      const n = futureMonths(sig.text);
      return [
        rem('rem:future', `Reach out in about ${n} months`, `Reach out to ${first} — they said check back in ~${n} months`, n * 30 * DAY),
        act('act:keep-warm', '✉️', 'Reply — “no problem, we’ll circle back”', `Reply to ${first} — keep-warm note`, 'creates an action · the message template can be preconfigured'),
        act('act:crm-not-ready', '📇', 'Update CRM — mark “not ready yet”', `Update CRM — mark ${first} “not ready yet”`, 'creates a task · configure it to run on its own next time'),
      ];
    }
    case 'ready':
      return [
        act('act:confirm-start', '✉️', 'Reply — confirm start date & crew', `Reply to ${first} — confirm start date`, 'creates an action · the confirmation template can be preconfigured'),
        act('act:contract', '📄', 'Prepare contract & deposit invoice', `Prepare contract & deposit invoice — ${first}`, 'creates a task · configure to auto-attach your standard terms'),
        rem('rem:kickoff', 'Pre-start check-in — 2 days', `Pre-start check-in with ${first}`, 2 * DAY),
      ];
    case 'bill':
      return [
        act('act:pay', '💵', 'Pay the invoice', `Pay ${first}’s invoice`, 'creates a task · configure to send it through your accounting app'),
        rem('rem:pay-due', 'Pay before it’s due — 7 days', `Pay ${first}’s invoice before the due date`, 7 * DAY),
        act('act:job-cost', '📇', 'File it under job costs', `File ${first}’s invoice under job costs`, 'creates a task · configure it to file these automatically'),
      ];
    case 'paid':
      return [
        act('act:receipt', '🧾', 'Send receipt + thank-you', `Send ${first} a receipt + thank-you`, 'creates an action · the receipt message can be preconfigured'),
        { key: 'auto:care', icon: '🤖', kind: 'automation', label: 'Enroll in “Post-job care”', detail: 'runs the existing automation for this client', configurable: false, seqId: 'seq_care' },
        rem('rem:week-check', 'Check how it’s going — 1 week', `Check in with ${first} — how is everything holding up`, 7 * DAY),
      ];
    case 'lead':
      return [
        act('act:intro', '✉️', 'Reply — intro + portfolio', `Reply to ${first} — intro + portfolio`, 'creates an action · the intro template can be preconfigured'),
        { key: 'auto:lead', icon: '🤖', kind: 'automation', label: 'Enroll in “New lead nurture”', detail: 'runs the existing automation for this lead', configurable: false, seqId: 'seq_lead' },
        rem('rem:lead-3d', 'Follow up if quiet — 3 days', `Follow up with ${first} on their quote request`, 3 * DAY),
      ];
    case 'urgent':
      return [
        act('act:call-now', '📞', `Call ${first} back right away`, `Call ${first} back — time-sensitive`, 'creates an action at the top of the pile'),
        rem('rem:resolved', 'Confirm it’s resolved — tomorrow', `Confirm ${first}’s issue is resolved`, 1 * DAY),
      ];
    case 'love':
      return [
        act('act:review', '⭐', 'Ask for a review / referral', `Ask ${first} for a review`, 'creates an action · the ask can be preconfigured'),
        act('act:thanks', '💚', 'Send a thank-you note', `Send ${first} a thank-you note`, 'creates an action · the note template can be preconfigured'),
      ];
    case 'sched':
      return [
        act('act:crew', '🛠️', 'Pass details to the crew', `Pass ${first}’s details to the crew`, 'creates a task · configure to notify the crew chat automatically'),
        rem('rem:day-before', 'Re-confirm the day before', `Re-confirm logistics with ${first}`, 1 * DAY),
      ];
    case 'ask':
      return [
        act('act:answer', '✉️', 'Reply — answer the question', `Reply to ${first} — answer their question`, 'creates an action · common answers can be preconfigured'),
        rem('rem:no-resp', 'Follow up if no response — 2 days', `Follow up with ${first} — still no response`, 2 * DAY),
      ];
    default:
      return [
        act('act:log-crm', '📇', 'Log this in the CRM', `Log ${first}’s update in the CRM`, 'creates a task · configure it to file these automatically'),
        rem('rem:touch-base', 'Touch base next week', `Touch base with ${first}`, 7 * DAY),
      ];
  }
}

// ---------- settled state: every signal declares whether it still needs
// you, and if not, exactly HOW it was handled ----------

export type SigStatus = { key: 'open' | 'rem' | 'auto' | 'done' | 'quiet'; icon: string; label: string };

export function statusOf(s: State, sig: Signal): SigStatus {
  if (s.actions.some((a) => a.sourceSignalId === sig.id)) {
    return { key: 'open', icon: '●', label: 'needs you' };
  }
  const rem = s.reminders.find((r) => r.sourceSignalId === sig.id);
  if (rem && rem.doneAt === null) return { key: 'rem', icon: '⏰', label: 'reminder set' };
  if (
    s.seqInstances.some(
      (i) => i.personId === sig.personId && i.triggerText === sig.text && i.doneAt === null,
    )
  ) {
    return { key: 'auto', icon: '🤖', label: 'automation running' };
  }
  const done = s.handled.find((h) => h.a.sourceSignalId === sig.id);
  if (done) {
    const verb =
      done.a.kind === 'reply'
        ? sig.channel === 'call'
          ? 'called back'
          : 'replied'
        : done.a.kind === 'reminder'
          ? 'reminder done'
          : done.a.kind === 'task'
            ? 'task done'
            : 'nudged';
    return { key: 'done', icon: '✓', label: verb };
  }
  if ((rem && rem.doneAt !== null) || Object.keys(s.completed).some((id) => id.includes(sig.id))) {
    return { key: 'done', icon: '✓', label: 'handled' };
  }
  return { key: 'quiet', icon: '·', label: 'no action needed' };
}

/** Urgency lives outside lead temperature — a client with a time-sensitive
 *  issue outranks any warmth scale. */
export function isUrgent(s: State, personId: string): boolean {
  return s.actions.some((a) => {
    if (a.personId !== personId || !a.sourceSignalId) return false;
    const src = s.signals.find((x) => x.id === a.sourceSignalId);
    return src ? classifyIntent(src) === 'urgent' : false;
  });
}

// ---------- one label per person, ranked purely by urgency ----------

export type PersonLabel = { text: string; tone: 'danger' | 'gold' | 'warn' | 'ok' | 'lead' | 'quiet' };

export function urgencyLabel(s: State, d: Derived, p: Person): PersonLabel {
  if (isUrgent(s, p.id)) return { text: '🚨 urgent', tone: 'danger' };
  if (s.reminders.some((r) => r.personId === p.id && r.doneAt === null && r.dueAt <= s.now)) {
    return { text: '⏰ overdue', tone: 'danger' };
  }
  if (d.waiting.has(p.id)) return { text: 'waiting on us', tone: 'warn' };
  return { text: 'all settled', tone: 'quiet' };
}

// ---------- the action catalog: company actions are precreated, not authored ad hoc ----------

export const ACTION_CATALOG: { icon: string; label: string }[] = [
  { icon: '✉️', label: 'Send intro + portfolio' },
  { icon: '📞', label: 'Call back' },
  { icon: '📄', label: 'Prepare estimate / quote' },
  { icon: '📄', label: 'Prepare contract & deposit invoice' },
  { icon: '🗓️', label: 'Schedule a walkthrough' },
  { icon: '🛠️', label: 'Pass details to the crew' },
  { icon: '🎨', label: 'Drop off paint samples' },
  { icon: '🧾', label: 'Send invoice' },
  { icon: '🧾', label: 'Send receipt + thank-you' },
  { icon: '💵', label: 'Pay an invoice / bill' },
  { icon: '📤', label: 'Send W-9' },
  { icon: '⭐', label: 'Ask for a review / referral' },
  { icon: '📇', label: 'Update CRM record' },
];

// ---------- the customer's story: raw messages digested into a lifecycle ----------

export interface StoryBeat {
  icon: string;
  text: string;
  at: number;
  tone: PersonLabel['tone'];
  count: number;
}

const CHAN_PHRASE: Record<Signal['channel'], string> = {
  form: 'the website',
  email: 'email',
  sms: 'text',
  call: 'a phone call',
};

/** The person's history as plain-language milestones, oldest → newest. */
export function personStory(s: State, p: Person): StoryBeat[] {
  const sigs = s.signals.filter((x) => x.personId === p.id);
  const beats: StoryBeat[] = [];
  sigs.forEach((sig, idx) => {
    const intent = classifyIntent(sig);
    let icon = '💬';
    let text = 'Shared an update';
    let tone: PersonLabel['tone'] = 'quiet';
    switch (intent) {
      case 'lead':
        icon = '✨';
        text = 'Asked for a quote — new inquiry';
        tone = 'lead';
        break;
      case 'ready':
        icon = '💰';
        text = 'Gave the go-ahead — ready to start';
        tone = 'gold';
        break;
      case 'paid':
        icon = '💸';
        text = 'Paid — invoice settled';
        tone = 'gold';
        break;
      case 'bill':
        icon = '🧾';
        text = 'Sent an invoice to pay';
        tone = 'warn';
        break;
      case 'love':
        icon = '💚';
        text = 'Happy with the work';
        tone = 'ok';
        break;
      case 'future':
        icon = '⏳';
        text = 'Wants future work — check back later';
        tone = 'lead';
        break;
      case 'urgent':
        icon = '🚨';
        text = 'Raised a time-sensitive issue';
        tone = 'danger';
        break;
      case 'sched':
        icon = '📋';
        text = 'Sorted job logistics';
        tone = 'quiet';
        break;
      case 'ask':
        icon = '❓';
        text = 'Asked a question';
        tone = 'warn';
        break;
      default:
        if (sig.requiresReply) {
          text = 'Checked in — wants to hear back';
          tone = 'warn';
        }
    }
    if (idx === 0) {
      text = `Came in via ${CHAN_PHRASE[sig.channel]} — ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
    }
    const last = beats[beats.length - 1];
    if (last && last.icon === icon && last.text.endsWith(text)) {
      last.count += 1;
      last.at = sig.at;
    } else {
      beats.push({ icon, text, at: sig.at, tone, count: 1 });
    }
  });
  return beats;
}

// ---------- person summary: the whole situation as bullets + numbers ----------

export interface PersonSummary {
  bullets: { icon: string; text: string; tone: PersonLabel['tone'] }[];
  metrics: { label: string; value: string }[];
}

export function personSummary(s: State, _d: Derived, p: Person): PersonSummary {
  const sigs = s.signals.filter((x) => x.personId === p.id);
  const recent = sigs.filter((x) => s.now - x.at < 14 * DAY);
  const intents = recent.map((x) => classifyIntent(x));
  const has = (k: string) => intents.includes(k as ReturnType<typeof classifyIntent>);

  const bullets: PersonSummary['bullets'] = [];
  if (isUrgent(s, p.id)) bullets.push({ icon: '🚨', text: 'Time-sensitive issue waiting on a response', tone: 'danger' });
  if (has('paid')) bullets.push({ icon: '💸', text: 'Payment made or scheduled', tone: 'gold' });
  else if (has('ready')) bullets.push({ icon: '💰', text: 'Ready to start — kickoff not scheduled yet', tone: 'gold' });
  if (has('bill')) bullets.push({ icon: '🧾', text: 'Their invoice is waiting to be paid', tone: 'warn' });
  if (has('love')) bullets.push({ icon: '💚', text: 'Happy with the recent work', tone: 'ok' });
  if (
    s.actions.some((a) => a.personId === p.id && a.kind === 'reply') &&
    recent.some((x) => x.requiresReply && classifyIntent(x) === 'ask')
  ) {
    bullets.push({ icon: '❓', text: 'Question waiting on an answer', tone: 'warn' });
  }
  if (has('future')) bullets.push({ icon: '⏳', text: 'Future work on the horizon', tone: 'lead' });
  const inst = s.seqInstances.find((i) => i.personId === p.id && i.doneAt === null);
  if (inst) {
    const seq = s.sequences.find((q) => q.id === inst.seqId);
    if (seq) bullets.push({ icon: '🤖', text: `In “${seq.name}” — step ${inst.stepIdx + 1}/${seq.steps.length}`, tone: 'ok' });
  }
  const openRems = s.reminders.filter((r) => r.personId === p.id && r.doneAt === null);
  const overdue = openRems.filter((r) => r.dueAt <= s.now).length;
  if (openRems.length > 0) {
    bullets.push({
      icon: '⏰',
      text: `${openRems.length} reminder${openRems.length > 1 ? 's' : ''} open${overdue > 0 ? ` · ${overdue} overdue` : ''}`,
      tone: overdue > 0 ? 'danger' : 'warn',
    });
  }
  if (bullets.length === 0) bullets.push({ icon: '🏁', text: 'All settled — nothing outstanding', tone: 'quiet' });

  const last = sigs[sigs.length - 1];
  const week = sigs.filter((x) => s.now - x.at < 7 * DAY).length;
  const openActs = s.actions.filter((a) => a.personId === p.id && a.snoozedUntil <= s.now).length;
  const handledToday = s.handled.filter((h) => h.a.personId === p.id).length;
  const metrics: PersonSummary['metrics'] = [
    { label: 'last contact', value: last ? fmtAge(last.at, s.now) : '—' },
    { label: 'this week', value: `${week} signal${week === 1 ? '' : 's'}` },
    { label: 'open actions', value: String(openActs) },
    { label: 'handled recently', value: String(handledToday) },
  ];
  return { bullets, metrics };
}

// ---------- play-panel state + rows ----------

export interface PlayState {
  configured: ReadonlySet<string>;
  created: ReadonlySet<string>;
  configure: (key: string) => void;
  markCreated: (key: string) => void;
  resetCreated: () => void;
}

export function usePlayState(): PlayState {
  const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set());
  const [created, setCreated] = useState<ReadonlySet<string>>(new Set());
  return {
    configured,
    created,
    configure: (key) => setConfigured((prev) => new Set(prev).add(key)),
    markCreated: (key) => setCreated((prev) => new Set(prev).add(key)),
    resetCreated: () => setCreated(new Set()),
  };
}

/** The suggested-next-steps rows: click to create, ⚙ to save as a standing play. */
export function PlayRows({ s, act, sig, play }: { s: State; act: Act; sig: Signal; play: PlayState }) {
  const runPlay = (p: PlaySpec) => {
    if (play.created.has(p.key)) return;
    if (p.kind === 'reminder') act.createReminder(sig.id, p.note, p.dueInMs);
    else if (p.kind === 'action') act.createAction(sig.id, p.title);
    else act.enrollSeq(sig.id, p.seqId);
    play.markCreated(p.key);
  };
  return (
    <div className="fl-plays">
      {playsFor(sig, s)
        .slice()
        .sort((a, b) => Number(play.configured.has(b.key)) - Number(play.configured.has(a.key)))
        .map((p) => {
          const isCreated = play.created.has(p.key);
          const isSaved = play.configured.has(p.key);
          const alreadyRunning =
            p.kind === 'automation' &&
            s.seqInstances.some(
              (i) => p.kind === 'automation' && i.seqId === p.seqId && i.personId === sig.personId && i.doneAt === null,
            );
          return (
            <div
              key={p.key}
              role="button"
              tabIndex={0}
              className={`fl-play${isCreated ? ' done' : ''}${alreadyRunning ? ' inert' : ''}`}
              onClick={() => !alreadyRunning && runPlay(p)}
            >
              <span className="fl-play-icon">{p.icon}</span>
              <span className="fl-play-body">
                <span className="fl-play-label">{p.label}</span>
                <span className="fl-play-detail">{p.detail}</span>
              </span>
              <span className="fl-play-side">
                <span className={`fl-kind fl-kind-${p.kind}`}>{p.kind}</span>
                {alreadyRunning ? (
                  <span className="fl-chip fl-chip-running">already running</span>
                ) : isCreated ? (
                  <span className="fl-chip fl-chip-created">✓ created</span>
                ) : isSaved ? (
                  <span className="fl-chip fl-chip-saved">★ saved play</span>
                ) : (
                  <span className="fl-chip fl-chip-sug">suggestion</span>
                )}
                {p.configurable && !isSaved && !isCreated && (
                  <button
                    className="fl-cfg"
                    title="Configure — save as a standing play for messages like this"
                    onClick={(e) => {
                      e.stopPropagation();
                      play.configure(p.key);
                    }}
                  >
                    ⚙
                  </button>
                )}
              </span>
            </div>
          );
        })}
    </div>
  );
}

// ---------- thread view: the person's full history, anchored on one message ----------

export function ThreadView({
  s,
  personId,
  anchorId,
  onAnchor,
}: {
  s: State;
  personId: string;
  anchorId: string | null;
  onAnchor: (sigId: string) => void;
}) {
  // newest first — the most recent message sits on top
  const history = s.signals.filter((x) => x.personId === personId).slice().reverse();

  useEffect(() => {
    if (!anchorId) return;
    const el = document.getElementById(`fk-msg-${anchorId}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [anchorId, personId]);

  const groups: { label: string; items: Signal[] }[] = [];
  for (const sig of history) {
    const label = dayLabel(sig.at, s.now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(sig);
    else groups.push({ label, items: [sig] });
  }

  return (
    <div className="fk-thread">
      {groups.map((g) => (
        <div key={g.label} className="fk-day">
          <div className="fk-day-label">{g.label}</div>
          {g.items.map((sig) => {
            const intent = classifyIntent(sig);
            const meta = intent ? INTENT_META[intent] : null;
            const st = statusOf(s, sig);
            return (
              <button
                key={sig.id}
                id={`fk-msg-${sig.id}`}
                className={`fk-msg${sig.id === anchorId ? ' anchor' : ''}`}
                onClick={() => onAnchor(sig.id)}
              >
                <span className="fk-msg-meta">
                  <span className="fk-msg-time">{fmtClock(sig.at)}</span>
                  <SourceTag channel={sig.channel} />
                  {meta && (
                    <span className={`fl-tag int-${intent}`}>
                      {meta.emoji} {meta.label}
                    </span>
                  )}
                  <span className={`fl-st fl-st-${st.key}`}>
                    {st.icon} {st.label}
                  </span>
                </span>
                <p className="fk-msg-text">{sig.text}</p>
              </button>
            );
          })}
        </div>
      ))}
      {history.length === 0 && <Empty>No history yet.</Empty>}
    </div>
  );
}

// ---------- board columns ----------

export function PeopleCol({
  s,
  act,
  d,
  onPick,
}: {
  s: State;
  act: Act;
  d: Derived;
  onPick?: (p: Person) => void;
}) {
  return (
    <section className="pane fl-people">
      <PaneHead title="People" count={d.ranked.length} />
      {s.focusId && (
        <button className="fl-clear" onClick={() => act.focus(null)}>
          ✕ Show everyone
        </button>
      )}
      <div className="pane-scroll">
        {d.ranked.map(({ p }) => {
          const focused = s.focusId === p.id;
          const first = s.signals.find((x) => x.personId === p.id);
          const origin = first ? SHORT_CHANNEL[first.channel] : p.kind;
          const label = urgencyLabel(s, d, p);
          return (
            <button
              key={p.id}
              className={`fl-person${focused ? ' focused' : ''}${d.waiting.has(p.id) ? ' owed' : ''}`}
              onClick={() => (onPick ? onPick(p) : act.focus(focused ? null : p.id))}
              title={d.waiting.has(p.id) ? 'waiting on us' : undefined}
            >
              <span className="fl-pcol">
                <span className="fl-prow1">
                  <span className="fl-pname">{p.name}</span>
                  <span className="fl-porigin">{origin}</span>
                </span>
                <span className="fl-plabels">
                  <RoleTag role={p.role} />
                  <em className={`fl-plabel tone-${label.tone}`}>{label.text}</em>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** A short SUMMARY of what the signal is about — not the message re-worded. */
export function signalTitle(sig: Signal): string {
  const t = sig.text;
  const intent = classifyIntent(sig);
  const amt = /\$[\d,]+(?:\.\d+)?/.exec(t)?.[0];
  const date = /the (\d{1,2})(?:st|nd|rd|th)?\b/i.exec(t)?.[0];
  const day = /before (friday|monday|tuesday|wednesday|thursday|saturday|sunday)/i.exec(t)?.[1];
  const quoteNo = /quote #(\d+)/i.exec(t)?.[0];
  const months = /((?:three|two|3|2|\d+)\s*months)/i.exec(t)?.[1];

  switch (intent) {
    case 'bill':
      return `Invoice to pay${amt ? ` — ${amt}` : ''}`;
    case 'paid':
      return `Payment received${amt ? ` — ${amt}` : ''}`;
    case 'ready':
      if (quoteNo) return `${quoteNo.charAt(0).toUpperCase()}${quoteNo.slice(1)} accepted`;
      return date ? `Green light — confirms ${date}` : 'Green light to start';
    case 'lead': {
      const about = /cabinet/i.test(t)
        ? 'cabinet work'
        : /exterior/i.test(t)
          ? 'exterior repaint'
          : /interior/i.test(t)
            ? 'interior repaint'
            : /deck/i.test(t)
              ? 'deck staining'
              : /colonial|ranch|story|house|home/i.test(t)
                ? 'a house repaint'
                : null;
      return about ? `New inquiry — ${about}` : 'New inquiry';
    }
    case 'urgent':
      return day ? `Urgent — needed before ${day.charAt(0).toUpperCase()}${day.slice(1)}` : 'Urgent request';
    case 'love':
      return /number|referr|neighbor/i.test(t) ? 'Referred you to someone' : 'Happy with the work';
    case 'sched': {
      if (/gate code/i.test(t)) return 'New gate code shared';
      if (/keys/i.test(t)) return 'Keys ready for the crew';
      if (/hour later|start.*later/i.test(t)) return 'Wants a later start time';
      if (/unlocked/i.test(t)) return 'Gate left open for the crew';
      if (/parking|access/i.test(t)) return 'Site access sorted';
      return 'Job logistics update';
    }
    case 'future':
      return `Future work — check back in ${months ?? 'a few months'}`;
    case 'ask': {
      if (/color code/i.test(t)) return 'Wants the old color code';
      if (/garage/i.test(t)) return 'Wants to add the garage door';
      if (/estimate|quote/i.test(t)) return 'Chasing the estimate';
      if (/do you handle|refinishing/i.test(t)) return 'Asking what you handle';
      if (/warehouse/i.test(t)) return 'Warehouse job question';
      return 'Waiting on your answer';
    }
    default: {
      if (/wrapped|patched|sanded|prep/i.test(t)) return 'Prep work finished';
      if (/confirmed for|both days|day rate/i.test(t)) return 'Sub confirmed for the job';
      if (/po attached|approval form|w-9|signed/i.test(t)) return 'Paperwork received';
      if (/walkthrough notes|satin|trim color|listing|turnover|eggshell/i.test(t)) return 'Job specs shared';
      if (/final walkthrough|accounting/i.test(t)) return 'Job wrap-up note';
      return 'General update';
    }
  }
}

export function SignalsCol({
  s,
  act,
  d,
  onOpen,
  selId,
}: {
  s: State;
  act: Act;
  d: Derived;
  onOpen: (sig: Signal) => void;
  selId?: string | null;
}) {
  const [view, setView] = useState<'all' | 'open'>('all');
  const fname = d.focusPerson?.name ?? null;
  const clear = () => act.focus(null);
  const stById = new Map(d.streams.map((sig) => [sig.id, statusOf(s, sig)]));
  const openSigs = d.streams.filter((sig) => stById.get(sig.id)?.key === 'open');
  const settledSigs = d.streams.filter((sig) => stById.get(sig.id)?.key !== 'open');

  const renderCard = (sig: Signal) => {
    const p = s.people.find((x) => x.id === sig.personId);
    const fresh = s.now - sig.at < 4000;
    const intent = classifyIntent(sig);
    const meta = intent ? INTENT_META[intent] : null;
    const money = intent === 'ready' || intent === 'paid';
    const st = stById.get(sig.id) ?? statusOf(s, sig);
    const settled = st.key !== 'open';
    return (
      <article
        key={sig.id}
        className={`card fl-sig st-${st.key}${settled ? ' settled' : ''}${fresh ? ' fresh' : ''}${intent ? ` int-${intent}` : ''}${selId === sig.id ? ' selected' : ''}`}
        onClick={() => onOpen(sig)}
      >
        {money && fresh && <Burst emojis={['💰', '✨', '🎉']} />}
        <h3 className="fl-act-title">
          {meta?.emoji ?? (sig.channel === 'call' ? '📞' : sig.channel === 'form' ? '🌐' : '💬')} {signalTitle(sig)}
        </h3>
        <p className="card-text">{sig.text}</p>
        <div className="fl-act-person">
          {p?.name ?? '—'}
          {p && <RoleTag role={p.role} />}
        </div>
        <div className="card-sub">
          <SourceTag channel={sig.channel} />
          <span className="card-age">{fmtAge(sig.at, s.now)}</span>
        </div>
      </article>
    );
  };

  return (
    <section className="pane fl-signals">
      <PaneHead
        title="Signals"
        count={d.streams.length}
        focusName={fname}
        onClear={clear}
        extra={
          <span className="fl-viewtoggle">
            <button className={view === 'open' ? 'on' : ''} onClick={() => setView('open')}>
              needs you · {openSigs.length}
            </button>
            <button className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>
              all
            </button>
          </span>
        }
      />
      <div className="pane-scroll">
        {/* unsettled on top — never buried under settled cards */}
        {groupStreamByDay(openSigs, s.now).map((g) => (
          <div key={g.label} className="sday">
            <div className="sday-label">{g.label}</div>
            {g.items.map(renderCard)}
          </div>
        ))}
        {openSigs.length === 0 && (
          <Empty>Nothing needs you right now{fname ? ` from ${fname}` : ''} — all settled. 🏁</Empty>
        )}
        {view === 'all' && settledSigs.length > 0 && (
          <>
            <h4 className="autos-h">Settled</h4>
            {groupStreamByDay(settledSigs, s.now).map((g) => (
              <div key={g.label} className="sday">
                <div className="sday-label">{g.label}</div>
                {g.items.map(renderCard)}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

export function ActionsCol({
  s,
  act,
  d,
  onOpen,
}: {
  s: State;
  act: Act;
  d: Derived;
  onOpen?: (a: ActionCard) => void;
}) {
  const fname = d.focusPerson?.name ?? null;
  // one list, original order — completing a card flips it in place, it never moves
  const rows: { a: ActionCard; doneAt: number | null }[] = [
    ...d.actions.map((a) => ({ a, doneAt: null as number | null })),
    ...s.handled
      .filter((h) => !s.focusId || h.a.personId === s.focusId)
      .map((h) => ({ a: h.a, doneAt: h.at as number | null })),
  ].sort((x, y) => y.a.createdAt - x.a.createdAt || x.a.id.localeCompare(y.a.id));

  return (
    <section className="pane fl-actions">
      <PaneHead title="Actions" count={d.actions.length} focusName={fname} onClear={() => act.focus(null)} />
      <div className="pane-scroll">
        {d.actions.length === 0 && (
          <div className="fl-zero">All clear — nothing waiting on us{fname ? ` for ${fname}` : ''}.</div>
        )}
        {rows.map(({ a, doneAt }) => {
          const p = s.people.find((x) => x.id === a.personId);
          if (doneAt !== null) {
            return (
              <article key={a.id} className="card fl-done-card">
                <div className="card-top">
                  <span className={`kind-chip kind-chip-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                  <span className="fl-doneat">✓ done · {fmtAge(doneAt, s.now)}</span>
                  <button className="fl-undo" title="Undo — put it back" onClick={() => act.undoAction(a.id)}>
                    ↩ undo
                  </button>
                </div>
                <h3 className="fl-done-title">{a.title}</h3>
                <div className="fl-act-person">{p?.name ?? '—'}</div>
              </article>
            );
          }
          const fresh = s.now - a.createdAt < 5000;
          return (
            <article
              key={a.id}
              className={`card fl-act kind-${a.kind}${fresh ? ' fresh' : ''}`}
              onClick={onOpen ? () => onOpen(a) : undefined}
            >
              <div className="card-top">
                <span className={`kind-chip kind-chip-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                <span className="card-age">{fmtAge(a.createdAt, s.now)}</span>
              </div>
              <h3 className="fl-act-title">{a.title}</h3>
              <div className="fl-act-person">
                {p?.name ?? '—'}
                {p && <RoleTag role={p.role} />}
              </div>
              <Prov s={s} a={a} />
              <div className="fl-btns">
                <button
                  className="fl-btn fl-btn-done"
                  onClick={(e) => {
                    e.stopPropagation();
                    act.done(a.id);
                  }}
                >
                  Done ✓
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function RemindersCol({
  s,
  act,
  d,
  R,
}: {
  s: State;
  act: Act;
  d: Derived;
  R: { leaving: ReadonlySet<string>; depart: (id: string, fn: (id: string) => void) => void };
}) {
  const fname = d.focusPerson?.name ?? null;
  const doneRems = s.reminders
    .filter((r) => r.doneAt !== null && (!s.focusId || r.personId === s.focusId))
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    .slice(0, 6);
  return (
    <section className="pane fl-rems">
      <PaneHead title="Reminders" count={d.reminders.length} focusName={fname} onClear={() => act.focus(null)} />
      <div className="pane-scroll">
        {d.reminders.map((r) => {
          const p = s.people.find((x) => x.id === r.personId);
          const due = r.dueAt <= s.now;
          const born = r.bornLive && s.now - r.createdAt < 8000;
          return (
            <article
              key={r.id}
              className={`card rem-card ${due ? 'overdue due' : 'upcoming'}${born ? ' born' : ''}${R.leaving.has(r.id) ? ' leaving' : ''}`}
            >
              {born && <Burst emojis={['✨', '⏳']} />}
              <div className="card-top">
                <DueChip dueAt={r.dueAt} now={s.now} />
                {born && <span className="chip-born">captured</span>}
              </div>
              <h3 className="fl-rem-note">{r.note}</h3>
              <div className="fl-act-person">
                {p?.name ?? '—'}
                {p && <RoleTag role={p.role} />}
              </div>
              <RemProv s={s} r={r} />
              <div className="fl-btns">
                <button className="fl-btn fl-btn-done" onClick={() => R.depart(r.id, act.remDone)}>
                  Done ✓
                </button>
              </div>
            </article>
          );
        })}
        {d.reminders.length === 0 && <Empty>No open reminders{fname ? ` for ${fname}` : ''}.</Empty>}
        {doneRems.length > 0 && (
          <>
            <h4 className="autos-h">Handled</h4>
            {doneRems.map((r) => {
              const p = s.people.find((x) => x.id === r.personId);
              return (
                <article key={r.id} className="card fl-done-card">
                  <div className="card-top">
                    <span className="fl-doneat">✓ done · {r.doneAt !== null ? fmtAge(r.doneAt, s.now) : ''}</span>
                    <button className="fl-undo" title="Undo — put it back" onClick={() => act.undoReminder(r.id)}>
                      ↩ undo
                    </button>
                  </div>
                  <h3 className="fl-done-title">{r.note}</h3>
                  <div className="fl-act-person">{p?.name ?? '—'}</div>
                </article>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}

export function PlaybooksCol({ s, act, onOpen }: { s: State; act: Act; onOpen?: (instId: string) => void }) {
  const [cfg, setCfg] = useState(false);
  const running = s.seqInstances.filter((i) => i.doneAt === null).length;
  return (
    <section className="pane fl-autos">
      <PaneHead
        title="Automations"
        count={cfg ? 'configure' : `${running} running`}
        extra={
          <button
            className={`fl-gear${cfg ? ' on' : ''}`}
            onClick={() => setCfg(!cfg)}
            title={cfg ? 'Back to what’s running' : 'Configure automations'}
          >
            ⚙
          </button>
        }
      />
      <div className="pane-scroll">
        {cfg ? (
          <>
            <div className="fl-cfg-note">
              These run on their own when a trigger matches. Toggle one off to pause it for everyone enrolled.
            </div>
            {s.sequences.map((seq) => {
              const count = s.seqInstances.filter((i) => i.seqId === seq.id && i.doneAt === null).length;
              return (
                <div key={seq.id} className={`card seq-card${seq.enabled ? '' : ' auto-off'}`}>
                  <div className="auto-top">
                    <span className="seq-name">{seq.name}</span>
                    <button
                      className={`auto-toggle${seq.enabled ? ' on' : ''}`}
                      onClick={() => act.toggleSeq(seq.id)}
                      title={seq.enabled ? 'Pause this automation' : 'Resume this automation'}
                    >
                      <i />
                    </button>
                  </div>
                  <p className="auto-desc">when {seq.trigger}</p>
                  <div className="seq-steps">
                    {seq.steps.map((st, i) => (
                      <div key={i} className="seq-step">
                        <span className={`seq-step-kind step-${st.kind}`}>{st.kind}</span>
                        <span className="seq-step-day">{st.day === 0 ? 'right away' : `day ${st.day}`}</span>
                        <span className="seq-step-label">{st.label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="auto-stats">
                    <span>{count} running</span>
                    {!seq.enabled && <span className="auto-paused">paused</span>}
                  </div>
                </div>
              );
            })}
          </>
        ) : (
          <>
            {running === 0 && (
              <Empty>Nothing running right now — automations start when a trigger matches, or from a signal’s play panel.</Empty>
            )}
            {s.seqInstances
              .filter((i) => i.doneAt === null)
              .sort((a, b) => a.nextAt - b.nextAt)
              .map((inst) => {
                const seq = s.sequences.find((q) => q.id === inst.seqId);
                if (!seq) return null;
                const p = s.people.find((x) => x.id === inst.personId);
                const next = seq.steps[inst.stepIdx];
                const fresh = s.now - inst.startedAt < 6000;
                const stepFresh = inst.lastStep !== null && s.now - inst.lastStep.at < 6000;
                return (
                  <div
                    key={inst.id}
                    className={`card seqi-card${fresh || stepFresh ? ' fresh' : ''}${seq.enabled ? '' : ' auto-off'}${onOpen ? ' fs-click' : ''}`}
                    onClick={onOpen ? () => onOpen(inst.id) : undefined}
                    title={onOpen ? 'Open the chat' : undefined}
                  >
                    <div className="auto-top">
                      <span className="seqi-person">{p?.name ?? '—'}</span>
                      <span className="seqi-prog">
                        {inst.stepIdx}/{seq.steps.length}
                      </span>
                    </div>
                    <div className="seqi-seq">
                      {seq.name}
                      {!seq.enabled && <span className="auto-paused"> · paused</span>}
                    </div>
                    <div className="seqi-dots">
                      {seq.steps.map((st, i) => (
                        <i
                          key={i}
                          className={`sdot${i < inst.stepIdx ? ' sdot-done' : i === inst.stepIdx ? ' sdot-next' : ''}`}
                          title={`Day ${st.day} — ${st.label}`}
                        />
                      ))}
                    </div>
                    {next && (
                      <div className="seqi-next">
                        Next: {next.label} · <b>{fmtDue(inst.nextAt, s.now)}</b>
                      </div>
                    )}
                    {inst.lastStep && (
                      <div className="seqi-last">
                        Last: {inst.lastStep.label} · {fmtAge(inst.lastStep.at, s.now)}
                      </div>
                    )}
                  </div>
                );
              })}
            {s.seqInstances.filter((i) => i.doneAt !== null).length > 0 && (
              <>
                <h4 className="autos-h">Finished</h4>
                {s.seqInstances
                  .filter((i) => i.doneAt !== null)
                  .map((inst) => {
                    const seq = s.sequences.find((q) => q.id === inst.seqId);
                    const p = s.people.find((x) => x.id === inst.personId);
                    return (
                      <div
                        key={inst.id}
                        className={`card seqi-card seqi-done${onOpen ? ' fs-click' : ''}`}
                        onClick={onOpen ? () => onOpen(inst.id) : undefined}
                      >
                        <div className="auto-top">
                          <span className="seqi-person">{p?.name ?? '—'}</span>
                          <span className="seqi-endtag">done</span>
                        </div>
                        <div className="seqi-seq">
                          {seq?.name ?? ''} · completed {inst.doneAt !== null ? fmtAge(inst.doneAt, s.now) : ''}
                        </div>
                      </div>
                    );
                  })}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ---------- app chrome: side nav + header bar ----------

// The product is an agent-orchestration platform for small businesses —
// Hermes runs the agents in the back; the human steers from the Board.
const NAV_MAIN: { icon: string; label: string }[] = [
  { icon: '📡', label: 'Board' },
  { icon: '🤖', label: 'Agents' },
  { icon: '🧩', label: 'Skills' },
  { icon: '⚡', label: 'Activity' },
  { icon: '🏷️', label: 'Labels' },
  { icon: '◷', label: 'Schedules' },
  { icon: '🔌', label: 'Connections' },
  { icon: '👥', label: 'Contacts' },
  { icon: '📊', label: 'Insights' },
];

const NAV_FOOT: { icon: string; label: string }[] = [
  { icon: '⚙️', label: 'Settings' },
  { icon: '💬', label: 'Help & feedback' },
];

/** An agent's live status, shown in the side nav roster. */
export interface AgentInfo {
  id: string;
  emoji: string;
  name: string;
  duty: string;
  status: 'online' | 'offline' | 'checking';
  line: string;
}

export function SideNav({
  d,
  roster,
  active = 'Board',
  onNav,
}: {
  d: Derived;
  roster?: AgentInfo[];
  active?: string;
  onNav?: (label: string) => void;
}) {
  const LIVE = ['Board', 'Agents', 'Skills', 'Activity', 'Labels', 'Schedules', 'Connections', 'Contacts'];
  const item = (n: { icon: string; label: string }) => {
    const on = n.label === active;
    const live = onNav !== undefined && LIVE.includes(n.label);
    return (
      <button
        key={n.label}
        className={`fl-nav-item${on ? ' on' : ''}`}
        onClick={live ? () => onNav(n.label) : undefined}
        title={live || on ? undefined : `${n.label} — not part of this concept build yet`}
      >
        <span className="fl-nav-ico">{n.icon}</span>
        {n.label}
        {n.label === 'Board' && d.c.openActions > 0 && <span className="fl-nav-count">{d.c.openActions}</span>}
      </button>
    );
  };
  return (
    <nav className="fl-nav">
      <div className="fl-nav-brand">
        <span className="fl-mark" />
        <div className="fl-nav-names">
          <b className="fl-nav-logo">FLUID</b>
          <span className="fl-nav-co">Meridian Painting Co.</span>
        </div>
      </div>
      {NAV_MAIN.map(item)}
      {roster && (
        <div className="fl-nav-agents">
          <div className="fl-nav-label">Agents</div>
          {roster.map((ag) => (
            <div key={ag.id} className="fl-nav-agent" title={`${ag.name} — ${ag.duty}`}>
              <span className="fl-nav-agent-top">
                <span className="fl-nav-ico">{ag.emoji}</span>
                <b className="fl-nav-agent-name">{ag.name}</b>
                <span className={`fs-dot fs-dot-${ag.status}`} title={ag.status} />
              </span>
              <span className="fl-nav-agent-line">{ag.line}</span>
            </div>
          ))}
        </div>
      )}
      <div className="fl-nav-gap" />
      <div className="fl-nav-foot">{NAV_FOOT.map(item)}</div>
    </nav>
  );
}

export function KitHeader({
  s,
  act,
  d,
  hermesStatus,
  hermesError,
}: {
  s: State;
  act: Act;
  d: Derived;
  hermesStatus: HermesStatus | null;
  hermesError: string | null;
}) {
  const hermesState = hermesError !== null
    ? hermesStatus === null ? 'unavailable' : 'degraded'
    : hermesStatus === null
      ? 'checking'
      : hermesStatus.connected
        ? 'online'
        : hermesStatus.gatewayState === 'running'
          ? 'degraded'
          : 'offline';
  const hermesTitle = hermesError !== null
    ? `Hermes is ${hermesState}: ${hermesError}`
    : hermesStatus === null
      ? 'Checking the Hermes gateway and scheduler'
      : hermesState === 'online'
        ? 'Hermes gateway and scheduler are available'
        : `Hermes gateway is ${hermesStatus.gatewayState}`;

  return (
    <header className="fl-top">
      <label className="fl-search" title="Search — not wired up in this concept build">
        <span className="fl-search-ico">🔍</span>
        <input placeholder="Search people, agents, activity…" />
      </label>
      <span className="fl-hspace" />
      <div className="fl-counters">
        <span className="fl-stat">
          <b>{d.c.signalsToday}</b> <em>signals today</em>
        </span>
        <span className="fl-stat">
          <b>{d.c.openActions}</b> <em>actions open</em>
        </span>
        <span className={`fl-stat${d.c.remindersDue > 0 ? ' hot' : ''}`}>
          <b>{d.c.remindersDue}</b> <em>due now</em>
        </span>
      </div>
      <div className="fl-ctl">
        <span
          className="fl-hermes"
          title={hermesTitle}
        >
          <span className={`sim-dot hermes-dot-${hermesState}`} />
          Hermes · {hermesState}
        </span>
        <button
          className="fl-pause"
          onClick={act.togglePause}
          title="Pause or resume the local board feed; Hermes schedules are not changed"
        >
          {s.paused ? '▶ Resume board' : '⏸ Pause board'}
        </button>
      </div>
      <button
        className="fl-bell"
        title={d.c.remindersDue > 0 ? `${d.c.remindersDue} reminder${d.c.remindersDue > 1 ? 's' : ''} due now` : 'Notifications'}
      >
        🔔
        {d.c.remindersDue > 0 && <i className="fl-bell-dot" />}
      </button>
      <div className="fl-user" title="Sam Ortiz — owner, Meridian Painting Co.">
        <Avatar name="Sam Ortiz" />
        <span className="fl-user-name">Sam</span>
      </div>
    </header>
  );
}

// ---------- the decide popup: dossier + full thread + plays — shared by every view ----------

export type DecideSel = { personId: string; sigId: string | null } | null;

export function DecidePopup({
  s,
  act,
  d,
  sel,
  onSel,
}: {
  s: State;
  act: Act;
  d: Derived;
  sel: DecideSel;
  onSel: (next: DecideSel) => void;
}) {
  const play = usePlayState();
  const [pendingAct, setPendingAct] = useState('');
  const [pendingSeq, setPendingSeq] = useState<string | null>(null);

  // fresh decision state whenever the anchor moves
  useEffect(() => {
    play.resetCreated();
    setPendingAct('');
    setPendingSeq(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.personId, sel?.sigId]);

  const open = (personId: string, sigId: string | null) => onSel({ personId, sigId });
  const close = () => onSel(null);

  // ----- the triage queue: every unsettled signal, in stream order -----
  const needsIds = d.streams.filter((sig) => statusOf(s, sig).key === 'open').map((x) => x.id);

  const goNext = () => {
    if (needsIds.length === 0) {
      close();
      return;
    }
    const cur = sel?.sigId ? needsIds.indexOf(sel.sigId) : -1;
    const nextId =
      cur === -1 ? needsIds.find((id) => id !== sel?.sigId) ?? needsIds[0] : needsIds[(cur + 1) % needsIds.length];
    if (!nextId || nextId === sel?.sigId) return;
    const sig = s.signals.find((x) => x.id === nextId);
    if (sig) open(sig.personId, sig.id);
  };
  const goNextRef = useRef(goNext);
  goNextRef.current = goNext;

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSel(null);
      if (
        (e.key === 'ArrowRight' || e.key === 'j') &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLSelectElement)
      ) {
        goNextRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const person = sel ? s.people.find((x) => x.id === sel.personId) : undefined;
  const anchor = person
    ? (sel?.sigId ? s.signals.find((x) => x.id === sel.sigId) : undefined) ??
      s.signals.filter((x) => x.personId === person.id).slice(-1)[0]
    : undefined;

  if (!person || !anchor) return null;

  const labels = [urgencyLabel(s, d, person)];
  const summary = personSummary(s, d, person);
  // obligations merge open + recently completed so nothing vanishes on Done
  const personActRows: { a: ActionCard; doneAt: number | null }[] = [
    ...d.actions.filter((a) => a.personId === person.id).map((a) => ({ a, doneAt: null as number | null })),
    ...s.handled
      .filter((h) => h.a.personId === person.id)
      .slice(0, 5)
      .map((h) => ({ a: h.a, doneAt: h.at as number | null })),
  ].sort((x, y) => y.a.createdAt - x.a.createdAt || x.a.id.localeCompare(y.a.id));
  const personDoneRems = s.reminders
    .filter((r) => r.doneAt !== null && r.personId === person.id)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    .slice(0, 3);
  const story = personStory(s, person);
  const beatWhen = (at: number) => {
    const dl = dayLabel(at, s.now);
    return dl === 'Today' ? fmtAge(at, s.now) : dl;
  };
  const personActions = d.actions.filter((a) => a.personId === person.id);
  const personRems = d.reminders.filter((r) => r.personId === person.id);
  const anchorSt = statusOf(s, anchor);

  return (
    <div className="fl-scrim" onClick={close}>
      <div className="fl-mega" onClick={(e) => e.stopPropagation()}>
        <header className="fl-mega-head">
          <Avatar name={person.name} />
          <div className="fl-mega-main">
            <div className="fl-mega-row">
              <h2 className="fl-mega-name">{person.name}</h2>
              <RoleTag role={person.role} />
              {labels.map((l) => (
                <em key={l.text} className={`fl-plabel tone-${l.tone}`}>
                  {l.text}
                </em>
              ))}
            </div>
            <div className="fl-mega-kind">
              {person.company ? `${person.company} · ` : ''}
              {person.kind} · {person.note}
            </div>
          </div>
          <div className="fl-mega-side">
            <span className="chip-row">
              {person.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
              {person.suggestedTags.map((t) => (
                <button key={t} className="tag tag-sug" onClick={() => act.acceptTag(person.id, t)}>
                  + {t}
                </button>
              ))}
            </span>
          </div>
          {needsIds.length > 0 && (
            <button className="fl-next" onClick={goNext} title="Jump to the next signal that needs you (→ or j)">
              next needs you · {needsIds.length} →
            </button>
          )}
          <button className="fl-x" onClick={close} title="Close (Esc)">
            ✕
          </button>
        </header>
        <div className="fl-mega-body">
          <section className="fl-mega-thread">
            <h4 className="fk-h">Full history — click any message to decide on it</h4>
            <div className="fl-mega-scroll">
              <ThreadView s={s} personId={person.id} anchorId={anchor.id} onAnchor={(id) => open(person.id, id)} />
            </div>
          </section>
          <aside className="fl-mega-decide">
            <div className="fl-mega-scroll">
              {anchorSt.key !== 'open' && (
                <div className="fl-settled-banner">
                  {needsIds.length > 0 ? (
                    <>
                      <span>✓ This one's settled.</span>
                      <button className="fl-btn fl-btn-done" onClick={goNext}>
                        Next needs you →
                      </button>
                    </>
                  ) : (
                    <span>
                      🏁 <b>All caught up</b> — nothing needs you right now.
                    </span>
                  )}
                </div>
              )}
              <h4 className="fk-h">Suggested next steps</h4>
              <PlayRows s={s} act={act} sig={anchor} play={play} />
              {person.nbas.length > 0 && (
                <div className="fl-plays">
                  {person.nbas.map((n) => (
                    <div
                      key={n.id}
                      role="button"
                      tabIndex={0}
                      className="fl-play"
                      onClick={() => act.runNba(person.id, n.id)}
                    >
                      <span className="fl-play-icon">📌</span>
                      <span className="fl-play-body">
                        <span className="fl-play-label">{n.label}</span>
                        <span className="fl-play-detail">for this client specifically — runs now and logs it</span>
                      </span>
                      <span className="fl-play-side">
                        <span className="fl-kind fl-kind-action">action</span>
                        <span className="fl-chip fl-chip-sug">suggestion</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {(() => {
                const first = firstNameOf(person.name);
                const titleOf = (label: string) => `${label} — ${first}`;
                const actExists = (label: string) =>
                  d.actions.some((a) => a.personId === person.id && a.title === titleOf(label));
                return (
                  <div className="fl-custom">
                    <div className="fl-custom-hint">More actions:</div>
                    <div className="fl-auto-row">
                      <select
                        className="fl-auto-select"
                        value={pendingAct}
                        onChange={(e) => setPendingAct(e.target.value)}
                      >
                        <option value="">Choose an action…</option>
                        {ACTION_CATALOG.map((c) => (
                          <option key={c.label} value={c.label} disabled={actExists(c.label)}>
                            {c.icon} {c.label}
                            {actExists(c.label) ? ' — created ✓' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        className="fl-btn fl-btn-done"
                        disabled={!pendingAct}
                        onClick={() => {
                          if (!pendingAct) return;
                          act.createAction(anchor.id, titleOf(pendingAct));
                          setPendingAct('');
                        }}
                      >
                        Add ✓
                      </button>
                    </div>
                    <div className="fl-custom-autos">
                      <div className="fl-custom-hint">…or enroll {first} in an automation:</div>
                      {(() => {
                        const isRunning = (seqId: string) =>
                          s.seqInstances.some(
                            (i) => i.seqId === seqId && i.personId === person.id && i.doneAt === null,
                          );
                        return (
                          <div className="fl-auto-row">
                            <select
                              className="fl-auto-select"
                              value={pendingSeq ?? ''}
                              onChange={(e) => setPendingSeq(e.target.value || null)}
                            >
                              <option value="">Choose an automation…</option>
                              {s.sequences.map((seq) => (
                                <option key={seq.id} value={seq.id} disabled={isRunning(seq.id)}>
                                  {seq.name}
                                  {isRunning(seq.id) ? ' — running ✓' : seq.enabled ? '' : ' — paused'}
                                </option>
                              ))}
                            </select>
                            <button
                              className="fl-btn fl-btn-done"
                              disabled={!pendingSeq}
                              onClick={() => {
                                if (!pendingSeq) return;
                                act.enrollSeq(anchor.id, pendingSeq);
                                setPendingSeq(null);
                              }}
                            >
                              Enroll ✓
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })()}
              <h4 className="fk-h">Open for {firstNameOf(person.name)}</h4>
              {personActRows.length === 0 && personRems.length === 0 && personDoneRems.length === 0 && (
                <Empty>Nothing open — all settled. 🏁</Empty>
              )}
              {personActRows.map(({ a, doneAt }) =>
                doneAt !== null ? (
                  <div key={a.id} className="fk-oblig done">
                    <span className={`kind-chip kind-chip-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                    <span className="fk-oblig-title">{a.title}</span>
                    <span className="fl-doneat">✓ done · {fmtAge(doneAt, s.now)}</span>
                    <button className="fl-undo" title="Undo — put it back" onClick={() => act.undoAction(a.id)}>
                      ↩
                    </button>
                  </div>
                ) : (
                  <div key={a.id} className="fk-oblig">
                    <span className={`kind-chip kind-chip-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                    <span className="fk-oblig-title">{a.title}</span>
                    {(() => {
                      const run = s.runs[a.id];
                      if (!run) return null;
                      const key = run.status === 'running' ? 'run' : run.status;
                      const label =
                        run.status === 'running'
                          ? `⟳ ${run.agent}`
                          : run.status === 'review'
                            ? `◔ review · ${run.agent}`
                            : run.status === 'fail'
                              ? `✗ failed · ${run.agent}`
                              : `✓ ${run.agent}`;
                      return (
                        <span className={`fs-st fs-st-${key}`} title={run.note || undefined}>
                          {label}
                        </span>
                      );
                    })()}
                    <button
                      className="fl-btn fl-btn-done fk-oblig-btn"
                      title="Mark done"
                      onClick={() => act.done(a.id)}
                    >
                      ✓
                    </button>
                  </div>
                ),
              )}
              {personRems.map((r) => (
                <div key={r.id} className="fk-oblig">
                  <DueChip dueAt={r.dueAt} now={s.now} />
                  <span className="fk-oblig-title">{r.note}</span>
                  <button
                    className="fl-btn fl-btn-done fk-oblig-btn"
                    title="Mark done"
                    onClick={() => act.remDone(r.id)}
                  >
                    ✓
                  </button>
                </div>
              ))}
              {personDoneRems.map((r) => (
                <div key={r.id} className="fk-oblig done">
                  <span className="fk-oblig-title">{r.note}</span>
                  <span className="fl-doneat">✓ done · {r.doneAt !== null ? fmtAge(r.doneAt, s.now) : ''}</span>
                  <button className="fl-undo" title="Undo — put it back" onClick={() => act.undoReminder(r.id)}>
                    ↩
                  </button>
                </div>
              ))}
            </div>
          </aside>
          <aside className="fl-mega-summary">
            <div className="fl-mega-scroll">
              <h4 className="fk-h">The story so far</h4>
              <div className="fk-story">
                {story.map((b, i) => (
                  <div key={`${b.at}-${i}`} className={`fk-beat tone-${b.tone}`}>
                    <span className="fk-beat-node">{b.icon}</span>
                    <div className="fk-beat-body">
                      <span className="fk-beat-text">
                        {b.text}
                        {b.count > 1 ? ` · ×${b.count}` : ''}
                      </span>
                      <span className="fk-beat-when">{beatWhen(b.at)}</span>
                    </div>
                  </div>
                ))}
                {labels[0] && (
                  <div className={`fk-beat fk-beat-now tone-${labels[0].tone}`}>
                    <span className="fk-beat-node">◉</span>
                    <div className="fk-beat-body">
                      <span className="fk-beat-text">
                        <b>Now</b> — {labels[0].text}
                        {personActions[0] ? `: ${personActions[0].title}` : ''}
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <h4 className="fk-h">Numbers</h4>
              {summary.metrics.map((m) => (
                <div key={m.label} className="fk-metric">
                  <span className="fk-metric-label">{m.label}</span>
                  <b className="fk-metric-value">{m.value}</b>
                </div>
              ))}
            </div>
          </aside>
        </div>
        <footer className="fl-mega-foot">
          Click a step to create it now · ⚙ saves it as a standing play, offered whenever a similar message arrives ·
          Esc closes
        </footer>
      </div>
    </div>
  );
}

// ---------- the run inspector: what the agent is doing with an action ----------

export const AGENT_EMOJI: Record<string, string> = {
  Scout: '📡',
  Scribe: '✉️',
  Chaser: '⏰',
  Ledger: '🧾',
  Runner: '🧭',
};

export const AGENT_DUTY: Record<string, string> = {
  Scout: 'Intake & CRM',
  Scribe: 'Replies & drafts',
  Chaser: 'Follow-ups & nudges',
  Ledger: 'Invoices & payments',
  Runner: 'Automation runs',
};

export const AGENT_STEPS: Record<string, string[]> = {
  Scribe: ['Reading the thread', 'Drafting the reply', 'Sending it'],
  Chaser: ['Checking the history', 'Drafting the nudge', 'Sending it'],
  Ledger: ['Pulling the invoice', 'Preparing the payment', 'Executing it'],
  Scout: ['Gathering details', 'Updating the record', 'Filing it'],
};

/** How far a running agent has gotten, derived from elapsed time. */
export function runStepIdx(run: AgentRun, now: number): number {
  const steps = AGENT_STEPS[run.agent] ?? [];
  if (steps.length === 0) return 0;
  if (run.status !== 'running') return steps.length - 1;
  const frac = Math.max(0, Math.min(1, (now - run.startedAt) / (run.resolveAt - run.startedAt)));
  return Math.min(steps.length - 1, Math.floor(frac * steps.length));
}

function hashPick<T>(key: string, arr: T[]): T {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 9973;
  return arr[h % arr.length]!;
}

/** The work product the agent produced — what you're approving or what went out. */
function draftFor(run: AgentRun, a: ActionCard, s: State): { label: string; text: string } | null {
  const p = s.people.find((x) => x.id === a.personId);
  const first = firstNameOf(p?.name ?? 'there');
  const src = a.sourceSignalId ? s.signals.find((x) => x.id === a.sourceSignalId) : undefined;
  switch (run.agent) {
    case 'Scribe':
      return {
        label: run.status === 'ok' ? 'What went out' : 'The draft',
        text: `Hi ${first} — ${hashPick(a.id, [
          'thanks for the note! I’ll have an update for you by tomorrow morning.',
          'got it — I’ll confirm the details and get right back to you today.',
          'appreciate the nudge. It’s at the top of my list — expect word shortly.',
        ])}`,
      };
    case 'Chaser':
      return {
        label: run.status === 'ok' ? 'What went out' : 'The draft',
        text: `Hi ${first} — just checking in on this. Want me to pencil you in for next week?`,
      };
    case 'Ledger': {
      const amt = src ? /\$[\d,]+/.exec(src.text)?.[0] : undefined;
      return {
        label: run.status === 'ok' ? 'What was executed' : 'The prepared payment',
        text: `${amt ?? 'Payment'} to ${p?.name ?? 'payee'} · ACH · memo “${a.title}” — ${
          run.status === 'ok' ? 'executed.' : 'executes on approval.'
        }`,
      };
    }
    case 'Scout':
      return {
        label: run.status === 'ok' ? 'What was filed' : 'The prepared update',
        text: `${p?.name ?? 'Record'}: stage refreshed · last-contact updated · note appended — “${a.title}”.`,
      };
    default:
      return null;
  }
}


// The chat. One clean design for everything that can be talked about:
// an action (the agent working it), a reminder (Chaser holding it — trigger
// it onto Actions or cancel it), an automation (Runner executing it —
// pause, resume, or stop it). Context first, then the conversation.

export type RunSubject = { type: 'action' | 'reminder' | 'auto' | 'signal'; id: string };

export function RunPopup({
  s,
  act,
  subject,
  onClose,
}: {
  s: State;
  act: Act;
  subject: RunSubject;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [notes, setNotes] = useState<{ who: 'you' | 'agent' | 'sys'; text: string }[]>([]);
  const [played, setPlayed] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setNotes([]);
    setText('');
    setPlayed(new Set());
  }, [subject.type, subject.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // resolve the subject
  const a =
    subject.type === 'action'
      ? s.actions.find((x) => x.id === subject.id) ?? s.handled.find((h) => h.a.id === subject.id)?.a
      : undefined;
  const r = subject.type === 'reminder' ? s.reminders.find((x) => x.id === subject.id) : undefined;
  const inst = subject.type === 'auto' ? s.seqInstances.find((i) => i.id === subject.id) : undefined;
  const seq = inst ? s.sequences.find((q) => q.id === inst.seqId) : undefined;
  const sg = subject.type === 'signal' ? s.signals.find((x) => x.id === subject.id) : undefined;
  const personId = a?.personId ?? r?.personId ?? inst?.personId ?? sg?.personId ?? null;

  const doneAt = a ? s.completed[subject.id] ?? null : null;
  const run = a ? s.runs[subject.id] : undefined;
  const ctx = personId ? s.signals.filter((x) => x.personId === personId) : [];

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [subject.id, notes.length, run?.status, doneAt, ctx.length, r?.dueAt, inst?.doneAt]);

  if (
    !personId ||
    (subject.type === 'action' && !a) ||
    (subject.type === 'reminder' && !r) ||
    (subject.type === 'auto' && (!inst || !seq)) ||
    (subject.type === 'signal' && !sg)
  )
    return null;

  const p = s.people.find((x) => x.id === personId);
  const first = firstNameOf(p?.name ?? 'them');

  // identity of the speaking agent
  const agent =
    subject.type === 'reminder'
      ? 'Chaser'
      : subject.type === 'auto'
        ? 'Runner'
        : subject.type === 'signal'
          ? 'Scout'
          : a
            ? run?.agent ?? agentFor(s, a)
            : null;
  const emoji = agent ? AGENT_EMOJI[agent] ?? '🤖' : '🛠️';

  // trigger message in the history
  const trigId =
    subject.type === 'action'
      ? a?.sourceSignalId ?? null
      : subject.type === 'reminder'
        ? r?.sourceSignalId ?? null
        : subject.type === 'signal'
          ? sg?.id ?? null
          : inst
            ? s.signals.find((x) => x.personId === personId && x.text === inst.triggerText)?.id ?? null
            : null;

  // ----- action-only story pieces -----
  const steps = agent && subject.type === 'action' ? AGENT_STEPS[agent] ?? [] : [];
  const stepIdx = run ? runStepIdx(run, s.now) : 0;
  const src = a?.sourceSignalId ? s.signals.find((x) => x.id === a.sourceSignalId) : undefined;
  const chan = src ? CHANNEL_LABEL[src.channel] : null;
  const took = run
    ? Math.max(1, Math.round(((run.status === 'running' ? s.now : run.resolveAt) - run.startedAt) / 1000))
    : 0;
  const draft = a && run && (run.status === 'review' || run.status === 'ok') ? draftFor(run, a, s) : null;
  const usedComposer = notes.some((n) => n.who === 'you');

  const why = a
    ? a.id.includes(':rec:')
      ? `I suggested this follow-up after the last run`
      : a.id.startsWith('action:user:')
        ? `you queued it from the decide panel`
        : a.kind === 'reply'
          ? `${first}’s message needed an answer`
          : a.kind === 'reminder'
            ? `the follow-up came due`
            : a.kind === 'nudge'
              ? `${first} went quiet with things pending`
              : `it was queued as a task`
    : '';

  const doneLine = (at: number) =>
    run
      ? run.agent === 'Ledger'
        ? `Executed the payment at ${fmtClock(at)} ✓ — logged it in Activity.`
        : run.agent === 'Scout'
          ? `Filed it in the CRM at ${fmtClock(at)} ✓ — logged in Activity.`
          : `Sent it at ${fmtClock(at)}${chan ? ` via ${chan}` : ''} ✓ — thread settled, logged in Activity.`
      : '';

  // ----- reminder / automation state -----
  const remDue = r ? r.dueAt <= s.now : false;
  const remActionOpen = r ? s.actions.some((x) => x.id === `action:rem:${r.id}`) : false;
  const nextStep = inst && seq ? seq.steps[inst.stepIdx] : undefined;

  // ----- signal state: what Scout knows + what it suggests -----
  const sgStatus = sg ? statusOf(s, sg) : null;
  const plays = sg && sgStatus?.key === 'open' ? playsFor(sg, s).filter((pl) => !played.has(pl.key)) : [];
  const sgReplyAction = sg ? s.actions.find((x) => x.sourceSignalId === sg.id && x.kind === 'reply') : undefined;
  const sgReplyRun = sgReplyAction ? s.runs[sgReplyAction.id] : undefined;

  const runPlay = (pl: PlaySpec) => {
    if (!sg) return;
    if (pl.kind === 'reminder') act.createReminder(sg.id, pl.note, pl.dueInMs);
    else if (pl.kind === 'action') act.createAction(sg.id, pl.title);
    else act.enrollSeq(sg.id, pl.seqId);
    setPlayed((prev) => new Set(prev).add(pl.key));
    setNotes((n) => [...n, { who: 'you', text: pl.label }, { who: 'agent', text: 'Queued ✓' }]);
  };

  // ----- header title + status -----
  const title = a ? a.title : r ? r.note : sg ? signalTitle(sg) : seq?.name ?? '';
  const status =
    subject.type === 'signal'
      ? sgStatus?.key === 'open'
        ? { key: 'review', word: 'needs a decision' }
        : sgStatus?.key === 'rem'
          ? { key: 'run', word: 'reminder set' }
          : sgStatus?.key === 'auto'
            ? { key: 'run', word: 'automation running' }
            : sgStatus?.key === 'done'
              ? { key: 'ok', word: sgStatus.label }
              : { key: 'queued', word: 'no action needed' }
      : subject.type === 'reminder'
      ? r?.doneAt !== null && r?.doneAt !== undefined
        ? { key: 'ok', word: 'done' }
        : remDue
          ? { key: 'review', word: 'due — on your list' }
          : { key: 'queued', word: `scheduled · ${fmtDue(r?.dueAt ?? 0, s.now)}` }
      : subject.type === 'auto'
        ? inst?.doneAt
          ? { key: 'ok', word: 'finished' }
          : seq && !seq.enabled
            ? { key: 'queued', word: 'paused' }
            : { key: 'run', word: 'running' }
        : doneAt !== null
          ? { key: 'ok', word: 'done' }
          : !run
            ? agent
              ? { key: 'queued', word: 'queued' }
              : null
            : run.status === 'running'
              ? { key: 'run', word: `${run.agent} working` }
              : run.status === 'review'
                ? { key: 'review', word: 'needs your OK' }
                : { key: 'fail', word: 'failed' };

  const pct =
    run && run.status === 'running'
      ? Math.max(5, Math.min(96, Math.round(((s.now - run.startedAt) / (run.resolveAt - run.startedAt)) * 100)))
      : 0;

  // ---- message grouping: one avatar + name per run of the same speaker ----
  let lastSpeaker: 'them' | 'agent' | 'you' | null = null;
  let lastSigMeta: { channel: string; at: number } | null = null;

  const day = (key: string, label: string) => {
    lastSpeaker = null;
    lastSigMeta = null;
    return (
      <div className="fc-day" key={key}>
        <span>{label}</span>
      </div>
    );
  };

  const sys = (key: string, body: ReactNode) => {
    lastSpeaker = null;
    return (
      <div className="fc-sys" key={key}>
        {body}
      </div>
    );
  };

  const agentTurn = (key: string, body: ReactNode) => {
    const cont = lastSpeaker === 'agent';
    lastSpeaker = 'agent';
    return (
      <div className={`fd-turn${cont ? ' fd-cont' : ''}`} key={key}>
        <span className={`fd-avatar${cont ? '' : ' fd-avatar-agent'}`}>{cont ? null : emoji}</span>
        <div className="fd-main">
          {!cont && (
            <div className="fd-name">
              <b className="fd-name-accent">{agent ?? 'Field'}</b>
            </div>
          )}
          <div className="fd-text">{body}</div>
        </div>
      </div>
    );
  };

  const youTurn = (key: string, t: string) => {
    const cont = lastSpeaker === 'you';
    lastSpeaker = 'you';
    return (
      <div className={`fd-turn${cont ? ' fd-cont' : ''}`} key={key}>
        <span className="fd-avatar">{!cont && <Avatar name="Sam Ortiz" />}</span>
        <div className="fd-main">
          {!cont && (
            <div className="fd-name">
              <b>You</b>
            </div>
          )}
          <div className="fd-text">{t}</div>
        </div>
      </div>
    );
  };

  const themTurn = (sig: Signal) => {
    const isTrig = sig.id === trigId;
    const cont =
      lastSpeaker === 'them' &&
      lastSigMeta !== null &&
      lastSigMeta.channel === sig.channel &&
      sig.at - lastSigMeta.at < 5 * MIN &&
      !isTrig;
    lastSpeaker = 'them';
    lastSigMeta = { channel: sig.channel, at: sig.at };
    return (
      <div className={`fd-turn${cont ? ' fd-cont' : ''}`} key={sig.id}>
        <span className="fd-avatar">{!cont && <Avatar name={p?.name ?? '—'} />}</span>
        <div className="fd-main">
          {!cont && (
            <div className="fd-name">
              <b>{p?.name ?? '—'}</b>
              <span className="fd-meta">
                {CHANNEL_LABEL[sig.channel]} · {fmtAge(sig.at, s.now)}
              </span>
              {isTrig && <span className="fd-trig">{subject.type === 'signal' ? 'this one' : 'triggered this'}</span>}
            </div>
          )}
          <div className="fd-text">{sig.text}</div>
        </div>
      </div>
    );
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    if (subject.type !== 'action') {
      setNotes((n) => [...n, { who: 'you', text: t }, { who: 'agent', text: 'Noted — I’ll keep that with it.' }]);
      return;
    }
    if (doneAt !== null) {
      setNotes((n) => [...n, { who: 'you', text: t }, { who: 'agent', text: 'Noted.' }]);
    } else if (run?.status === 'review') {
      setNotes((n) => [
        ...n,
        { who: 'you', text: t },
        { who: 'agent', text: 'Got it — adjusted it with that in mind and sent it ✓' },
      ]);
      act.done(subject.id);
    } else if (run?.status === 'fail') {
      setNotes((n) => [
        ...n,
        { who: 'you', text: t },
        { who: 'agent', text: 'Understood — trying again with that in mind.' },
      ]);
      act.retryRun(subject.id);
    } else if (run?.status === 'running') {
      setNotes((n) => [...n, { who: 'you', text: t }, { who: 'agent', text: 'On it — I’ll factor that in.' }]);
    } else if (agent) {
      setNotes((n) => [...n, { who: 'you', text: t }, { who: 'sys', text: `${agent} will see this when picking it up.` }]);
    } else {
      setNotes((n) => [...n, { who: 'you', text: t }, { who: 'sys', text: 'Noted — kept with the job.' }]);
    }
  };

  return (
    <div className="fl-scrim" onClick={onClose}>
      <div className="fc" onClick={(e) => e.stopPropagation()}>
        <header className="fc-head">
          <div className="fc-head-main">
            <b>{title}</b>
            <span className="fc-head-sub">
              for {p?.name ?? '—'} ({p?.role ?? '—'})
              {status && (
                <>
                  {' · '}
                  <span className={`fc-status fc-status-${status.key}`}>{status.word}</span>
                </>
              )}
            </span>
          </div>
          <button className="fl-x" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="fc-body" ref={scrollRef}>
          {day('d-hist', `History with ${first}`)}
          {ctx.map(themTurn)}
          {day('d-agent', agent ? `${agent} on “${title}”` : 'Your move')}

          {/* ================= signal: Scout triaged it ================= */}
          {subject.type === 'signal' && sg && sgStatus && (
            <>
              {agentTurn(
                'g-in',
                <>
                  This came in {fmtAge(sg.at, s.now)} via {CHANNEL_LABEL[sg.channel]} — reads like{' '}
                  <b>{classifyIntent(sg) ? INTENT_META[classifyIntent(sg)!].label.toLowerCase() : 'a general update'}</b>.
                </>,
              )}
              {sgStatus.key === 'open' && sgReplyRun && (
                agentTurn(
                  'g-scribe',
                  sgReplyRun.status === 'running' ? (
                    <>Scribe’s already drafting the reply — check Actions for it.</>
                  ) : sgReplyRun.status === 'review' ? (
                    <>Scribe drafted a reply — it’s waiting on your OK over in Actions.</>
                  ) : sgReplyRun.status === 'fail' ? (
                    <>Scribe tried the reply but hit a wall — it needs you in Actions.</>
                  ) : (
                    <>The reply’s handled.</>
                  ),
                )
              )}
              {sgStatus.key === 'open' ? (
                plays.length > 0 && agentTurn('g-ask', <>Beyond that, here’s what I’d queue — pick any:</>)
              ) : sgStatus.key === 'rem' ? (
                agentTurn('g-rem', <>Settled — a reminder is set for this one. Chaser has it.</>)
              ) : sgStatus.key === 'auto' ? (
                agentTurn('g-auto', <>Settled — an automation is running on it. Runner has it.</>)
              ) : sgStatus.key === 'done' ? (
                agentTurn('g-done', <>Settled — {sgStatus.label} ✓. Nothing left here.</>)
              ) : (
                agentTurn('g-quiet', <>Just context — no action needed on this one.</>)
              )}
            </>
          )}

          {/* ================= reminder: Chaser holds it ================= */}
          {subject.type === 'reminder' && r && (
            <>
              {agentTurn(
                'r-why',
                <>
                  I’m holding this follow-up — it came from {r.sourceLabel} {fmtAge(r.createdAt, s.now)} and is due{' '}
                  <b>{fmtDue(r.dueAt, s.now)}</b>.
                </>,
              )}
              {r.doneAt !== null ? (
                agentTurn('r-done', <>Done ✓ — closed {fmtAge(r.doneAt, s.now)}.</>)
              ) : remActionOpen ? (
                agentTurn('r-on-list', <>Triggered — it’s on your Actions list now. Handle it there, or cancel it here.</>)
              ) : remDue ? (
                agentTurn('r-due', <>It just came due — triggering it onto your Actions list.</>)
              ) : (
                agentTurn(
                  'r-ask',
                  <>
                    I’ll trigger it when it’s due. Or: <b>trigger it now</b>, tell me it’s <b>already done</b>, or
                    cancel it if it no longer matters.
                  </>,
                )
              )}
            </>
          )}

          {/* ================= automation: Runner executes it ================= */}
          {subject.type === 'auto' && inst && seq && (
            <>
              {agentTurn(
                'i-why',
                <>
                  I enrolled {first} {fmtAge(inst.startedAt, s.now)} — the trigger was “{inst.triggerText}”.
                </>,
              )}
              {inst.lastStep &&
                agentTurn('i-last', <>Last step done: <b>{inst.lastStep.label}</b> · {fmtAge(inst.lastStep.at, s.now)}.</>)}
              {inst.doneAt !== null ? (
                agentTurn('i-done', <>Finished — I retired it {fmtAge(inst.doneAt, s.now)}.</>)
              ) : !seq.enabled ? (
                agentTurn(
                  'i-paused',
                  <>
                    Heads up — the whole “{seq.name}” automation is <b>paused</b>, so nothing will fire until you resume
                    it.
                  </>,
                )
              ) : (
                agentTurn(
                  'i-next',
                  <>
                    We’re at step {inst.stepIdx}/{seq.steps.length}. Next up: <b>{nextStep?.label ?? '—'}</b> ·{' '}
                    {fmtDue(inst.nextAt, s.now)}.
                  </>,
                )
              )}
            </>
          )}

          {/* ================= action: the agent works it ================= */}
          {subject.type === 'action' && a && (
            <>
              {!agent && (
                <>
                  {sys(
                    'you-why',
                    <>
                      This one stays with you — {a.kind === 'reply' ? 'phone calls are yours' : 'field work is yours'}.
                      It came up because {why}.
                    </>,
                  )}
                  {doneAt !== null && youTurn('you-done', 'Done ✓ — handled it.')}
                </>
              )}

              {agent && !run && sys('queued', <>Queued — {agent} picks it up in a moment.</>)}

              {run && agentTurn('why', <>Picked this up {fmtAge(run.startedAt, s.now)} — {why}.</>)}

              {run?.status === 'running' &&
                agentTurn(
                  'working',
                  <>
                    On it — {steps[stepIdx]?.toLowerCase() ?? 'working'}…
                    <div className="fd-prog">
                      <span className="fs-prog">
                        <span className="fs-prog-fill" style={{ width: `${pct}%` }} />
                      </span>
                    </div>
                  </>,
                )}

              {run && draft && (
                agentTurn(
                  'work',
                  <>
                    {doneAt !== null || run.status === 'ok' ? 'Here’s what went out:' : 'Here’s my draft:'}
                    <div className="fd-work">
                      <div className={`fd-work-tag${doneAt !== null || run.status === 'ok' ? ' sent' : ''}`}>
                        {doneAt !== null || run.status === 'ok' ? 'Sent ✓' : 'Draft — sends when you approve'}
                      </div>
                      {draft.text}
                    </div>
                  </>,
                )
              )}

              {run?.status === 'review' &&
                doneAt === null &&
                agentTurn(
                  'hold',
                  <>
                    I’m holding it — <b>{run.note}</b>. Nothing has gone out yet; it sends the moment you say so.
                  </>,
                )}

              {run?.status === 'review' && doneAt !== null && (
                <>
                  {!usedComposer && youTurn('approved', 'Approve & send ✓')}
                  {agentTurn('sent-after', <>{doneLine(doneAt)}</>)}
                </>
              )}

              {run?.status === 'fail' && (
                <>
                  {agentTurn(
                    'fail',
                    <>
                      I tried, but <b>{run.note}</b> — I stopped at “{steps[steps.length - 1]?.toLowerCase() ?? 'the last step'}”.
                      Nothing went out. Tell me to retry, or take it over.
                    </>,
                  )}
                  {doneAt !== null && !usedComposer && youTurn('manual', 'Done ✓ — handled it myself.')}
                </>
              )}

              {run?.status === 'ok' && agentTurn('sent', <>{doneLine(run.resolveAt)} Took me {took}s.</>)}

              {run?.rec &&
                !run.recTaken &&
                agentTurn(
                  'rec',
                  <>
                    One more thing — worth doing next: <b>{run.rec}</b>. Want me to queue it?
                  </>,
                )}
            </>
          )}

          {notes.map((n, i) =>
            n.who === 'you'
              ? youTurn(`note-${i}`, n.text)
              : n.who === 'agent'
                ? agentTurn(`note-${i}`, n.text)
                : sys(`note-${i}`, n.text),
          )}

          <div className="fc-replies">
            {subject.type === 'signal' &&
              plays.map((pl) => (
                <button key={pl.key} className="fc-chip" onClick={() => runPlay(pl)}>
                  {pl.icon} {pl.label}
                </button>
              ))}
            {subject.type === 'reminder' && r && r.doneAt === null && (
              <>
                {!remActionOpen && (
                  <button className="fc-chip fc-chip-primary" onClick={() => act.triggerReminder(r.id)}>
                    ⚡ Trigger now
                  </button>
                )}
                <button className="fc-chip" onClick={() => act.remDone(r.id)}>
                  ✓ {remActionOpen ? 'Mark done' : 'Already done'}
                </button>
                <button className="fc-chip" onClick={() => act.cancelReminder(r.id)}>
                  Cancel it
                </button>
              </>
            )}
            {subject.type === 'reminder' && r && r.doneAt !== null && (
              <button className="fc-chip" onClick={() => act.undoReminder(r.id)}>
                ↩ Undo that
              </button>
            )}

            {subject.type === 'auto' && inst && seq && inst.doneAt === null && (
              <>
                <button className="fc-chip" onClick={() => act.toggleSeq(seq.id)}>
                  {seq.enabled ? `⏸ Pause “${seq.name}”` : `▶ Resume “${seq.name}”`}
                </button>
                <button className="fc-chip" onClick={() => act.stopSeq(inst.id)}>
                  Stop it for {first}
                </button>
              </>
            )}

            {subject.type === 'action' && a && (
              <>
                {run?.rec && !run.recTaken && (
                  <button className="fc-chip" onClick={() => act.takeRec(a.id)}>
                    ↪ Yes — queue it
                  </button>
                )}
                {doneAt !== null ? (
                  <button className="fc-chip" onClick={() => act.undoAction(a.id)}>
                    ↩ Undo that
                  </button>
                ) : run?.status === 'review' ? (
                  <button className="fc-chip fc-chip-primary" onClick={() => act.done(a.id)}>
                    Approve & send
                  </button>
                ) : run?.status === 'fail' ? (
                  <>
                    <button className="fc-chip fc-chip-primary" onClick={() => act.retryRun(a.id)}>
                      Try again
                    </button>
                    <button className="fc-chip" onClick={() => act.done(a.id)}>
                      I’ll handle it
                    </button>
                  </>
                ) : !agent ? (
                  <button className="fc-chip fc-chip-primary" onClick={() => act.done(a.id)}>
                    Mark done
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>

        <footer className="fc-composer">
          <input
            className="fc-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
            placeholder={agent ? `Reply to ${agent}…` : 'Add a note…'}
          />
          <button className="fc-send" onClick={send} disabled={!text.trim()}>
            Send
          </button>
        </footer>
      </div>
    </div>
  );
}
