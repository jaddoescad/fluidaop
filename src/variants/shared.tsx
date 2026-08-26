import { ReactNode, useRef, useState } from 'react';
import { CHANNEL_LABEL } from '../channels';
import { counters, heatOf, openReminders, personById, signalById, visibleActions } from '../engine';
import { DAY, dayLabel, fmtAge, fmtClock, fmtDue, isOverdue, startOfToday } from '../time';
import { ActionCard, Channel, Person, PersonRole, Reminder, Signal, State, StepKind } from '../types';
import { Act } from '../board/contract';
import './shared.css';

export interface VProps {
  s: State;
  act: Act;
}

export interface Derived {
  focusPerson: Person | undefined;
  ranked: { p: Person; heat: number }[];
  streams: Signal[];
  actions: ActionCard[];
  reminders: Reminder[];
  waiting: Set<string>;
  c: { signalsToday: number; openActions: number; remindersDue: number };
}

export function derive(s: State): Derived {
  const focusPerson = s.focusId ? personById(s, s.focusId) : undefined;
  const ranked = s.people
    .filter((p) => p.boardVisible !== false)
    .map((p) => ({ p, heat: heatOf(s, p.id) }))
    .sort((a, b) => (a.p.boardOrder ?? Number.MAX_SAFE_INTEGER) - (b.p.boardOrder ?? Number.MAX_SAFE_INTEGER));
  const all = visibleActions(s);
  return {
    focusPerson,
    ranked,
    streams: s.signals
      .filter((x) => !s.focusId || x.personId === s.focusId)
      .slice()
      .reverse(),
    actions: all.filter((a) => !s.focusId || a.personId === s.focusId),
    reminders: openReminders(s).filter((r) => !s.focusId || r.personId === s.focusId),
    waiting: new Set(all.map((a) => a.personId)),
    c: counters(s),
  };
}

export const KIND_LABEL: Record<ActionCard['kind'], string> = {
  reply: 'Reply due',
  reminder: 'Reminder due',
  nudge: 'Gone quiet',
  task: 'Task',
};

// ---------- person role: who they are to the business ----------

export const ROLE_META: Record<PersonRole, { emoji: string; label: string; hint: string }> = {
  lead: { emoji: '✨', label: 'lead', hint: 'Potential client — not booked yet' },
  client: { emoji: '🤝', label: 'client', hint: 'Active or repeat customer' },
  vendor: { emoji: '🛠️', label: 'vendor', hint: 'Someone you hire and pay — subs, suppliers' },
  customer: { emoji: '🤝', label: 'customer', hint: 'Customer Contact' },
  applicant: { emoji: '🧑‍🎨', label: 'applicant', hint: 'Job applicant' },
  contractor: { emoji: '🛠️', label: 'contractor', hint: 'Contractor Contact' },
  supplier: { emoji: '📦', label: 'supplier', hint: 'Supplier Contact' },
  employee: { emoji: '👤', label: 'employee', hint: 'Team member' },
  painter: { emoji: '🎨', label: 'painter', hint: 'Painter Contact' },
  other: { emoji: '👤', label: 'contact', hint: 'Contact' },
};

export function RoleTag({ role }: { role: PersonRole }) {
  const m = ROLE_META[role];
  return (
    <span className={`fl-role role-${role}`} title={m.hint}>
      {m.emoji} {m.label}
    </span>
  );
}

// ---------- signal intent classification ----------

export type Intent = 'paid' | 'bill' | 'ready' | 'future' | 'lead' | 'urgent' | 'love' | 'sched' | 'ask';

export const INTENT_META: Record<Intent, { emoji: string; label: string }> = {
  paid: { emoji: '💸', label: 'Payment made' },
  bill: { emoji: '🧾', label: 'Invoice to pay' },
  ready: { emoji: '💰', label: 'Ready to start' },
  future: { emoji: '⏳', label: 'Future work' },
  lead: { emoji: '✨', label: 'New lead' },
  urgent: { emoji: '🚨', label: 'Time-sensitive' },
  love: { emoji: '💚', label: 'Happy client' },
  sched: { emoji: '📅', label: 'Logistics' },
  ask: { emoji: '❓', label: 'Question' },
};

