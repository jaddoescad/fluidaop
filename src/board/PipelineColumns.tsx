import { KeyboardEvent, useEffect, useMemo, useRef } from 'react';
import { fmtAge, fmtDue } from '../time';
import {
  PipelineDeal,
  PipelineStage,
  PipelineStageTouches,
  PipelineSyncHealth,
  PipelineTouchDay,
  Signal,
  State,
} from '../types';
import './pipeline.css';

export const PIPELINE_STAGES: ReadonlyArray<{
  key: PipelineStage;
  icon: string;
  label: string;
  hint: string;
}> = [
  { key: 'cold_lead', icon: '❄️', label: 'Cold Leads', hint: 'New DripJobs deals that still need contact' },
  { key: 'warm_lead', icon: '🔥', label: 'Warm Leads', hint: 'Interested leads being nurtured' },
  { key: 'estimate_requested', icon: '📋', label: 'Estimate Requested', hint: 'An estimate still needs to be arranged' },
  { key: 'exterior_sales', icon: '🏡', label: 'Exterior Sales', hint: 'Exterior opportunities in DripJobs' },
  { key: 'estimate_scheduled', icon: '📅', label: 'Estimate Scheduled', hint: 'The estimate appointment is booked' },
  { key: 'in_draft', icon: '✏️', label: 'In Draft', hint: 'The proposal is being prepared' },
  { key: 'proposal_sent', icon: '📨', label: 'Proposal(s) Sent', hint: 'The customer is deciding on a proposal' },
  { key: 'proposal_on_hold_short', icon: '⏸️', label: 'On Hold · 0–1 mo', hint: 'Proposal on hold for up to one month' },
  { key: 'proposal_on_hold_long', icon: '🗓️', label: 'On Hold · 1–6 mo', hint: 'Proposal on hold for one to six months' },
  { key: 'closed_with_appointment', icon: '✅', label: 'Closed · With Appt.', hint: 'Converted deals with a recorded estimate appointment' },
  { key: 'closed_without_appointment', icon: '⚡', label: 'Closed · No Appt.', hint: 'Converted deals without a recorded estimate appointment' },
];

const UNMAPPED_STAGE = {
  key: 'unmapped' as const,
  icon: '⚠️',
  label: 'Needs Mapping',
  hint: 'Deals using a DripJobs stage Fluid does not recognize yet',
};

const STAGE_BY_DRIPJOBS_NAME = new Map<string, PipelineStage>([
  ['cold leads', 'cold_lead'],
  ['warm leads', 'warm_lead'],
  ['estimate requested', 'estimate_requested'],
  ['exterior sales', 'exterior_sales'],
  ['estimate scheduled', 'estimate_scheduled'],
  ['in draft', 'in_draft'],
  ['proposal(s) sent', 'proposal_sent'],
  ['proposal on hold (0-1 month)', 'proposal_on_hold_short'],
  ['proposal on hold (1-6months)', 'proposal_on_hold_long'],
]);

const money = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  maximumFractionDigits: 2,
});
const GENERIC_DEAL_NAME = /^(?:scheduled\s+)?(?:ad\s+)?lead$/i;

export function formatDealAmount(cents: number): string {
  return money.format(cents / 100);
}

type LeadSourceTone = 'meta' | 'website' | 'phone' | 'referral' | 'other';

export function leadSourceMeta(source: string | null): { label: string; tone: LeadSourceTone } {
  const value = source?.trim() ?? '';
  const normalized = value.toLowerCase();
  if (normalized.startsWith('meta')) {
    const detail = value.split('-').slice(1).join('-').trim();
    return { label: detail ? `Meta · ${detail}` : 'Meta Ads', tone: 'meta' };
  }
  if (normalized === '/contact') return { label: 'Website form', tone: 'website' };
  if (normalized === '/privacy-policy') return { label: 'Website', tone: 'website' };
  if (normalized.includes('phone')) return { label: 'Phone call', tone: 'phone' };
  if (normalized.includes('word of mouth') || normalized.includes('referral')) {
    return { label: 'Referral', tone: 'referral' };
  }
  return { label: value || 'Unknown source', tone: 'other' };
}

function meaningfulDealName(deal: PipelineDeal): string | null {
  const name = deal.dealName.trim();
  if (!name || name.localeCompare(deal.customerName.trim(), undefined, { sensitivity: 'accent' }) === 0) {
    return null;
  }
  if (GENERIC_DEAL_NAME.test(name)) return null;
  return name;
}

export const ALL_MONTHS = 'all';

/** `YYYY-MM` in local time, so a lead received in March never lands in February. */
export function receivedMonthKey(deal: PipelineDeal): string | null {
  const at = deal.receivedAt;
  if (at === null || !Number.isFinite(at)) return null;
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
}

