import { startOfToday } from './time';
import { ActionCard, Person, Reminder, Signal, State } from './types';

export function personById(s: State, id: string): Person | undefined {
  return s.people.find((person) => person.id === id);
}

export function signalById(s: State, id: string | null): Signal | undefined {
  return id === null ? undefined : s.signals.find((signal) => signal.id === id);
}

/** Relationship activity is display context only; canonical urgency comes from stored triage state. */
export function heatOf(s: State, personId: string): number {
  let heat = 0;
  for (const signal of s.signals) {
    if (signal.personId !== personId) continue;
    const ageDays = Math.max(0, s.now - signal.at) / (24 * 60 * 60 * 1000);
    heat += 26 * Math.exp(-ageDays / 5);
  }
  return Math.min(100, Math.round(heat));
}

/** v1 has no execution endpoint. User-created Actions always remain human-owned. */
export function agentFor(_s: State, _action: ActionCard): string | null {
  return null;
}

export function visibleActions(s: State): ActionCard[] {
  return s.actions.filter((action) => action.snoozedUntil <= s.now);
}

export function openReminders(s: State): Reminder[] {
  return s.reminders
    .filter((reminder) => reminder.doneAt === null && reminder.snoozedUntil <= s.now)
    .sort((left, right) => left.dueAt - right.dueAt);
}

export function counters(s: State): { signalsToday: number; openActions: number; remindersDue: number } {
  if (s.boardSummary) return s.boardSummary;
  const today = startOfToday(s.now);
  return {
    signalsToday: s.signals.filter((signal) => signal.at >= today).length,
    openActions: visibleActions(s).length,
    remindersDue: openReminders(s).filter((reminder) => reminder.dueAt <= s.now).length,
  };
}
