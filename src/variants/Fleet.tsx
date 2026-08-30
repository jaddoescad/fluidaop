import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivitiesPage } from '../activities/ActivitiesPage';
import { ActionsPage } from '../actions/ActionsPage';
import { LiveActionPopup } from '../actions/LiveActionPopup';
import { AgentsPage } from '../agents/AgentsPage';
import { HermesAgentDefinition, HermesStatus, loadHermesSchedules, loadHermesStatus } from '../agents/hermes';
import { ConnectionsPage } from '../connections/ConnectionsPage';
import { LabelsPage } from '../labels/LabelsPage';
import { PeoplePage } from '../people/PeoplePage';
import { SchedulesPage } from '../schedules/SchedulesPage';
import { loadFluidSchedules } from '../schedules/fluid';
import { SkillsPage } from '../skills/SkillsPage';
import { LeadWorkspace } from '../board/LeadWorkspace';
import { ALL_MONTHS, PipelineColumns, PipelineFilterBar, receivedMonthKey } from '../board/PipelineColumns';
import { useLiveBoard } from '../board/useLiveBoard';
import { derive } from './shared';
import {
  AgentInfo,
  KitHeader,
  RunPopup,
  RunSubject,
  SideNav,
  SignalsCol,
} from './kit';
import './flow.css';
import './zen.css';
import './fleet.css';

type AppPage = 'Board' | 'Agents' | 'Skills' | 'Actions' | 'Activity' | 'Labels' | 'Schedules' | 'Connections' | 'Contacts' | 'Employees';

function pageFromPath(): AppPage {
  if (window.location.pathname === '/agents' || window.location.pathname.startsWith('/agents/')) return 'Agents';
  if (window.location.pathname === '/skills') return 'Skills';
  if (window.location.pathname === '/actions') return 'Actions';
  if (window.location.pathname === '/schedules' || window.location.pathname === '/automations') return 'Schedules';
  if (window.location.pathname === '/connections') return 'Connections';
  if (window.location.pathname === '/labels') return 'Labels';
  if (window.location.pathname === '/employees') return 'Employees';
  if (window.location.pathname === '/contacts' || window.location.pathname === '/people') return 'Contacts';
  if (window.location.pathname === '/activity' || window.location.pathname === '/activities') return 'Activity';
  return 'Board';
}