/** Newest month first — recent cohorts are the ones people chase. */
export function receivedMonthOptions(
  deals: readonly PipelineDeal[],
  archivedMonthCounts: Readonly<Record<string, number>> = {},
): { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>(
    Object.entries(archivedMonthCounts).filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
  );
  for (const deal of deals) {
    // Archived month totals come from the database so options include every
    // archived page. Counting loaded archived cards here would double-count.
    if (deal.archived) continue;
    const key = receivedMonthKey(deal);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([key, count]) => ({ key, label: monthLabel(key), count }));
}

export function PipelineFilterBar({
  now,
  capturedAt,
  sync,
  loading,
  deals,
  archivedMonthCounts,
  month,
  onMonthChange,
  matchCount,
}: {
  now: number;
  capturedAt: number | null;
  sync: PipelineSyncHealth | null;
  loading: boolean;
  deals: readonly PipelineDeal[];
  archivedMonthCounts: Readonly<Record<string, number>>;
  month: string;
  onMonthChange: (month: string) => void;
  matchCount: number;
}) {
  const options = useMemo(
    () => receivedMonthOptions(deals, archivedMonthCounts),
    [deals, archivedMonthCounts],
  );
  const updatedAt = sync?.lastSucceededAt ?? capturedAt;
  const syncText = loading
    ? 'Refreshing…'
    : updatedAt
      ? `Synced ${fmtAge(updatedAt, now)}`
      : 'Never synced';
  const filtered = month !== ALL_MONTHS;
  const selectedCount = options.find((option) => option.key === month)?.count ?? matchCount;
  const undated = deals.filter((deal) => receivedMonthKey(deal) === null).length;

  return (
    <div className="pipeline-filter-bar">
      <label className="pipeline-filter">
        <span>Lead received</span>
        <select
          value={month}
          onChange={(event) => onMonthChange(event.target.value)}
          disabled={options.length === 0}
        >
          <option value={ALL_MONTHS}>Any month</option>
          {options.map((option) => (
            <option value={option.key} key={option.key}>{option.label} ({option.count})</option>
          ))}
        </select>
      </label>

      {filtered && (
        <>
          <span className="pipeline-filter-count">
            {selectedCount === 1 ? '1 deal' : `${selectedCount.toLocaleString()} deals`}
          </span>
          <button type="button" className="pipeline-filter-clear" onClick={() => onMonthChange(ALL_MONTHS)}>
            Clear
          </button>
        </>
      )}

      {/* Before the receivedAt migration ships every deal is undated; that is a
          missing field, not a data-quality warning, so stay quiet about it. */}
      {undated > 0 && options.length > 0 && (
        <span className="pipeline-filter-note" title="These deals have no received date and are hidden while a month is selected">
          {undated.toLocaleString()} undated
        </span>
      )}

      <span className={`pipeline-filter-sync is-${sync?.status ?? 'missing'}`} role="status">
        <span aria-hidden="true" />
        {syncText}
      </span>
    </div>
  );
}

function stageOf(deal: PipelineDeal): PipelineStage | null {
  return STAGE_BY_DRIPJOBS_NAME.get(deal.stage.trim().toLowerCase()) ?? 'unmapped';
}

export function stageMetaOf(deal: PipelineDeal): { icon: string; label: string } {
  const key = stageOf(deal) ?? 'unmapped';
  if (key === 'unmapped') return { icon: UNMAPPED_STAGE.icon, label: deal.stage.trim() || UNMAPPED_STAGE.label };
  const meta = PIPELINE_STAGES.find((stage) => stage.key === key);
  return meta ?? UNMAPPED_STAGE;
}

function latestSignals(signals: readonly Signal[]): Map<string, Signal> {
  const byPerson = new Map<string, Signal>();
  for (const signal of signals) {
    const current = byPerson.get(signal.personId);
    if (!current || signal.at > current.at) byPerson.set(signal.personId, signal);
  }
  return byPerson;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Silence is the alarm, not age on its own. An unanswered customer reply is the
 * worst state a card can be in, so it goes red a day after they wrote.
 */
function touchHeat(at: number, now: number, direction: 'inbound' | 'outbound' | null): 'cool' | 'warm' | 'hot' {
  const days = Math.max(0, now - at) / DAY;
  if (direction === 'inbound' && days >= 1) return 'hot';
  if (days < 3) return 'cool';
  if (days < 7) return 'warm';
  return 'hot';
}

/** How long ago the real phase boundary happened, when there is no touch yet. */
function phaseDwell(label: string, at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < HOUR) return `${label} just now`;
  if (d < DAY) return `${label} ${Math.floor(d / HOUR)}h ago`;
  return `${label} ${Math.floor(d / DAY)}d ago`;
}

