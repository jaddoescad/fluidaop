import { CHANNEL_LABEL } from '../data';
import { fmtAge, fmtClock } from '../time';
import {
  AutomationsPanel,
  ContextPanel,
  derive,
  DueChip,
  Empty,
  groupStreamByDay,
  KIND_LABEL,
  Ops,
  PaneHead,
  Prov,
  RemProv,
  useDepart,
  VProps,
} from './shared';
import './ticker.css';

export function TickerV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();
  const clear = () => act.focus(null);
  const fname = d.focusPerson?.name ?? null;

  return (
    <div className="v v-ticker">
      <header className="tk-top">
        <h1 className="tk-brand">Fluid</h1>
        <span className="tk-rule" />
        <span className="tk-sub">Signal ledger — Meridian Painting Co.</span>
        <div className="tk-counters">
          <span className="counter"><b>{d.c.signalsToday}</b> signals</span>
          <span className="counter"><b>{d.c.openActions}</b> open</span>
          <span className={`counter${d.c.remindersDue > 0 ? ' hot' : ''}`}><b>{d.c.remindersDue}</b> due</span>
        </div>
        <div className="tk-ctl">
          <span className={`sim-dot${s.paused ? ' sim-paused' : ''}`} />
          <button className="tk-pause" onClick={act.togglePause}>
            {s.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      <main className="tk-main">
        {/* People ladder */}
        <section className="pane tk-people">
          <PaneHead title="People" />
          {s.focusId && (
            <button className="tk-clear" onClick={clear}>
              ✕ Clear filter
            </button>
          )}
          <div className="pane-scroll">
            {d.ranked.map(({ p, heat }, i) => {
              const focused = s.focusId === p.id;
              return (
                <button
                  key={p.id}
                  className={`tk-person${focused ? ' focused' : ''}`}
                  onClick={() => act.focus(focused ? null : p.id)}
                >
                  <span className="tk-rank">{i + 1}</span>
                  <span className="tk-pcol">
                    <span className="tk-pname">{p.name}</span>
                    <span className="tk-pheat">
                      <span className="tk-pheat-bar" style={{ width: `${heat}%` }} />
                    </span>
                  </span>
                  {d.waiting.has(p.id) && <span className="tk-wait">●</span>}
                  <span className="tk-heatnum">{heat}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Timeline */}
        <section className="pane tk-feed">
          <PaneHead title="The wire" count={d.streams.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll tk-feed-scroll">
            {groupStreamByDay(d.streams, s.now).map((g) => (
              <div key={g.label} className="tk-day">
                <div className="tk-day-label">{g.label}</div>
                {g.items.map((sig) => {
                  const p = s.people.find((x) => x.id === sig.personId);
                  const fresh = s.now - sig.at < 4000;
                  return (
                    <article key={sig.id} className={`tk-row${fresh ? ' fresh' : ''}${sig.requiresReply ? ' needs' : ''}`}>
                      <span className="tk-time">{fmtClock(sig.at)}</span>
                      <span className={`tk-chan src-${sig.channel}`}>{CHANNEL_LABEL[sig.channel]}</span>
                      <span className="tk-body">
                        <b>{p?.name ?? '—'}</b> {sig.text}
                        {sig.requiresReply && <span className="tk-needs">reply due</span>}
                      </span>
                    </article>
                  );
                })}
              </div>
            ))}
            {d.streams.length === 0 && <Empty>No signals for this filter yet.</Empty>}
          </div>
        </section>

        {/* On deck: open actions */}
        <section className="pane tk-deck">
          <PaneHead title="On deck" count={d.actions.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {d.actions.map((a) => {
              const p = s.people.find((x) => x.id === a.personId);
              const fresh = s.now - a.createdAt < 5000;
              return (
                <article
                  key={a.id}
                  className={`card tk-act kind-${a.kind}${fresh ? ' fresh' : ''}${A.leaving.has(a.id) ? ' leaving' : ''}`}
                >
                  <div className="card-top">
                    <span className={`tk-kind tk-kind-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                    <span className="card-age">{fmtAge(a.createdAt, s.now)}</span>
                  </div>
                  <h3 className="tk-act-title">{a.title}</h3>
                  <div className="tk-act-person">{p?.name ?? '—'}</div>
                  <Prov s={s} a={a} />
                  <Ops onDone={() => A.depart(a.id, act.done)} onSnooze={() => A.depart(a.id, act.snooze)} />
                </article>
              );
            })}
            {d.actions.length === 0 && <Empty>Nothing on deck{fname ? ` for ${fname}` : ''}.</Empty>}
          </div>
        </section>

        {/* Horizon: open reminders */}
        <section className="pane tk-horizon">
          <PaneHead title="Horizon" count={d.reminders.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {d.reminders.map((r) => {
              const p = s.people.find((x) => x.id === r.personId);
              const due = r.dueAt <= s.now;
              const born = r.bornLive && s.now - r.createdAt < 8000;
              return (
                <article
                  key={r.id}
                  className={`card rem-card tk-rem ${due ? 'overdue due' : 'upcoming'}${born ? ' born' : ''}${R.leaving.has(r.id) ? ' leaving' : ''}`}
                >
                  <div className="card-top">
                    <DueChip dueAt={r.dueAt} now={s.now} />
                    {born && <span className="chip-born">just captured</span>}
                  </div>
                  <h3 className="tk-act-title">{r.note}</h3>
                  <div className="tk-act-person">{p?.name ?? '—'}</div>
                  <RemProv s={s} r={r} />
                  <Ops onDone={() => R.depart(r.id, act.remDone)} onSnooze={() => R.depart(r.id, act.remSnooze)} />
                </article>
              );
            })}
            {d.reminders.length === 0 && <Empty>No open reminders{fname ? ` for ${fname}` : ''}.</Empty>}
          </div>
        </section>

        {/* Automations */}
        <section className="pane tk-autos">
          <PaneHead
            title="Playbooks"
            count={s.seqInstances.filter((i) => i.doneAt === null).length}
          />
          <div className="pane-scroll">
            <AutomationsPanel s={s} act={act} />
          </div>
        </section>

        {/* Context */}
        <aside className="pane tk-ctx">
          <PaneHead title="Dossier" count={fname ?? undefined} />
          <div className="pane-scroll">
            <ContextPanel s={s} act={act} />
          </div>
        </aside>
      </main>
    </div>
  );
}
