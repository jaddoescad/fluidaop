import { fmtAge } from '../time';
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
  SourceTag,
  useDepart,
  VProps,
} from './shared';
import './console.css';

export function ConsoleV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();
  const clear = () => act.focus(null);
  const fname = d.focusPerson?.name ?? null;

  return (
    <div className="v v-console">
      <header className="con-top">
        <div className="con-brand">
          <span className="con-glyph" />
          <b>FLUID</b>
          <span className="con-sub">signal console — Meridian Painting Co.</span>
        </div>
        <div className="con-counters">
          <span className="counter"><b>{d.c.signalsToday}</b>signals today</span>
          <span className="counter"><b>{d.c.openActions}</b>open actions</span>
          <span className={`counter${d.c.remindersDue > 0 ? ' hot' : ''}`}>
            <b>{d.c.remindersDue}</b>due
          </span>
        </div>
        <div className="con-ctl">
          <span className={`sim-dot${s.paused ? ' sim-paused' : ''}`} />
          <span className="con-sim">{s.paused ? 'PAUSED' : 'LIVE'}</span>
          <button className="con-pause" onClick={act.togglePause}>
            {s.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      <main className="con-cols">
        {/* People */}
        <section className="pane">
          <PaneHead title="People" count={d.ranked.length} />
          {s.focusId && (
            <button className="con-clear" onClick={clear}>
              ✕ clear filter — show everyone
            </button>
          )}
          <div className="pane-scroll">
            {d.ranked.map(({ p, heat }, i) => {
              const focused = s.focusId === p.id;
              return (
                <button
                  key={p.id}
                  className={`con-person${focused ? ' focused' : ''}`}
                  onClick={() => act.focus(focused ? null : p.id)}
                >
                  <span className="con-rank">{String(i + 1).padStart(2, '0')}</span>
                  <span className="con-pname">
                    {p.name}
                    {p.company && <em>{p.company}</em>}
                  </span>
                  {d.waiting.has(p.id) && <span className="con-wait" title="Waiting on us" />}
                  <span className="con-heat">{heat}°</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Streams */}
        <section className="pane">
          <PaneHead title="Streams" count={d.streams.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {groupStreamByDay(d.streams, s.now).map((g) => (
              <div key={g.label} className="sday">
                <div className="sday-label">{g.label}</div>
                {g.items.map((sig) => {
                  const p = s.people.find((x) => x.id === sig.personId);
                  const fresh = s.now - sig.at < 4000;
                  return (
                    <article key={sig.id} className={`card con-sig${fresh ? ' fresh' : ''}`}>
                      <div className="card-top">
                        <span className="card-who">{p?.name ?? '—'}</span>
                        <span className="card-age">{fmtAge(sig.at, s.now)}</span>
                      </div>
                      <div className="card-sub">
                        <SourceTag channel={sig.channel} />
                        {sig.requiresReply && <span className="chip-reply">needs reply</span>}
                      </div>
                      <p className="card-text">{sig.text}</p>
                    </article>
                  );
                })}
              </div>
            ))}
            {d.streams.length === 0 && <Empty>No signals for this filter yet.</Empty>}
          </div>
        </section>

        {/* Actions */}
        <section className="pane">
          <PaneHead title="Actions" count={d.actions.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {d.actions.map((a) => {
              const p = s.people.find((x) => x.id === a.personId);
              const fresh = s.now - a.createdAt < 5000;
              return (
                <article
                  key={a.id}
                  className={`card con-act kind-${a.kind}${fresh ? ' fresh' : ''}${A.leaving.has(a.id) ? ' leaving' : ''}`}
                >
                  <div className="card-top">
                    <span className={`kind-chip kind-chip-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                    <span className="card-age">{fmtAge(a.createdAt, s.now)}</span>
                  </div>
                  <h3 className="con-act-title">{a.title}</h3>
                  <div className="con-act-person">{p?.name ?? '—'}</div>
                  <Prov s={s} a={a} />
                  <Ops onDone={() => A.depart(a.id, act.done)} onSnooze={() => A.depart(a.id, act.snooze)} />
                </article>
              );
            })}
            {d.actions.length === 0 && (
              <Empty>Queue clear{fname ? ` for ${fname}` : ''}. Actions appear when a signal needs a reply, a reminder comes due, or a thread goes quiet.</Empty>
            )}
          </div>
        </section>

        {/* Reminders */}
        <section className="pane">
          <PaneHead title="Reminders" count={d.reminders.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {d.reminders.map((r) => {
              const p = s.people.find((x) => x.id === r.personId);
              const due = r.dueAt <= s.now;
              const born = r.bornLive && s.now - r.createdAt < 8000;
              return (
                <article
                  key={r.id}
                  className={`card rem-card ${due ? 'overdue due' : 'upcoming'}${born ? ' born' : ''}${R.leaving.has(r.id) ? ' leaving' : ''}`}
                >
                  <div className="card-top">
                    <DueChip dueAt={r.dueAt} now={s.now} />
                    {born && <span className="chip-born">just captured</span>}
                  </div>
                  <h3 className="con-rem-note">{r.note}</h3>
                  <div className="con-act-person">{p?.name ?? '—'}</div>
                  <RemProv s={s} r={r} />
                  <Ops onDone={() => R.depart(r.id, act.remDone)} onSnooze={() => R.depart(r.id, act.remSnooze)} />
                </article>
              );
            })}
            {d.reminders.length === 0 && <Empty>No open reminders{fname ? ` for ${fname}` : ''}.</Empty>}
          </div>
        </section>

        {/* Automations */}
        <section className="pane">
          <PaneHead
            title="Automations"
            count={`${s.seqInstances.filter((i) => i.doneAt === null).length} running`}
          />
          <div className="pane-scroll">
            <AutomationsPanel s={s} act={act} />
          </div>
        </section>

        {/* Context */}
        <aside className="pane con-side">
          <PaneHead title="Context" count={d.focusPerson ? d.focusPerson.name : undefined} />
          <div className="pane-scroll">
            <ContextPanel s={s} act={act} />
          </div>
        </aside>
      </main>
    </div>
  );
}