function touchSummary(touches: PipelineStageTouches, now: number): string {
  const parts = [
    touches.outbound === 1 ? '1 touch point from us' : `${touches.outbound} touch points from us`,
    `since ${touches.phaseLabel.toLowerCase()}`,
  ];
  if (touches.inbound > 0) {
    parts.push(`· ${touches.inbound === 1 ? '1 reply' : `${touches.inbound} replies`}`);
  }
  if (touches.automated > 0) parts.push(`· ${touches.automated} automated`);
  if (touches.lastAt !== null) {
    parts.push(`· last ${touches.lastDirection === 'inbound' ? 'from them' : 'from us'} ${fmtAge(touches.lastAt, now)}`);
  }
  return parts.join(' ');
}

/** Spelled out, not glyphs: a card at this size should never need a legend. */
function touchCounts(touches: PipelineStageTouches): string {
  if (touches.outbound === 0 && touches.inbound === 0) return 'No touch points yet';
  const made = touches.outbound === 1 ? '1 touch point' : `${touches.outbound} touch points`;
  const reply = touches.inbound === 0
    ? 'no reply'
    : touches.inbound === 1 ? '1 reply' : `${touches.inbound} replies`;
  return `${made} · ${reply}`;
}

/**
 * One cell a day from the strongest real phase boundary, today on the
 * right. Cells are a fixed width rather than stretched to fill, so the bar
 * grows as the deal sits: length is dwell time, and a trailing run of empty
 * cells is the silence itself, read before any number under it.
 */
function DayStrip({ days, daysBefore }: { days: readonly PipelineTouchDay[]; daysBefore: number }) {
  if (days.length === 0) return null;
  return (
    <div className="pipeline-day-strip" aria-hidden="true">
      {daysBefore > 0 && (
        <span
          className="pipeline-day-more"
          title={`${daysBefore} earlier ${daysBefore === 1 ? 'day' : 'days'} in this phase`}
        />
      )}
      {days.map((level, index) => (
        <span className={`pipeline-day is-l${level}`} key={index} />
      ))}
    </div>
  );
}

function StageTouches({
  touches,
  now,
}: {
  touches: PipelineStageTouches;
  now: number;
}) {
  const anchor = touches.lastAt ?? touches.phaseStartedAt;
  const heat = anchor === null ? 'cool' : touchHeat(anchor, now, touches.lastAt === null ? null : touches.lastDirection);
  const when = touches.lastAt !== null
    ? fmtAge(touches.lastAt, now)
    : touches.phaseStartedAt !== null
      ? phaseDwell(touches.phaseLabel, touches.phaseStartedAt, now)
      : 'No activity recorded';

  return (
    <div className="pipeline-touches" data-heat={heat} title={touchSummary(touches, now)}>
      <DayStrip days={touches.days} daysBefore={touches.daysBefore} />
      <div className="pipeline-touch-line">
        <span className="pipeline-touch-label">{touchCounts(touches)}</span>
        <span className="pipeline-touch-when">{when}</span>
      </div>
    </div>
  );
}

function latestKnownAt(...candidates: Array<number | null | undefined>): number | null {
  const known = candidates.filter((value): value is number => Number.isFinite(value));
  return known.length > 0 ? Math.max(...known) : null;
}

