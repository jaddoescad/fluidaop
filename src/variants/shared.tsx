import { type ReactNode } from 'react';
import { CHANNEL_LABEL } from '../channels';
import { dayLabel } from '../time';
import { type Channel, type Person, type PersonRole, type Signal, type State } from '../types';
import './shared.css';

export interface Derived {
  focusPerson: Person | undefined;
  streams: Signal[];
}

export function derive(s: State): Derived {
  return {
    focusPerson: s.focusId ? s.people.find((person) => person.id === s.focusId) : undefined,
    streams: s.signals
      .filter((signal) => !s.focusId || signal.personId === s.focusId)
      .slice()
      .reverse(),
  };
}

const ROLE_META: Record<PersonRole, { emoji: string; label: string; hint: string }> = {
  lead: { emoji: '✨', label: 'lead', hint: 'Potential client—not booked yet' },
  client: { emoji: '🤝', label: 'client', hint: 'Active or repeat client' },
  vendor: { emoji: '🛠️', label: 'vendor', hint: 'Someone you hire and pay' },
  applicant: { emoji: '🧑‍🎨', label: 'applicant', hint: 'Job applicant' },
  contractor: { emoji: '🛠️', label: 'contractor', hint: 'Contractor contact' },
  supplier: { emoji: '📦', label: 'supplier', hint: 'Supplier contact' },
  employee: { emoji: '👤', label: 'employee', hint: 'Team member' },
  painter: { emoji: '🎨', label: 'painter', hint: 'Painter contact' },
  other: { emoji: '👤', label: 'contact', hint: 'Contact' },
};

export function RoleTag({ role }: { role: PersonRole }) {
  const meta = ROLE_META[role];
  return <span className={`fl-role role-${role}`} title={meta.hint}>{meta.emoji} {meta.label}</span>;
}

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

export function classifyIntent(signal: Signal): Intent | null {
  const text = signal.text;
  if (/paid|payment (scheduled|sent)|invoice received|sent the deposit/i.test(text)) return 'paid';
  if (/invoice attached|(my|our) invoice|bill attached|final bill/i.test(text)) return 'bill';
  if (/reach out in|in about (three|3) months|down the road|next (spring|year)/i.test(text)) return 'future';
  if (/ready to (start|go|redo)|we're (all )?set|accepted quote|go ahead with|when can you (start|begin)|finally ready/i.test(text)) return 'ready';
  if (/quote request|requesting quote|asked? for a quote|wants? a quote|ballpark|do you handle|asking (about|whether)/i.test(text)) return 'lead';
  if (/before friday|asap|urgent|peeling badly|scuff repair/i.test(text)) return 'urgent';
  if (/loved|loves it|looks perfect|turned out great|thanks|thank you|passed along your number/i.test(text)) return 'love';
  if (/gate code|keys|access|crew|hour later|unlocked|parking/i.test(text)) return 'sched';
  if (signal.requiresReply) return 'ask';
  return null;
}

export function firstNameOf(name: string): string {
  return name.split(' ')[0] ?? name;
}

export function Burst({ emojis }: { emojis: string[] }) {
  return (
    <span className="burst" aria-hidden="true">
      {emojis.map((emoji, index) => (
        <i key={`${emoji}:${index}`} style={{ left: `${12 + index * 20}%`, animationDelay: `${index * 0.13}s` }}>{emoji}</i>
      ))}
    </span>
  );
}

function hueOf(name: string): number {
  let hue = 0;
  for (let index = 0; index < name.length; index += 1) hue = (hue * 31 + name.charCodeAt(index)) % 360;
  return hue;
}

export function Avatar({ name }: { name: string }) {
  const parts = name.split(' ');
  const initials = `${parts[0]?.charAt(0) ?? ''}${parts[1]?.charAt(0) ?? ''}`;
  return <span className="avatar" style={{ background: `hsl(${hueOf(name)} 45% 46%)` }}>{initials}</span>;
}

export function SourceTag({ channel }: { channel: Channel }) {
  return <span className={`src src-${channel}`}><i className="src-dot" />{CHANNEL_LABEL[channel]}</span>;
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

export function PaneHead({
  title,
  count,
  countTitle,
  countTone,
  focusName,
  onClear,
}: {
  title: string;
  count?: number | string;
  /** What the number means, for the tooltip and screen readers. */
  countTitle?: string;
  /** `alert` when the number is a call to look — unread items, say. */
  countTone?: 'alert';
  focusName?: string | null;
  onClear?: () => void;
}) {
  return (
    <header className="pane-head">
      <h2>{title}</h2>
      {count !== undefined && (
        <>
          <span
            className={`pane-count${countTone ? ` is-${countTone}` : ''}`}
            title={countTitle}
            aria-hidden={countTitle ? true : undefined}
          >
            {count}
          </span>
          {/* aria-label is not allowed on a plain span; say it in text instead. */}
          {countTitle && <span className="sr-only">{countTitle}</span>}
        </>
      )}
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

/** Group a newest-first stream into day buckets, preserving API rank. */
export function groupStreamByDay(signals: Signal[], now: number): { label: string; items: Signal[] }[] {
  const groups: { label: string; items: Signal[] }[] = [];
  for (const signal of signals) {
    const label = dayLabel(signal.at, now);
    const previous = groups[groups.length - 1];
    if (previous?.label === label) previous.items.push(signal);
    else groups.push({ label, items: [signal] });
  }
  return groups;
}
