import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppPage, isAppPage, pageFromPath, pathForPage } from '../app/routes';
import { ActivitiesPage } from '../activities/ActivitiesPage';
import { ActionsPage } from '../actions/ActionsPage';
import { LiveActionPopup } from '../actions/LiveActionPopup';
import { AgentsPage } from '../agents/AgentsPage';
import { HermesAgentDefinition, HermesStatus, loadHermesSchedules, loadHermesStatus } from '../agents/hermes';
import { ConnectionsPage } from '../connections/ConnectionsPage';
import { LabelsPage } from '../labels/LabelsPage';
import { PeoplePage } from '../people/PeoplePage';
import { SchedulesPage } from '../schedules/SchedulesPage';
import { SkillsPage } from '../skills/SkillsPage';
import { KitHeader, SideNav } from '../components/AppChrome';
import { LeadWorkspace } from '../board/LeadWorkspace';
import {
  ALL_MONTHS,
  PIPELINE_STAGES,
  PipelineColumns,
  PipelineFilterBar,
  receivedMonthKey,
} from '../board/PipelineColumns';
import { candidateSignal, PotentialLeadsColumn } from '../board/PotentialLeads';
import { useLiveBoard } from '../board/useLiveBoard';
import { derive } from './shared';
import {
  RunPopup,
  RunSubject,
  SignalsCol,
} from './kit';
import './flow.css';
import './zen.css';
import './fleet.css';

type BoardPopupSubject =
  | RunSubject
  | { type: 'action'; id: string }
  | { type: 'candidate'; id: number };

export function FleetV() {
  const [page, setPage] = useState<AppPage>(() => pageFromPath(window.location.pathname));

  useEffect(() => {
    const syncPage = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener('popstate', syncPage);
    return () => window.removeEventListener('popstate', syncPage);
  }, []);

  const navigate = useCallback((label: string) => {
    if (!isAppPage(label)) return;
    const path = pathForPage(label);
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    setPage(label);
  }, []);

  const header = <KitHeader />;
  if (page === 'Agents') return <AgentsPage onNavigate={navigate} header={header} />;
  if (page === 'Skills') return <SkillsPage onNavigate={navigate} header={header} />;
  if (page === 'Actions') return <ActionsPage onNavigate={navigate} header={header} />;
  if (page === 'Schedules') return <SchedulesRoute onNavigate={navigate} />;
  if (page === 'Activity') return <ActivitiesPage onNavigate={navigate} header={header} />;
  if (page === 'Labels') return <LabelsPage onNavigate={navigate} header={header} />;
  if (page === 'Contacts') return <PeoplePage key="contacts" onNavigate={navigate} header={header} />;
  if (page === 'Employees') return <PeoplePage key="employees" onNavigate={navigate} header={header} view="employees" />;
  if (page === 'Connections') return <ConnectionsPage onNavigate={navigate} header={header} />;
  return <BoardPage onNavigate={navigate} />;
}

function SchedulesRoute({ onNavigate }: { onNavigate: (label: string) => void }) {
  const [status, setStatus] = useState<HermesStatus | null>(null);
  const [schedules, setSchedules] = useState<HermesAgentDefinition[] | null>(null);
  const [hermesError, setHermesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [statusResult, hermesSchedulesResult] = await Promise.allSettled([
      loadHermesStatus(),
      loadHermesSchedules(),
    ]);
    setStatus(statusResult.status === 'fulfilled' ? statusResult.value : null);
    const hermesFailure = statusResult.status === 'rejected'
      ? statusResult.reason
      : hermesSchedulesResult.status === 'rejected' ? hermesSchedulesResult.reason : null;
    setHermesError(
      hermesFailure === null
        ? null
        : hermesFailure instanceof Error
          ? hermesFailure.message
          : 'Could not reach Hermes',
    );
    setSchedules(hermesSchedulesResult.status === 'fulfilled' ? hermesSchedulesResult.value : null);
    setError(hermesSchedulesResult.status === 'rejected' ? 'Could not load Hermes schedules.' : null);
    setWarning(
      statusResult.status === 'rejected' && hermesSchedulesResult.status === 'fulfilled'
        ? 'Hermes runtime status is temporarily unavailable.'
        : null,
    );
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <SchedulesPage
      onNavigate={onNavigate}
      header={<KitHeader hermesStatus={status} hermesError={hermesError} />}
      status={status}
      schedules={schedules}
      error={error}
      warning={warning}
      onRefresh={refresh}
    />
  );
}