export function PipelineColumns({
  s,
  deals,
  onOpenLead,
  onOpenAction,
  onOpenReminder,
  archivedBucketCounts,
  archivedHasMore,
  archivedLoading,
  onLoadMoreArchived,
}: {
  s: State;
  deals: PipelineDeal[];
  onOpenLead: (deal: PipelineDeal) => void;
  onOpenAction: (actionId: string) => void;
  onOpenReminder: (reminderId: string) => void;
  archivedBucketCounts: Record<'cold_lead' | 'estimate_scheduled' | 'proposal_sent' | 'closed_with_appointment' | 'closed_without_appointment', number>;
  archivedHasMore: boolean;
  archivedLoading: boolean;
  onLoadMoreArchived: () => void;
}) {
  const latestByPerson = useMemo(() => latestSignals(s.signals), [s.signals]);
  const peopleById = useMemo(() => new Map(s.people.map((person) => [person.id, person])), [s.people]);
  const actionsByPerson = useMemo(() => new Map(s.actions.map((action) => [action.personId, action])), [s.actions]);
  const remindersByPerson = useMemo(
    () => new Map(s.reminders.map((reminder) => [reminder.personId, reminder])),
    [s.reminders],
  );
  const dealsByStage = useMemo(() => {
    const groups = new Map<PipelineStage, PipelineDeal[]>(
      [...PIPELINE_STAGES, UNMAPPED_STAGE].map((stage) => [stage.key, []]),
    );
    for (const deal of deals) {
      const stage = deal.archived ? deal.archiveBucket : stageOf(deal);
      if (stage) groups.get(stage)?.push(deal);
    }
    return groups;
  }, [deals]);
  const visibleStages = (dealsByStage.get('unmapped')?.length ?? 0) > 0
    ? [...PIPELINE_STAGES, UNMAPPED_STAGE]
    : PIPELINE_STAGES;

  const openWithKeyboard = (event: KeyboardEvent<HTMLElement>, deal: PipelineDeal) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenLead(deal);
    }
  };

  return (
    <>
      {visibleStages.map((stage) => {
        const stageDeals = dealsByStage.get(stage.key) ?? [];
        const activeDeals = stageDeals.filter((deal) => !deal.archived);
        const archivedDeals = stageDeals.filter((deal) => deal.archived);
        return (
          <section className="pane pipeline-stage" data-stage={stage.key} key={stage.key}>
            <header className="pane-head pipeline-stage-head" title={stage.hint}>
              <span className="pipeline-stage-icon" aria-hidden="true">{stage.icon}</span>
              <h2>{stage.label}</h2>
              <span className="pane-count">{activeDeals.length}</span>
            </header>
            <div className="pane-scroll pipeline-stage-scroll">
              {[...activeDeals, ...archivedDeals].map((deal, index) => {
                const person = peopleById.get(deal.personId);
                const latest = latestByPerson.get(deal.personId);
                const latestAt = latestKnownAt(latest?.at, deal.latestSignalAt, person?.latestSignalAt);
                const action = actionsByPerson.get(deal.personId);
                const reminder = remindersByPerson.get(deal.personId);
                const source = leadSourceMeta(deal.source);
                const dealName = meaningfulDealName(deal);
                const showArchiveDivider = deal.archived && index === activeDeals.length;
                return (
                  <div key={deal.id}>
                  {showArchiveDivider && (
                    <div className="pipeline-archive-divider">
                      <span>Archived</span>
                      <span>{(archivedBucketCounts[deal.archiveBucket ?? 'cold_lead'] ?? 0).toLocaleString()}</span>
                    </div>
                  )}
                  <article
                    className={`pipeline-card is-clickable${deal.archived ? ' is-archived' : ''}`}
                    onClick={() => onOpenLead(deal)}
                    onKeyDown={(event) => openWithKeyboard(event, deal)}
                    role="button"
                    tabIndex={0}
                    title={latestAt
                      ? `Open ${deal.customerName}'s workspace · last signal on any stage ${fmtAge(latestAt, s.now)}`
                      : `Open ${deal.customerName}'s workspace`}
                  >
                    <div className="pipeline-card-top">
                      <h3>{deal.customerName}</h3>
                    </div>
                    {dealName && <p className="pipeline-deal-name">{dealName}</p>}
                    <div className="pipeline-card-context">
                      <span className={`pipeline-source is-${source.tone}`}>{source.label}</span>
                      {deal.amountCents > 0 && <strong>{money.format(deal.amountCents / 100)}</strong>}
                    </div>
                    {latest && (
                      <p className="pipeline-card-message">{latest.text}</p>
                    )}
                    {(action || reminder) && (
                      <div className="pipeline-next-work" onClick={(event) => event.stopPropagation()}>
                        {action && (
                          <button type="button" onClick={() => onOpenAction(action.id)}>✦ {action.title}</button>
                        )}
                        {reminder && (
                          <button type="button" onClick={() => onOpenReminder(reminder.id)}>
                            ⏰ {reminder.note} · {fmtDue(reminder.dueAt, s.now)}
                          </button>
                        )}
                      </div>
                    )}
                    <StageTouches
                      touches={deal.stageTouches}
                      now={s.now}
                    />
                    <div className="pipeline-card-foot">
                      <span>{deal.salesperson ?? 'Unassigned'}</span>
                    </div>
                  </article>
                  </div>
                );
              })}
              {activeDeals.length === 0 && archivedDeals.length === 0 && (
                <div className="pipeline-empty">No deals in this DripJobs stage</div>
              )}
              {stage.key === 'cold_lead' && (
                <ArchivedPipelineSentinel
                  hasMore={archivedHasMore}
                  loading={archivedLoading}
                  onLoadMore={onLoadMoreArchived}
                />
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}

function ArchivedPipelineSentinel({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || !hasMore || loading) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) onLoadMore();
    }, { root: node.parentElement, rootMargin: '240px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);
  if (!hasMore && !loading) return null;
  return <div className="pipeline-archive-loader" ref={ref} aria-hidden="true" />;
}