export function classifyIntent(sig: Signal): Intent | null {
  const t = sig.text;
  if (/paid|payment (scheduled|sent)|invoice received|sent the deposit/i.test(t)) return 'paid';
  if (/invoice attached|(my|our) invoice|bill attached|final bill/i.test(t)) return 'bill';
  if (/reach out in|in about (three|3) months|down the road|next (spring|year)/i.test(t)) return 'future';
  if (/ready to (start|go|redo)|we're (all )?set|accepted quote|go ahead with|when can you (start|begin)|finally ready/i.test(t)) return 'ready';
  if (/quote request|requesting quote|asked? for a quote|wants? a quote|ballpark|do you handle|asking (about|whether)/i.test(t)) return 'lead';
  if (/before friday|asap|urgent|peeling badly|scuff repair/i.test(t)) return 'urgent';
  if (/loved|loves it|looks perfect|turned out great|thanks|thank you|passed along your number/i.test(t)) return 'love';
  if (/gate code|keys|access|crew|hour later|unlocked|parking/i.test(t)) return 'sched';
  if (sig.requiresReply) return 'ask';
  return null;
}

/** Lead temperature from relationship heat. */
export function tempOf(heat: number): { emoji: string; label: string; key: 'hot' | 'warm' | 'cool' | 'cold' } {
  if (heat >= 55) return { emoji: '🔥', label: 'hot lead', key: 'hot' };
  if (heat >= 25) return { emoji: '☀️', label: 'warm', key: 'warm' };
  if (heat >= 10) return { emoji: '😴', label: 'going quiet', key: 'cool' };
  return { emoji: '❄️', label: 'cold', key: 'cold' };
}

/** Money-state badge: most recent 💰/💸 intent in the past week wins. */
export function moneyBadge(s: State, personId: string): { emoji: string; label: string } | null {
  for (let i = s.signals.length - 1; i >= 0; i--) {
    const sig = s.signals[i];
    if (sig.personId !== personId) continue;
    if (s.now - sig.at > 7 * DAY) break;
    const it = classifyIntent(sig);
    if (it === 'paid') return { emoji: '💸', label: 'paid' };
    if (it === 'ready') return { emoji: '💰', label: 'ready to start' };
  }
  return null;
}

export function firstNameOf(name: string): string {
  return name.split(' ')[0] ?? name;
}

/** Floating emoji burst for money/celebration moments. */
export function Burst({ emojis }: { emojis: string[] }) {
  return (
    <span className="burst" aria-hidden>
      {emojis.map((e, i) => (
        <i key={i} style={{ left: `${12 + i * 20}%`, animationDelay: `${i * 0.13}s` }}>
          {e}
        </i>
      ))}
    </span>
  );
}

// ---------- small shared atoms ----------

function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

export function Avatar({ name }: { name: string }) {
  const parts = name.split(' ');
  const initials = `${parts[0]?.charAt(0) ?? ''}${parts[1]?.charAt(0) ?? ''}`;
  return (
    <span className="avatar" style={{ background: `hsl(${hueOf(name)} 45% 46%)` }}>
      {initials}
    </span>
  );
}

export function SourceTag({ channel }: { channel: Channel }) {
  return (
    <span className={`src src-${channel}`}>
      <i className="src-dot" />
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

export function DirectionTag({ direction }: { direction: 'inbound' | 'outbound' }) {
  const received = direction === 'inbound';
  return (
    <span className="src-direction" title={received ? 'Received' : 'Sent'}>
      <span aria-hidden="true">{received ? '↙' : '↗'}</span>
      <span className="src-direction-label">{received ? 'Received' : 'Sent'}</span>
    </span>
  );
}

export function HeatMeter({ value, compact }: { value: number; compact?: boolean }) {
  return (
    <span className={`heat${compact ? ' heat-compact' : ''}`} title={`Relationship heat ${value}`}>
      <span className="heat-bar">
        <span className="heat-fill" style={{ width: `${value}%` }} />
      </span>
      <span className="heat-num">{value}°</span>
    </span>
  );
}

export function DueChip({ dueAt, now }: { dueAt: number; now: number }) {
  return (
    <span className={`due-chip ${isOverdue(dueAt, now) ? 'due-over' : 'due-up'}`}>
      {fmtDue(dueAt, now)}
    </span>
  );
}

export function PaneHead({
  title,
  count,
  focusName,
  onClear,
  extra,
}: {
  title: string;
  count?: number | string;
  focusName?: string | null;
  onClear?: () => void;
  extra?: ReactNode;
}) {
  return (
    <header className="pane-head">
      <h2>{title}</h2>
      {count !== undefined && <span className="pane-count">{count}</span>}
      {extra}
      {focusName && onClear && (
        <button className="focus-pill" onClick={onClear} title="Clear filter">
          {focusName} <span className="focus-x">✕</span>
        </button>
      )}
    </header>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-note">{children}</div>;
}

// ---------- provenance ----------

export function Prov({ s, a }: { s: State; a: ActionCard }) {
  const src = signalById(s, a.sourceSignalId);
  const rem = a.reminderId ? s.reminders.find((r) => r.id === a.reminderId) : undefined;
  if (!src && !rem) return null;
  return (
    <div className="prov">
      <div className="prov-label">
        {src ? (
          <>
            from <SourceTag channel={src.channel} /> · {fmtAge(src.at, s.now)}
            {rem && <span className="prov-note"> → reminder set {fmtAge(rem.createdAt, s.now)}</span>}
          </>
        ) : (
          rem && <>from reminder · {rem.sourceLabel} · set {fmtAge(rem.createdAt, s.now)}</>
        )}
      </div>
      {src && <blockquote className="prov-quote">“{src.text}”</blockquote>}
    </div>
  );
}

export function RemProv({ s, r }: { s: State; r: Reminder }) {
  const src = signalById(s, r.sourceSignalId);
  return (
    <div className="prov">
      <div className="prov-label">
        from {r.sourceLabel} · {fmtAge(r.createdAt, s.now)}
      </div>
      {src && <blockquote className="prov-quote">“{src.text}”</blockquote>}
    </div>
  );
}

// ---------- done / snooze on hover ----------

export function useDepart(): {
  leaving: ReadonlySet<string>;
  depart: (id: string, fn: (id: string) => void) => void;
} {
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef<Record<string, number>>({});
  const depart = (id: string, fn: (id: string) => void) => {
    if (timers.current[id]) return;
    setLeaving((prev) => new Set(prev).add(id));
    timers.current[id] = window.setTimeout(() => {
      delete timers.current[id];
      setLeaving((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      fn(id);
    }, 240);
  };
  return { leaving, depart };
}

export function Ops({ onDone, onSnooze }: { onDone: () => void; onSnooze: () => void }) {
  return (
    <div className="ops">
      <button className="op op-done" onClick={onDone}>
        Done
      </button>
      <button className="op op-snooze" onClick={onSnooze}>
        Snooze 45s
      </button>
    </div>
  );
}

// ---------- automations panel: account-level playbooks ----------

const STEP_TAG: Record<StepKind, string> = {
  email: 'email',
  sms: 'sms',
  call: 'call',
  task: 'task',
};

export function AutomationsPanel({ s, act }: VProps) {
  const running = s.seqInstances
    .filter((i) => i.doneAt === null)
    .sort((a, b) => a.nextAt - b.nextAt);
  const finished = s.seqInstances.filter((i) => i.doneAt !== null);

  return (
    <div className="autos">
      <h4 className="autos-h">Automations</h4>
      {s.sequences.map((seq) => {
        const count = running.filter((i) => i.seqId === seq.id).length;
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
                  <span className={`seq-step-kind step-${st.kind}`}>{STEP_TAG[st.kind]}</span>
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

      <h4 className="autos-h">Running</h4>
      {running.length === 0 && <Empty>Instances appear here when a trigger fires.</Empty>}
      {running.map((inst) => {
        const seq = s.sequences.find((q) => q.id === inst.seqId);
        if (!seq) return null;
        const p = personById(s, inst.personId);
        const next = seq.steps[inst.stepIdx];
        const fresh = s.now - inst.startedAt < 6000;
        const stepFresh = inst.lastStep !== null && s.now - inst.lastStep.at < 6000;
        return (
          <div
            key={inst.id}
            className={`card seqi-card${fresh || stepFresh ? ' fresh' : ''}${seq.enabled ? '' : ' auto-off'}`}
          >
            <div className="auto-top">
              <span className="seqi-person">{p?.name ?? '—'}</span>
              <span className="seqi-prog">
                {inst.stepIdx}/{seq.steps.length}
              </span>
            </div>
            <div className="seqi-seq">{seq.name}</div>
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
            <div className="prov">
              <div className="prov-label">trigger</div>
              <blockquote className="prov-quote">“{inst.triggerText}”</blockquote>
            </div>
          </div>
        );
      })}

      {finished.length > 0 && (
        <>
          <h4 className="autos-h">Finished</h4>
          {finished.map((inst) => {
            const seq = s.sequences.find((q) => q.id === inst.seqId);
            const p = personById(s, inst.personId);
            return (
              <div key={inst.id} className="card seqi-card seqi-done">
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
    </div>
  );
}

// ---------- context panel (shared markup, styled per variant) ----------

/** Group a newest-first stream into day buckets, preserving order. */
export function groupStreamByDay(
  signals: Signal[],
  now: number,
): { label: string; items: Signal[] }[] {
  const groups: { label: string; items: Signal[] }[] = [];
  for (const sig of signals) {
    const label = dayLabel(sig.at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(sig);
    else groups.push({ label, items: [sig] });
  }
  return groups;
}

function groupByDay(signals: Signal[], now: number): { label: string; items: Signal[] }[] {
  const groups: { label: string; items: Signal[] }[] = [];
  for (const sig of signals.slice().sort((a, b) => b.at - a.at)) {
    const label = dayLabel(sig.at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(sig);
    else groups.push({ label, items: [sig] });
  }
  for (const g of groups) g.items.sort((a, b) => a.at - b.at);
  return groups;
}

export function ActivityLog({ s }: { s: State }) {
  return (
    <div className="ctx-section ctx-log">
      <h4>Activity log</h4>
      {s.log.length === 0 && <Empty>Completed work will be logged here.</Empty>}
      {s.log.map((e) => (
        <div key={e.id} className="log-row">
          <span className="log-age">{fmtAge(e.at, s.now)}</span>
          <span className="log-text">{e.text}</span>
        </div>
      ))}
    </div>
  );
}

export function ContextPanel({ s, act }: VProps) {
  const person = s.focusId ? personById(s, s.focusId) : undefined;

  if (!person) {
    return (
      <div className="ctx">
        <div className="ctx-empty">
          <div className="ctx-empty-mark">◐</div>
          <p>Select a person to isolate their signals, actions and reminders — their full history and suggestions appear here.</p>
        </div>
        <ActivityLog s={s} />
      </div>
    );
  }

  const heat = heatOf(s, person.id);
  const personRems = openReminders(s).filter((r) => r.personId === person.id);
  const history = s.signals.filter((x) => x.personId === person.id);
  const sod = startOfToday(s.now);
  const completedToday = s.log.filter((e) => e.personId === person.id && e.at >= sod);

  return (
    <div className="ctx">
      <div className="ctx-section ctx-profile">
        <div className="ctx-profile-row">
          <Avatar name={person.name} />
          <div>
            <h3 className="ctx-name">{person.name}</h3>
            <div className="ctx-kind">
              <RoleTag role={person.role} /> {person.company ? `${person.company} · ` : ''}
              {person.kind}
            </div>
          </div>
        </div>
        <p className="ctx-note">{person.note}</p>
        <HeatMeter value={heat} />
      </div>

      <div className="ctx-section">
        <h4>Tags</h4>
        <div className="chip-row">
          {person.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
          {person.suggestedTags.map((t) => (
            <button key={t} className="tag tag-sug" onClick={() => act.acceptTag(person.id, t)} title="Accept suggested tag">
              + {t}
            </button>
          ))}
          {person.tags.length === 0 && person.suggestedTags.length === 0 && <span className="dim">none yet</span>}
        </div>
      </div>

      <div className="ctx-section">
        <h4>Suggested next</h4>
        {person.nbas.length === 0 && <Empty>All suggestions handled.</Empty>}
        {person.nbas.map((n) => (
          <div key={n.id} className="nba-row">
            <span className="nba-label">{n.label}</span>
            <button className="op op-run" onClick={() => act.runNba(person.id, n.id)}>
              Run
            </button>
          </div>
        ))}
      </div>

      <div className="ctx-section">
        <h4>Reminders</h4>
        {personRems.length === 0 && <Empty>No open reminders.</Empty>}
        {personRems.map((r) => (
          <div key={r.id} className="ctx-rem">
            <DueChip dueAt={r.dueAt} now={s.now} />
            <span className="ctx-rem-note">{r.note}</span>
          </div>
        ))}
      </div>

      <div className="ctx-section">
        <h4>History</h4>
        {groupByDay(history, s.now).map((g) => (
          <div key={g.label} className="hist-day">
            <div className="hist-day-label">{g.label}</div>
            {g.items.map((sig) => (
              <div key={sig.id} className="hist-row">
                <span className="hist-time">{fmtClock(sig.at)}</span>
                <span className={`hist-src src-${sig.channel}`}>{CHANNEL_LABEL[sig.channel]}</span>
                <span className="hist-text">{sig.text}</span>
              </div>
            ))}
          </div>
        ))}
        {history.length === 0 && <Empty>No history yet.</Empty>}
      </div>

      <div className="ctx-section">
        <h4>Completed today</h4>
        {completedToday.length === 0 && <Empty>Nothing completed yet today.</Empty>}
        {completedToday.map((e) => (
          <div key={e.id} className="log-row">
            <span className="log-age">{fmtAge(e.at, s.now)}</span>
            <span className="log-text">{e.text}</span>
          </div>
        ))}
      </div>

      <ActivityLog s={s} />
    </div>
  );
}