const BOARD_SKELETON_COLUMNS = [
  { key: 'signals', className: 'fl-signals', cards: 3 },
  { key: 'potential-leads', className: 'pipeline-stage potential-leads', cards: 2 },
  ...PIPELINE_STAGES.map((stage, index) => ({
    key: stage.key,
    className: 'pipeline-stage',
    cards: index % 3 === 0 ? 3 : 2,
  })),
];

function BoardSkeleton() {
  return (
    <>
      <div className="pipeline-filter-bar board-skeleton-filter" aria-hidden="true">
        <span className="board-skeleton-shim board-skeleton-filter-label" />
        <span className="board-skeleton-shim board-skeleton-filter-select" />
        <span className="board-skeleton-sync">
          <span className="board-skeleton-shim board-skeleton-sync-dot" />
          <span className="board-skeleton-shim board-skeleton-sync-label" />
        </span>
      </div>
      <main
        className="fl-cols pipeline-cols board-skeleton"
        role="status"
        aria-label="Loading Board…"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="board-skeleton-sr">Loading Board…</span>
        {BOARD_SKELETON_COLUMNS.map((column, columnIndex) => (
          <section
            className={`pane ${column.className} board-skeleton-column`}
            aria-hidden="true"
            key={column.key}
          >
            <header className="pane-head pipeline-stage-head">
              <span className="board-skeleton-shim board-skeleton-icon" />
              <span className="board-skeleton-shim board-skeleton-heading" />
              <span className="board-skeleton-shim board-skeleton-count" />
            </header>
            <div className="pane-scroll pipeline-stage-scroll">
              {Array.from({ length: column.cards }, (_, cardIndex) => (
                <div
                  className="board-skeleton-card"
                  key={`${column.key}:${cardIndex}`}
                >
                  <span className="board-skeleton-shim board-skeleton-name" />
                  <span className="board-skeleton-shim board-skeleton-copy" />
                  <span className="board-skeleton-shim board-skeleton-copy is-short" />
                  <span className="board-skeleton-meta">
                    <span className="board-skeleton-shim board-skeleton-pill" />
                    <span className="board-skeleton-shim board-skeleton-amount" />
                  </span>
                </div>
              ))}
              {columnIndex % 2 === 1 && (
                <span className="board-skeleton-shim board-skeleton-tail" />
              )}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}

function BoardPage({ onNavigate }: { onNavigate: (label: string) => void }) {
  const board = useLiveBoard();
  const { s, act } = board;
  const d = useMemo(() => derive(s), [s]);
  const [runSel, setRunSel] = useState<BoardPopupSubject | null>(null);
  const [leadSel, setLeadSel] = useState<string | null>(null);
  const [receivedMonth, setReceivedMonth] = useState<string>(ALL_MONTHS);

  useEffect(() => {
    const signalId = new URLSearchParams(window.location.search).get('signal');
    if (signalId && /^[1-9][0-9]*$/.test(signalId)) setRunSel({ type: 'signal', id: signalId });
  }, []);

  /** Deals whose lead-received month matches the filter; undated deals drop out. */
  const visibleDeals = useMemo(
    () => receivedMonth === ALL_MONTHS
      ? board.pipelineDeals
      : board.pipelineDeals.filter((deal) => receivedMonthKey(deal) === receivedMonth),
    [board.pipelineDeals, receivedMonth],
  );

  const changeReceivedMonth = useCallback((month: string) => {
    setReceivedMonth(month);
    void board.filterArchivedPipeline(month === ALL_MONTHS ? null : month);
  }, [board.filterArchivedPipeline]);

  if (!s.booted) return (
    <div className="v v-flow v-zen v-fleet">
      <div className="fl-shell">
        <SideNav active="Board" onNav={onNavigate} />
        <div className="fl-frame">
          <KitHeader />
          <BoardSkeleton />
        </div>
      </div>
    </div>
  );

  const leadDeal = leadSel !== null
    ? board.pipelineDeals.find((deal) => deal.id === leadSel) ?? null
    : null;
  const openCandidate = runSel?.type === 'candidate'
    ? board.leadCandidates.find((candidate) => candidate.id === runSel.id) ?? null
    : null;

  return (
    <div className="v v-flow v-zen v-fleet">
      <div className="fl-shell">
        <SideNav active="Board" onNav={onNavigate} />
        <div className="fl-frame">
          <KitHeader />
          {board.error && (
            <div className="board-error" role="alert">
              <span><strong>Board refresh failed.</strong> {board.error}</span>
              <button type="button" onClick={() => void board.retry().catch(() => undefined)}>Try again</button>
            </div>
          )}
          <PipelineFilterBar
            now={s.now}
            capturedAt={board.pipelineCapturedAt}
            sync={board.pipelineSync}
            loading={board.pipelineLoading}
            deals={board.pipelineDeals}
            archivedMonthCounts={board.archivedPipelineMonthCounts}
            month={receivedMonth}
            onMonthChange={changeReceivedMonth}
            matchCount={visibleDeals.length}
          />
          <main className="fl-cols pipeline-cols">
            <SignalsCol
              s={s}
              act={act}
              d={d}
              selId={runSel?.type === 'signal' ? runSel.id : null}
              hasMore={board.signalsHasMore}
              loading={board.signalsLoading}
              unreadCount={board.unreadSignalCount}
              onLoadMore={() => void board.loadMoreSignals()}
              onOpen={(sig) => {
                setRunSel({ type: 'signal', id: sig.id });
                void board.openSignal(sig.id);
                void act.markSignalRead(sig.id);
              }}
            />
            <PotentialLeadsColumn
              candidates={board.leadCandidates}
              undecidedCount={board.leadCandidatesUndecidedCount}
              loading={board.leadCandidatesLoading}
              now={s.now}
              selectedId={runSel?.type === 'candidate' ? runSel.id : null}
              onOpen={(candidate) => {
                setRunSel({ type: 'candidate', id: candidate.id });
                void board.openSignal(candidate.activityId);
                void act.markSignalRead(candidate.activityId);
              }}
              onDecide={act.decideLeadCandidate}
            />
            <PipelineColumns
              s={s}
              deals={visibleDeals}
              archivedBucketCounts={board.archivedPipelineBucketCounts}
              archivedHasMore={board.archivedPipelineHasMore}
              archivedLoading={board.archivedPipelineLoading}
              onLoadMoreArchived={() => void board.loadMoreArchivedPipeline()}
              onOpenLead={(deal) => {
                // Opening a lead only opens its workspace. It used to also focus
                // the board on that person, so one click both filtered the
                // signals column and opened a popup over it.
                setLeadSel(deal.id);
                void board.openPipelineHistory(deal.id);
              }}
              onOpenAction={(id) => {
                setRunSel({ type: 'action', id });
                void board.openAction(id);
              }}
            />
          </main>
        </div>
      </div>
      {leadDeal && (
        <LeadWorkspace
          s={s}
          deal={leadDeal}
          personId={leadDeal.personId}
          suspended={runSel !== null}
          stageHistory={board.pipelineHistories[leadDeal.id] ?? null}
          stageHistoryLoading={board.pipelineHistoryLoadingId === leadDeal.id}
          onClose={() => setLeadSel(null)}
          onLoadSignal={(signalId) => void board.openSignal(signalId, leadDeal.personId)}
          onOpenAction={(id) => {
            setRunSel({ type: 'action', id });
            void board.openAction(id);
          }}
        />
      )}
      {runSel?.type === 'action' ? (
        <LiveActionPopup
          detail={s.actionDetails?.[runSel.id]}
          person={s.people.find((person) => person.id === s.actions.find((action) => action.id === runSel.id)?.personId) ?? null}
          now={s.now}
          act={act}
          onClose={() => setRunSel(null)}
          onOpenSignal={(id) => {
            setRunSel({ type: 'signal', id });
            void board.openSignal(id);
            void act.markSignalRead(id);
          }}
        />
      ) : runSel?.type === 'candidate' ? (
        openCandidate && (
          <RunPopup
            s={s}
            act={act}
            subject={{ type: 'signal', id: openCandidate.activityId }}
            candidate={openCandidate}
            fallbackSignal={candidateSignal(openCandidate)}
            onClose={() => setRunSel(null)}
            onLoadMoreHistory={(id) => void board.loadMoreHistory(id)}
            onOpenAction={(id) => {
              setRunSel({ type: 'action', id });
              void board.openAction(id);
            }}
          />
        )
      ) : runSel ? (
        <RunPopup
          s={s}
          act={act}
          subject={runSel}
          onClose={() => setRunSel(null)}
          onLoadMoreHistory={(id) => void board.loadMoreHistory(id)}
          onOpenAction={(id) => {
            setRunSel({ type: 'action', id });
            void board.openAction(id);
          }}
        />
      ) : null}
    </div>
  );
}
