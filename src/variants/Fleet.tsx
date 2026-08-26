import { Fragment, ReactNode, useCallback, useEffect, useState } from 'react';
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
import { useLiveBoard } from '../board/useLiveBoard';
import { agentFor } from '../engine';
import { fmtAge } from '../time';
import { ActionCard } from '../types';
import { derive, DueChip, Empty, PaneHead, RoleTag } from './shared';
import {
  AGENT_STEPS,
  AgentInfo,
  KitHeader,
  PeopleCol,
  PlaybooksCol,
  RunPopup,
  RunSubject,
  runStepIdx,
  SideNav,
  SignalsCol,
} from './kit';
import './flow.css';
import './zen.css';
import './fleet.css';

type AppPage = 'Board' | 'Agents' | 'Skills' | 'Actions' | 'Activity' | 'Labels' | 'Schedules' | 'Connections' | 'Contacts';

function pageFromPath(): AppPage {
  if (window.location.pathname === '/agents') return 'Agents';
  if (window.location.pathname === '/skills') return 'Skills';
  if (window.location.pathname === '/actions') return 'Actions';
  if (window.location.pathname === '/schedules' || window.location.pathname === '/automations') return 'Schedules';
  if (window.location.pathname === '/connections') return 'Connections';
  if (window.location.pathname === '/labels') return 'Labels';
  if (window.location.pathname === '/contacts' || window.location.pathname === '/people') return 'Contacts';
  if (window.location.pathname === '/activity' || window.location.pathname === '/activities') return 'Activity';
  return 'Board';
}

