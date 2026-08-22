import { buildSeed, CHANNEL_LABEL, randomTemplate, uid } from './data';
import { DAY, MIN, startOfToday } from './time';
import { ActionCard, AutoRule, LogEntry, Person, Reminder, Signal, State } from './types';

export const AUTO_RULES: { id: AutoRule; name: string; desc: string }[] = [
  { id: 'reply', name: 'Reply watchdog', desc: 'Latest inbound signal needs a response → creates a reply / call-back action.' },
  { id: 'reminder', name: 'Reminder scheduler', desc: 'A reminder reaches its date → it becomes an actionable card.' },
  { id: 'stale', name: 'Staleness nudge', desc: 'Suggestions sit untouched while a thread goes quiet → creates a nudge.' },
  { id: 'capture', name: 'Intent capture', desc: 'Future intent spotted in a message → schedules a reminder automatically.' },
];

const AUTO_NAME: Record<AutoRule, string> = {
  reply: 'Reply watchdog',
  reminder: 'Reminder scheduler',
  stale: 'Staleness nudge',
  capture: 'Intent capture',
};

export const SNOOZE_MS = 45_000;
const STALE_MIN = 5 * MIN; // suggestions pending + thread quiet this long -> nudge
const STALE_MAX = 45 * MIN;
const SIGNAL_CAP = 40;
const LOG_CAP = 12;

export type Msg =
  | { type: 'boot'; now: number }
  | { type: 'tick'; now: number }
  | { type: 'togglePause' }
  | { type: 'focus'; personId: string | null }
  | { type: 'completeAction'; id: string }
  | { type: 'snoozeAction'; id: string }
  | { type: 'completeReminder'; id: string }
  | { type: 'snoozeReminder'; id: string }
  | { type: 'acceptTag'; personId: string; tag: string }
  | { type: 'executeNba'; personId: string; nbaId: string }
  | { type: 'toggleAuto'; rule: AutoRule }
  | { type: 'toggleSeq'; seqId: string };

export const initialState: State = {
  booted: false,
  now: 0,
  startedAt: 0,
  paused: false,
  focusId: null,
  people: [],
  signals: [],
  reminders: [],
  actions: [],
  completed: {},
  log: [],
  script: [],
  nextRandomAt: Number.MAX_SAFE_INTEGER,
  autoEnabled: { reply: true, reminder: true, stale: true, capture: true },
  autoRuns: { reply: 0, reminder: 0, stale: 0, capture: 0 },
  autoTrace: [],
  sequences: [],
  seqInstances: [],
};

// ---------- helpers ----------

export function personById(s: State, id: string): Person | undefined {
  return s.people.find((p) => p.id === id);
}

export function signalById(s: State, id: string | null): Signal | undefined {
  return id === null ? undefined : s.signals.find((x) => x.id === id);
}

function firstName(name: string): string {
  return name.split(' ')[0] ?? name;
}

function latestSignal(s: State, personId: string): Signal | undefined {
  for (let i = s.signals.length - 1; i >= 0; i--) {
    const sg = s.signals[i];
    if (sg.personId === personId) return sg;
  }
  return undefined;
}

/** Relationship heat: rises with inbound activity, decays over time. 0–100. */
export function heatOf(s: State, personId: string): number {
  let h = 0;
  for (const sg of s.signals) {
    if (sg.personId !== personId) continue;
    const ageDays = Math.max(0, s.now - sg.at) / DAY;
    h += 26 * Math.exp(-ageDays / 5);
  }
  return Math.min(100, Math.round(h));
}

function addLog(s: State, text: string, personId: string | null): void {
  const entry: LogEntry = { id: uid('log'), at: s.now, personId, text };
  s.log = [entry, ...s.log].slice(0, LOG_CAP);
}

const AUTO_TRACE_CAP = 14;

function recordAuto(s: State, rule: AutoRule, text: string, personId: string | null): void {
  s.autoRuns = { ...s.autoRuns, [rule]: s.autoRuns[rule] + 1 };
  s.autoTrace = [
    { id: uid('auto'), at: s.now, rule, text, personId },
    ...s.autoTrace,
  ].slice(0, AUTO_TRACE_CAP);
}

// ---------- action derivation (the three generators) ----------

