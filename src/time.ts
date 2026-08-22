export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Ages: "now", "2m ago", "3h ago", "2d ago" — never seconds. */
export function fmtAge(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < MIN) return 'now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  return `${Math.floor(d / DAY)}d ago`;
}

export function fmtClock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtCalendar(t: number): string {
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * Due dates: minute granularity minimum ("in 1m"), same-day as clock time,
 * else calendar date; overdue stated explicitly ("2m overdue").
 */
export function fmtDue(dueAt: number, now: number): string {
  const diff = dueAt - now;
  if (diff < 0) {
    const over = -diff;
    if (over < 90_000) return '1m overdue';
    if (over < HOUR) return `${Math.round(over / MIN)}m overdue`;
    if (over < DAY) return `${Math.round(over / HOUR)}h overdue`;
    return `${Math.round(over / DAY)}d overdue`;
  }
  if (diff < 90_000) return 'in 1m';
  if (diff < HOUR) return `in ${Math.round(diff / MIN)}m`;
  if (sameDay(dueAt, now)) return `today ${fmtClock(dueAt)}`;
  return fmtCalendar(dueAt);
}

export function isOverdue(dueAt: number, now: number): boolean {
  return dueAt < now;
}

/** true when due within the next 30 minutes (or already due). */
export function isDueSoon(dueAt: number, now: number): boolean {
  return dueAt - now < 30 * MIN;
}

export function dayLabel(t: number, now: number): string {
  if (sameDay(t, now)) return 'Today';
  if (sameDay(t, now - DAY)) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
