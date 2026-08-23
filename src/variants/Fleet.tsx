import { Fragment, ReactNode, useEffect, useState } from 'react';
import { ConnectionsPage } from '../connections/ConnectionsPage';
import { agentFor } from '../engine';
import { fmtAge, fmtDue } from '../time';
import { ActionCard } from '../types';
import { derive, DueChip, Empty, PaneHead, RoleTag, VProps } from './shared';
import {
  AGENT_EMOJI,
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

/**
 * Fleet — the same clean board as Zen, but actions actually RUN: an agent
 * picks a card up, works it step by step, and it succeeds, fails, or comes
 * back for review — sometimes recommending the next move. Clicking an
 * action opens the RUN inspector (execution timeline, the draft, controls);
 * the person dossier stays one click deeper. Roster lives in the side nav.
 */

export function FleetV({ s, act }: VProps) {
  const d = derive(s);
  const [runSel, setRunSel] = useState<RunSubject | null>(null);
  const [page, setPage] = useState<'Board' | 'Connections'>(() =>
    window.location.pathname === '/connections' ? 'Connections' : 'Board',
  );

  useEffect(() => {
    const syncPage = () => {
      setPage(window.location.pathname === '/connections' ? 'Connections' : 'Board');
    };
    window.addEventListener('popstate', syncPage);
    return () => window.removeEventListener('popstate', syncPage);
  }, []);

  const navigate = (label: string) => {
    if (label !== 'Board' && label !== 'Connections') return;
    const path = label === 'Connections' ? '/connections' : '/';
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setPage(label);
  };

  if (page === 'Connections') return <ConnectionsPage d={d} onNavigate={navigate} />;

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

  // ----- side-nav roster, driven by the actual runs -----
  const openIds = new Set(s.actions.map((a) => a.id));
  const statsFor = (name: string) => {
    let working = 0;
    let needs = 0;
    for (const [id, run] of Object.entries(s.runs)) {
      if (run.agent !== name || !openIds.has(id)) continue;
      if (run.status === 'running') working += 1;
      if (run.status === 'review' || run.status === 'fail') needs += 1;
    }
    const doneToday = s.handled.filter((h) => {
      const run = s.runs[h.a.id];
      return run?.agent === name && run.status === 'ok';
    }).length;
    return { working, needs, doneToday };
  };
  const lineFor = (name: string, idle: string) => {
    const { working, needs, doneToday } = statsFor(name);
    const parts: string[] = [];
    if (working > 0) parts.push(`${working} working`);
    if (needs > 0) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`);
    if (doneToday > 0) parts.push(`${doneToday} done today`);
    return { line: parts.length > 0 ? parts.join(' · ') : idle, working, needs };
  };
  const agentRow = (name: string, duty: string, idle: string): AgentInfo => {
    const { line, working, needs } = lineFor(name, idle);
    return {
      emoji: AGENT_EMOJI[name] ?? '🤖',
      name,
      duty,
      status: needs > 0 ? 'waiting' : working > 0 ? 'working' : 'idle',
      line,
    };
  };
  // a triggered/due reminder has moved to Actions — Reminders holds only the future
  const heldRems = d.reminders.filter((r) => !s.actions.some((x) => x.id === `action:rem:${r.id}`));

  const latest = s.signals[s.signals.length - 1];
  const running = s.seqInstances.filter((i) => i.doneAt === null).sort((a, b) => a.nextAt - b.nextAt);
  const scout = agentRow('Scout', 'Intake & CRM', `routed ${d.c.signalsToday} signal${d.c.signalsToday === 1 ? '' : 's'} today`);
  if (scout.status === 'idle' && latest && s.now - latest.at < 30_000) scout.status = 'working';
  const roster: AgentInfo[] = [
    scout,
    agentRow('Scribe', 'Replies & drafts', 'inbox clear'),
    agentRow('Chaser', 'Follow-ups & nudges', 'calendar clear'),
    agentRow('Ledger', 'Invoices & payments', 'books are current'),
    {
      emoji: '🧭',
      name: 'Runner',
      duty: 'Automation runs',
      status: running.length > 0 ? 'working' : 'idle',
      line:
        running.length > 0
          ? `${running.length} automation${running.length === 1 ? '' : 's'} running · next ${fmtDue(running[0]!.nextAt, s.now)}`
          : 'no automations running',
    },
  ];

  return (
    <div className="v v-flow v-zen v-fleet">
      <div className="fl-shell">
        <SideNav d={d} roster={roster} active="Board" onNav={navigate} />
        <div className="fl-frame">
          <KitHeader s={s} act={act} d={d} />
          <main className="fl-cols">
            <PeopleCol s={s} act={act} d={d} />
            <SignalsCol
              s={s}
              act={act}
              d={d}
              selId={runSel?.type === 'signal' ? runSel.id : null}
              onOpen={(sig) => setRunSel({ type: 'signal', id: sig.id })}
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
                  <div className="fl-zero">All clear — the agents are watching{fname ? ` for ${fname}` : ''}.</div>
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
                          onClick={() => setRunSel({ type: 'action', id: a.id })}
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
                      onClick={() => setRunSel({ type: 'action', id: a.id })}
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
                  <Empty>Nothing waiting{fname ? ` for ${fname}` : ''} — triggered reminders move to Actions.</Empty>
                )}
              </div>
            </section>

            <PlaybooksCol s={s} act={act} onOpen={(instId) => setRunSel({ type: 'auto', id: instId })} />
          </main>
        </div>
      </div>
      {runSel && <RunPopup s={s} act={act} subject={runSel} onClose={() => setRunSel(null)} />}
    </div>
  );
}