function reconcileActions(s: State, quiet = false): ActionCard[] {
  const prev = new Map(s.actions.map((a) => [a.id, a]));
  const open: ActionCard[] = [];
  const created: ActionCard[] = [];
  const keep = (id: string, make: () => ActionCard) => {
    if (id in s.completed) return;
    const existing = prev.get(id);
    if (existing) {
      open.push(existing);
      return;
    }
    const a = make();
    open.push(a);
    created.push(a);
  };

  // 1. Reply-due: latest inbound signal requires a response.
  for (const p of s.people) {
    if (!s.autoEnabled.reply) break;
    const latest = latestSignal(s, p.id);
    if (!latest || !latest.requiresReply) continue;
    keep(`action:${latest.id}`, () => ({
      id: `action:${latest.id}`,
      kind: 'reply',
      personId: p.id,
      sourceSignalId: latest.id,
      reminderId: null,
      title: latest.channel === 'call' ? `Call ${firstName(p.name)} back` : `Reply to ${p.name}`,
      createdAt: s.now,
      snoozedUntil: 0,
    }));
  }

  // 2. Reminder-due: a reminder has reached its date.
  for (const r of s.reminders) {
    if (!s.autoEnabled.reminder) break;
    if (r.doneAt !== null || r.dueAt > s.now) continue;
    keep(`action:rem:${r.id}`, () => ({
      id: `action:rem:${r.id}`,
      kind: 'reminder',
      personId: r.personId,
      sourceSignalId: r.sourceSignalId,
      reminderId: r.id,
      title: r.note,
      createdAt: s.now,
      snoozedUntil: r.snoozedUntil,
    }));
  }

  // 3. Staleness: pending suggestions untouched while the thread went quiet.
  for (const p of s.people) {
    if (!s.autoEnabled.stale) break;
    const latest = latestSignal(s, p.id);
    if (!latest) continue;
    const age = s.now - latest.at;
    const pending = p.suggestedTags.length > 0 || p.nbas.length > 0;
    const hasReplyOpen = open.some((a) => a.personId === p.id && a.kind === 'reply');
    if (!pending || hasReplyOpen || age < STALE_MIN || age > STALE_MAX) continue;
    keep(`action:stale:${p.id}:${latest.id}`, () => ({
      id: `action:stale:${p.id}:${latest.id}`,
      kind: 'nudge',
      personId: p.id,
      sourceSignalId: latest.id,
      reminderId: null,
      title: `Nudge ${firstName(p.name)} — suggestions sitting idle`,
      createdAt: s.now,
      snoozedUntil: 0,
    }));
  }

  if (!quiet) {
    for (const a of created) {
      const rule: AutoRule = a.kind === 'reply' ? 'reply' : a.kind === 'reminder' ? 'reminder' : 'stale';
      const who = a.kind === 'reminder' ? personById(s, a.personId)?.name ?? '' : '';
      recordAuto(s, rule, `${a.title}${who ? ` · ${who}` : ''}`, a.personId);
    }
  }

  // Stable order: newest first; existing cards keep their createdAt so nothing shuffles.
  return open.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** Cap stored signals, but never drop a signal an open action still points at. */
function capSignals(s: State): void {
  if (s.signals.length <= SIGNAL_CAP) return;
  const protectedIds = new Set<string>();
  for (const a of s.actions) if (a.sourceSignalId) protectedIds.add(a.sourceSignalId);
  for (const r of s.reminders) {
    if (r.doneAt === null && r.sourceSignalId) protectedIds.add(r.sourceSignalId);
  }
  const out: Signal[] = [];
  let excess = s.signals.length - SIGNAL_CAP;
  for (const sg of s.signals) {
    if (excess > 0 && !protectedIds.has(sg.id)) {
      excess -= 1;
      continue;
    }
    out.push(sg);
  }
  s.signals = out;
}

function pushSignal(s: State, sig: Signal, reminder?: { note: string; dueInMs: number }): void {
  s.signals = [...s.signals, sig];
  if (reminder && s.autoEnabled.capture) {
    const person = personById(s, sig.personId);
    const rem: Reminder = {
      id: uid('rem'),
      personId: sig.personId,
      note: reminder.note,
      createdAt: s.now,
      dueAt: s.now + reminder.dueInMs,
      sourceSignalId: sig.id,
      sourceLabel: CHANNEL_LABEL[sig.channel],
      doneAt: null,
      snoozedUntil: 0,
      bornLive: true,
    };
    s.reminders = [...s.reminders, rem];
    addLog(s, `Reminder captured from ${CHANNEL_LABEL[sig.channel]} — “${reminder.note}”`, person?.id ?? null);
    recordAuto(s, 'capture', `Scheduled “${reminder.note}” from ${CHANNEL_LABEL[sig.channel]}`, sig.personId);
  }
  // Playbook trigger: a website quote request enrolls the person in lead nurture.
  if (sig.channel === 'form' && /quote/i.test(sig.text)) {
    enroll(s, 'seq_lead', sig);
  }
}

function enroll(s: State, seqId: string, sig: Signal): void {
  const seq = s.sequences.find((q) => q.id === seqId);
  if (!seq || !seq.enabled) return;
  const already = s.seqInstances.some(
    (i) => i.seqId === seqId && i.personId === sig.personId && i.doneAt === null,
  );
  if (already) return;
  const first = seq.steps[0];
  if (!first) return;
  const person = personById(s, sig.personId);
  s.seqInstances = [
    ...s.seqInstances,
    {
      id: uid('seqi'),
      seqId,
      personId: sig.personId,
      startedAt: s.now,
      stepIdx: 0,
      nextAt: s.now + first.day * DAY,
      doneAt: null,
      lastStep: null,
      triggerText: sig.text,
    },
  ];
  addLog(s, `Auto · Enrolled ${person?.name ?? 'client'} in “${seq.name}”`, sig.personId);
}

/** Advance running playbook instances whose next step has come due. */
function runSequences(s: State): void {
  let changed = false;
  const out = s.seqInstances.map((inst) => {
    if (inst.doneAt !== null || s.now < inst.nextAt) return inst;
    const seq = s.sequences.find((q) => q.id === inst.seqId);
    if (!seq || !seq.enabled) return inst;
    const step = seq.steps[inst.stepIdx];
    if (!step) return inst;
    changed = true;
    const person = personById(s, inst.personId);
    addLog(
      s,
      `Auto · ${seq.name} ${inst.stepIdx + 1}/${seq.steps.length}: ${step.label} — ${person?.name ?? ''}`,
      inst.personId,
    );
    const nextIdx = inst.stepIdx + 1;
    const nextStep = seq.steps[nextIdx];
    return {
      ...inst,
      stepIdx: nextIdx,
      lastStep: { label: step.label, at: s.now },
      nextAt: nextStep ? inst.startedAt + nextStep.day * DAY : inst.nextAt,
      doneAt: nextStep ? null : s.now,
    };
  });
  if (changed) s.seqInstances = out;
}

function fireRandom(s: State): void {
  const t = randomTemplate();
  const pool = s.people.filter((p) => {
    if (!t.requiresReply) return true;
    // don't pile a second reply-due action on someone already waiting on us
    return !s.actions.some((a) => a.personId === p.id && a.kind === 'reply');
  });
  const person = pool[Math.floor(Math.random() * pool.length)] ?? s.people[0];
  if (!person) return;
  pushSignal(s, {
    id: uid('sig'),
    personId: person.id,
    channel: t.channel,
    at: s.now,
    text: t.text,
    requiresReply: t.requiresReply,
  });
}

// ---------- reducer ----------

export function reducer(state: State, msg: Msg): State {
  switch (msg.type) {
    case 'boot': {
      if (state.booted) return state;
      const seed = buildSeed(msg.now);
      const s: State = {
        ...initialState,
        booted: true,
        now: msg.now,
        startedAt: msg.now,
        people: seed.people,
        signals: seed.signals,
        reminders: seed.reminders,
        script: seed.script,
        sequences: seed.sequences,
        seqInstances: seed.seqInstances,
        nextRandomAt: msg.now + 52_000,
      };
      s.actions = reconcileActions(s, true);
      return s;
    }

    case 'tick': {
      if (!state.booted) return state;
      const dt = msg.now - state.now;
      const s: State = { ...state, now: msg.now };
      if (s.paused) {
        // hold the story: shift everything unfired into the future by the paused span
        s.script = s.script.map((e) => (e.fired ? e : { ...e, at: e.at + dt }));
        s.nextRandomAt += dt;
      } else {
        const due = s.script.filter((e) => !e.fired && e.at <= s.now);
        if (due.length > 0) {
          s.script = s.script.map((e) =>
            !e.fired && e.at <= s.now ? { ...e, fired: true } : e,
          );
          for (const e of due) {
            pushSignal(s, { ...e.signal, at: s.now }, e.reminder);
          }
        }
        const scriptDone = s.script.every((e) => e.fired);
        if (scriptDone && s.now >= s.nextRandomAt) {
          fireRandom(s);
          s.nextRandomAt = s.now + 7_000 + Math.random() * 8_000;
        }
      }
      runSequences(s);
      s.actions = reconcileActions(s);
      capSignals(s);
      return s;
    }

    case 'togglePause':
      return { ...state, paused: !state.paused };

    case 'focus':
      return { ...state, focusId: msg.personId };

    case 'completeAction': {
      const a = state.actions.find((x) => x.id === msg.id);
      if (!a) return state;
      const s: State = { ...state, completed: { ...state.completed, [msg.id]: state.now } };
      const person = personById(s, a.personId);
      const name = person?.name ?? 'client';
      if (a.kind === 'reminder' && a.reminderId) {
        s.reminders = s.reminders.map((r) =>
          r.id === a.reminderId ? { ...r, doneAt: s.now } : r,
        );
        addLog(s, `Completed reminder — “${a.title}”`, a.personId);
      } else if (a.kind === 'reply') {
        const src = signalById(s, a.sourceSignalId);
        const via = src ? CHANNEL_LABEL[src.channel] : '';
        addLog(s, `${src?.channel === 'call' ? 'Called' : 'Replied to'} ${name}${via ? ` · ${via}` : ''}`, a.personId);
      } else {
        addLog(s, `Nudged ${name} about pending suggestions`, a.personId);
      }
      s.actions = reconcileActions(s);
      return s;
    }

    case 'snoozeAction': {
      const a = state.actions.find((x) => x.id === msg.id);
      if (!a) return state;
      const until = state.now + SNOOZE_MS;
      const s: State = {
        ...state,
        actions: state.actions.map((x) => (x.id === msg.id ? { ...x, snoozedUntil: until } : x)),
      };
      if (a.reminderId) {
        s.reminders = s.reminders.map((r) =>
          r.id === a.reminderId ? { ...r, snoozedUntil: until } : r,
        );
      }
      addLog(s, `Snoozed “${a.title}” for 45s`, a.personId);
      return s;
    }

    case 'completeReminder': {
      const r = state.reminders.find((x) => x.id === msg.id);
      if (!r || r.doneAt !== null) return state;
      const s: State = {
        ...state,
        reminders: state.reminders.map((x) => (x.id === msg.id ? { ...x, doneAt: state.now } : x)),
        completed: { ...state.completed, [`action:rem:${msg.id}`]: state.now },
      };
      addLog(s, `Completed reminder — “${r.note}”`, r.personId);
      s.actions = reconcileActions(s);
      return s;
    }

    case 'snoozeReminder': {
      const r = state.reminders.find((x) => x.id === msg.id);
      if (!r) return state;
      const until = state.now + SNOOZE_MS;
      const s: State = {
        ...state,
        reminders: state.reminders.map((x) =>
          x.id === msg.id ? { ...x, snoozedUntil: until } : x,
        ),
        actions: state.actions.map((a) =>
          a.reminderId === msg.id ? { ...a, snoozedUntil: until } : a,
        ),
      };
      addLog(s, `Snoozed “${r.note}” for 45s`, r.personId);
      return s;
    }

    case 'acceptTag': {
      const p = personById(state, msg.personId);
      if (!p || !p.suggestedTags.includes(msg.tag)) return state;
      const s: State = {
        ...state,
        people: state.people.map((x) =>
          x.id === msg.personId
            ? {
                ...x,
                tags: [...x.tags, msg.tag],
                suggestedTags: x.suggestedTags.filter((t) => t !== msg.tag),
              }
            : x,
        ),
      };
      addLog(s, `Tagged ${p.name} “${msg.tag}”`, p.id);
      s.actions = reconcileActions(s);
      return s;
    }

    case 'executeNba': {
      const p = personById(state, msg.personId);
      const nba = p?.nbas.find((n) => n.id === msg.nbaId);
      if (!p || !nba) return state;
      const s: State = {
        ...state,
        people: state.people.map((x) =>
          x.id === msg.personId ? { ...x, nbas: x.nbas.filter((n) => n.id !== msg.nbaId) } : x,
        ),
      };
      addLog(s, `Done: ${nba.label} — ${p.name}`, p.id);
      s.actions = reconcileActions(s);
      return s;
    }

    case 'toggleAuto': {
      const on = !state.autoEnabled[msg.rule];
      const s: State = {
        ...state,
        autoEnabled: { ...state.autoEnabled, [msg.rule]: on },
      };
      addLog(s, `${on ? 'Enabled' : 'Paused'} automation — ${AUTO_NAME[msg.rule]}`, null);
      s.actions = reconcileActions(s);
      return s;
    }

    case 'toggleSeq': {
      const seq = state.sequences.find((q) => q.id === msg.seqId);
      if (!seq) return state;
      const on = !seq.enabled;
      const s: State = {
        ...state,
        sequences: state.sequences.map((q) => (q.id === msg.seqId ? { ...q, enabled: on } : q)),
      };
      addLog(s, `${on ? 'Resumed' : 'Paused'} playbook — “${seq.name}”`, null);
      return s;
    }
  }
}

// ---------- render-time selectors ----------

export function visibleActions(s: State): ActionCard[] {
  return s.actions.filter((a) => a.snoozedUntil <= s.now);
}

export function openReminders(s: State): Reminder[] {
  return s.reminders
    .filter((r) => r.doneAt === null && r.snoozedUntil <= s.now)
    .sort((a, b) => a.dueAt - b.dueAt);
}

export function counters(s: State): { signalsToday: number; openActions: number; remindersDue: number } {
  const sod = startOfToday(s.now);
  return {
    signalsToday: s.signals.filter((x) => x.at >= sod).length,
    openActions: visibleActions(s).length,
    remindersDue: openReminders(s).filter((r) => r.dueAt <= s.now).length,
  };
}