export function FleetV() {
  const board = useLiveBoard();
  const { s, act } = board;
  const d = derive(s);
  const [runSel, setRunSel] = useState<RunSubject | null>(null);
  const [page, setPage] = useState<AppPage>(pageFromPath);
  const [hermesStatus, setHermesStatus] = useState<HermesStatus | null>(null);
  const [hermesSchedules, setHermesSchedules] = useState<HermesAgentDefinition[] | null>(null);
  const [hermesError, setHermesError] = useState<string | null>(null);
  const hermesAgents = hermesSchedules?.filter((schedule) => schedule.runtimeMode === 'agent') ?? null;

  useEffect(() => {
    const syncPage = () => setPage(pageFromPath());
    window.addEventListener('popstate', syncPage);
    return () => window.removeEventListener('popstate', syncPage);
  }, []);

  const refreshHermes = useCallback(async () => {
    const [statusResult, schedulesResult] = await Promise.allSettled([
      loadHermesStatus(),
      loadHermesSchedules(),
    ]);
    setHermesStatus(statusResult.status === 'fulfilled' ? statusResult.value : null);
    setHermesSchedules(schedulesResult.status === 'fulfilled' ? schedulesResult.value : null);
    const failure = schedulesResult.status === 'rejected'
      ? schedulesResult.reason
      : statusResult.status === 'rejected'
        ? statusResult.reason
        : null;
    setHermesError(
      failure === null
        ? null
        : failure instanceof Error
          ? failure.message
          : 'Could not reach Hermes',
    );
  }, []);

  useEffect(() => {
    void refreshHermes();
    const timer = window.setInterval(() => void refreshHermes(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshHermes]);

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
    if (!['Board', 'Agents', 'Skills', 'Actions', 'Activity', 'Labels', 'Schedules', 'Contacts', 'Connections'].includes(label)) return;
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
                : label === 'Activity'
                  ? '/activity'
                  : '/';
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
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
      schedules={hermesSchedules}
      error={hermesError}
      onRefresh={refreshHermes}
    />
  );
  if (page === 'Activity') return <ActivitiesPage onNavigate={navigate} header={appHeader} />;
  if (page === 'Labels') return <LabelsPage onNavigate={navigate} header={appHeader} />;
  if (page === 'Contacts') return <PeoplePage onNavigate={navigate} header={appHeader} />;
  if (page === 'Connections') return <ConnectionsPage onNavigate={navigate} header={appHeader} />;

  if (!s.booted) return <div className="boot" />;

  const fname = d.focusPerson?.name ?? null;
  const personOf = (id: string) => s.people.find((x) => x.id === id);

  // ----- open work on top, done sinks to the bottom -----
  const rows: { a: ActionCard; doneAt: number | null }[] = [
    ...d.actions
      .slice()
      .sort((x, y) => y.createdAt - x.createdAt || x.id.localeCompare(y.id))
      .map((a) => ({ a, doneAt: null as number | null })),
    ...s.handled
      .filter((h) => !s.focusId || h.a.personId === s.focusId)
      .map((h) => ({ a: h.a, doneAt: h.at as number | null })),
  ];
  const openCount = d.actions.length;

  const needsCount = d.actions.filter((a) => {
    const run = s.runs[a.id];
    return run ? run.status === 'fail' || run.status === 'review' : agentFor(s, a) === null;
  }).length;

  // ----- status chip per card -----
  const statusOfCard = (a: ActionCard): { key: string; chip: ReactNode } => {
    if (a.status === 'simulated') return { key: 'review', chip: <>◌ Sent (simulation)</> };
    if (a.status === 'awaiting_approval') return { key: 'review', chip: <>◔ review · Hermes</> };
    if (a.status === 'failed') return { key: 'fail', chip: <>✗ failed · Hermes</> };
    if (a.status === 'drafting') return { key: 'run', chip: <><i className="fs-run-i" /> Hermes drafting</> };
    const run = s.runs[a.id];
    if (!run) {
      const agent = agentFor(s, a);
      if (agent) return { key: 'queued', chip: <>⋯ queued · {agent}</> };
      return { key: 'you', chip: <>● needs you</> };
    }
    if (run.status === 'running')
      return {
        key: 'run',
        chip: (
          <>
            <i className="fs-run-i" /> {run.agent} working
          </>
        ),
      };
    if (run.status === 'review') return { key: 'review', chip: <>◔ review · {run.agent}</> };
    return { key: 'fail', chip: <>✗ failed · {run.agent}</> };
  };

  // a triggered/due reminder has moved to Actions — Reminders holds only the future
  const heldRems = d.reminders.filter((r) => !s.actions.some((x) => x.id === `action:rem:${r.id}`));

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
          <main className="fl-cols">
            <PeopleCol
              s={s}
              act={act}
              d={d}
              totalCount={board.peopleCount}
              hasMore={board.peopleHasMore}
              loading={board.peopleLoading}
              onLoadMore={() => void board.loadMorePeople()}
            />
            <SignalsCol
              s={s}
              act={act}
              d={d}
              selId={runSel?.type === 'signal' ? runSel.id : null}
              view={board.signalView === 'needs_you' ? 'open' : 'all'}
              onView={(view) => board.setSignalView(view === 'open' ? 'needs_you' : 'all')}
              hasMore={board.signalsHasMore}
              loading={board.signalsLoading}
              onLoadMore={() => void board.loadMoreSignals()}
              onOpen={(sig) => {
                setRunSel({ type: 'signal', id: sig.id });
                void board.openSignal(sig.id);
              }}
            />

            {/* ----- actions: dispatched to agents, statuses live on the chip ----- */}
            <section className="pane fl-actions">
              <PaneHead
                title="Actions"
                count={needsCount > 0 ? `${needsCount} need you` : d.actions.length}
                focusName={fname}
                onClear={() => act.focus(null)}
              />
              <div className="pane-scroll">
                {d.actions.length === 0 && (
                  <div className="fl-zero">No user-created actions{fname ? ` for ${fname}` : ''}.</div>
                )}
                {rows.map(({ a, doneAt }, i) => {
                  const p = personOf(a.personId);
                  const run = s.runs[a.id];
                  if (doneAt !== null) {
                    const label =
                      run?.status === 'ok'
                        ? `${run.agent} · ${run.note}`
                        : run?.status === 'review'
                          ? `approved — ${run.agent} executed`
                          : 'done by you';
                    return (
                      <Fragment key={a.id}>
                        {i === openCount && <h4 className="autos-h">Done</h4>}
                        <article
                          className="card fl-done-card fs-click"
                          onClick={() => { setRunSel({ type: 'action', id: a.id }); void board.openAction(a.id); }}
                          title="Open the chat"
                        >
                          <div className="card-top">
                            <span className="fl-doneat">✓ {label} · {fmtAge(doneAt, s.now)}</span>
                          </div>
                          <h3 className="fl-done-title">{a.title}</h3>
                          <div className="fl-act-person">{p?.name ?? '—'}</div>
                          {run?.rec && !run.recTaken && (
                            <div className="fs-rec">
                              ↪ {run.agent} recommends: <b>{run.rec}</b>
                            </div>
                          )}
                        </article>
                      </Fragment>
                    );
                  }
                  const st = statusOfCard(a);
                  const fresh = s.now - a.createdAt < 5000;
                  const steps = run ? AGENT_STEPS[run.agent] ?? [] : [];
                  const stepIdx = run ? runStepIdx(run, s.now) : 0;
                  const pct =
                    run && run.status === 'running'
                      ? Math.max(5, Math.min(96, Math.round(((s.now - run.startedAt) / (run.resolveAt - run.startedAt)) * 100)))
                      : 0;
                  return (
                    <article
                      key={a.id}
                      className={`card fs-card fs-b-${st.key}${fresh ? ' fresh' : ''}`}
                      onClick={() => { setRunSel({ type: 'action', id: a.id }); void board.openAction(a.id); }}
                      title="Open the chat"
                    >
                      <div className="card-top">
                        <span className={`fs-st fs-st-${st.key}`}>{st.chip}</span>
                        <span className="card-age">{fmtAge(a.createdAt, s.now)}</span>
                      </div>
                      <h3 className="fl-act-title">{a.title}</h3>
                      {run?.status === 'running' && (
                        <div className="fs-prog-row">
                          <span className="fs-prog">
                            <span className="fs-prog-fill" style={{ width: `${pct}%` }} />
                          </span>
                          <span className="fs-prog-step">{steps[stepIdx] ?? 'Working'}…</span>
                        </div>
                      )}
                      <div className="fl-act-person">
                        {p?.name ?? '—'}
                        {p && <RoleTag role={p.role} />}
                      </div>
                      {run && (run.status === 'review' || run.status === 'fail') && (
                        <div className="fs-note">↳ {run.note}</div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>

            {/* ----- reminders: Chaser holds them — click to trigger or cancel ----- */}
            <section className="pane fl-rems">
              <PaneHead title="Reminders" count={heldRems.length} focusName={fname} onClear={() => act.focus(null)} />
              <div className="pane-scroll">
                {heldRems.map((r) => {
                  const p = personOf(r.personId);
                  const due = r.dueAt <= s.now;
                  const born = r.bornLive && s.now - r.createdAt < 8000;
                  return (
                    <article
                      key={r.id}
                      className={`card rem-card fs-click ${due ? 'overdue due' : 'upcoming'}${born ? ' born' : ''}`}
                      onClick={() => setRunSel({ type: 'reminder', id: r.id })}
                      title="Open the chat"
                    >
                      <div className="card-top">
                        <DueChip dueAt={r.dueAt} now={s.now} />
                        {born && <span className="chip-born">captured</span>}
                      </div>
                      <h3 className="fl-rem-note">{r.note}</h3>
                      <div className="fl-act-person">
                        {p?.name ?? '—'}
                        {p && <RoleTag role={p.role} />}
                      </div>
                    </article>
                  );
                })}
                {heldRems.length === 0 && (
                  <Empty>No user-created reminders{fname ? ` for ${fname}` : ''}.</Empty>
                )}
              </div>
            </section>

            <PlaybooksCol s={s} act={act} onOpen={(instId) => setRunSel({ type: 'auto', id: instId })} />
          </main>
        </div>
      </div>
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