export function FleetV() {
  const board = useLiveBoard();
  const { s, act } = board;
  const d = derive(s);
  const [runSel, setRunSel] = useState<RunSubject | null>(null);
  const [leadSel, setLeadSel] = useState<string | null>(null);
  const [receivedMonth, setReceivedMonth] = useState<string>(ALL_MONTHS);
  const [page, setPage] = useState<AppPage>(pageFromPath);
  const [hermesStatus, setHermesStatus] = useState<HermesStatus | null>(null);
  const [hermesSchedules, setHermesSchedules] = useState<HermesAgentDefinition[] | null>(null);
  const [schedules, setSchedules] = useState<HermesAgentDefinition[] | null>(null);
  const [hermesError, setHermesError] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleWarning, setScheduleWarning] = useState<string | null>(null);
  const hermesAgents = hermesSchedules?.filter((schedule) => schedule.runtimeMode === 'agent') ?? null;

  useEffect(() => {
    const syncPage = () => setPage(pageFromPath());
    window.addEventListener('popstate', syncPage);
    return () => window.removeEventListener('popstate', syncPage);
  }, []);

  const refreshHermes = useCallback(async () => {
    const [statusResult, hermesSchedulesResult, fluidSchedulesResult] = await Promise.allSettled([
      loadHermesStatus(),
      loadHermesSchedules(),
      loadFluidSchedules(),
    ]);
    setHermesStatus(statusResult.status === 'fulfilled' ? statusResult.value : null);
    setHermesSchedules(hermesSchedulesResult.status === 'fulfilled' ? hermesSchedulesResult.value : null);
    const hermesFailure = statusResult.status === 'rejected'
        ? statusResult.reason
        : hermesSchedulesResult.status === 'rejected'
          ? hermesSchedulesResult.reason
          : null;
    setHermesError(
      hermesFailure === null
        ? null
        : hermesFailure instanceof Error
          ? hermesFailure.message
          : 'Could not reach Hermes',
    );
    const availableSchedules = [
      ...(fluidSchedulesResult.status === 'fulfilled' ? fluidSchedulesResult.value : []),
      ...(hermesSchedulesResult.status === 'fulfilled' ? hermesSchedulesResult.value : []),
    ];
    const allSchedulesFailed = fluidSchedulesResult.status === 'rejected' && hermesSchedulesResult.status === 'rejected';
    setSchedules(allSchedulesFailed ? null : availableSchedules);
    setScheduleError(allSchedulesFailed ? 'Could not load Fluid or Hermes schedules.' : null);
    setScheduleWarning(
      allSchedulesFailed
        ? null
        : fluidSchedulesResult.status === 'rejected'
          ? 'Fluid script schedules are temporarily unavailable.'
          : hermesSchedulesResult.status === 'rejected'
            ? 'Hermes schedules are temporarily unavailable.'
            : null,
    );
  }, []);

  useEffect(() => {
    void refreshHermes();
    const timer = window.setInterval(() => void refreshHermes(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshHermes]);

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

  const appHeader = (
    <KitHeader
      s={s}
      act={act}
      d={d}
      hermesStatus={hermesStatus}
      hermesError={hermesError}
    />
  );

  const navigate = (label: string) => {
    if (!['Board', 'Agents', 'Skills', 'Actions', 'Activity', 'Labels', 'Schedules', 'Contacts', 'Employees', 'Connections'].includes(label)) return;
    const path = label === 'Agents'
      ? '/agents'
      : label === 'Skills'
        ? '/skills'
        : label === 'Actions'
          ? '/actions'
        : label === 'Schedules'
          ? '/schedules'
          : label === 'Connections'
            ? '/connections'
            : label === 'Labels'
              ? '/labels'
              : label === 'Contacts'
                ? '/contacts'
              : label === 'Employees'
                ? '/employees'
                : label === 'Activity'
                  ? '/activity'
                  : '/';
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
      // Pages that own a sub-route (Agents) track the path themselves and stay
      // mounted across nav, so tell them the location moved under them.
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    setPage(label as AppPage);
  };

  if (page === 'Agents') return <AgentsPage onNavigate={navigate} header={appHeader} />;
  if (page === 'Skills') return <SkillsPage onNavigate={navigate} header={appHeader} />;
  if (page === 'Actions') return <ActionsPage onNavigate={navigate} header={appHeader} />;
  if (page === 'Schedules') return (
    <SchedulesPage
      onNavigate={navigate}
      header={appHeader}
      status={hermesStatus}
      schedules={schedules}
      error={scheduleError}
      warning={scheduleWarning}
      onRefresh={refreshHermes}
    />
  );
  if (page === 'Activity') return <ActivitiesPage onNavigate={navigate} header={appHeader} />;
  if (page === 'Labels') return <LabelsPage onNavigate={navigate} header={appHeader} />;
  if (page === 'Contacts') return <PeoplePage onNavigate={navigate} header={appHeader} />;
  if (page === 'Employees') return <PeoplePage onNavigate={navigate} header={appHeader} view="employees" />;
  if (page === 'Connections') return <ConnectionsPage onNavigate={navigate} header={appHeader} />;

  if (!s.booted) return <div className="boot" />;

  const leadDeal = leadSel !== null
    ? board.pipelineDeals.find((deal) => deal.id === leadSel) ?? null
    : null;

  const roster: AgentInfo[] = (hermesAgents ?? []).map((agent) => {
    const profileAvailable = hermesStatus?.connected === true && hermesStatus.profiles.includes(agent.profile);
    const connected = profileAvailable && agent.enabled && agent.lastError === null;
    const paused = profileAvailable && !agent.enabled;
    return {
      id: agent.id,
      emoji: agent.icon,
      name: agent.name,
      duty: agent.description,
      status: connected ? 'online' : paused || hermesStatus === null ? 'checking' : 'offline',
      line: connected
        ? `${agent.schedule} · connected`
        : paused
          ? `${agent.schedule} · paused`
          : hermesStatus === null
            ? 'checking Hermes…'
            : agent.lastError !== null
              ? 'needs attention'
              : 'Hermes unavailable',
    };
  });

  return (
    <div className="v v-flow v-zen v-fleet">
      <div className="fl-shell">
        <SideNav d={d} roster={roster} active="Board" onNav={navigate} />
        <div className="fl-frame">
          {appHeader}
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
              onLoadMore={() => void board.loadMoreSignals()}
              onOpen={(sig) => {
                setRunSel({ type: 'signal', id: sig.id });
                void board.openSignal(sig.id);
              }}
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
              onOpenReminder={(id) => setRunSel({ type: 'reminder', id })}
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
          onOpenReminder={(id) => setRunSel({ type: 'reminder', id })}
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
          }}
        />
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
