import { fmtAge } from '../time';
import {
  AutomationsPanel,
  Avatar,
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
import './bloom.css';

export function BloomV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();
  const clear = () => act.focus(null);
  const fname = d.focusPerson?.name ?? null;

  return (
    <div className="v v-bloom">
      <header className="bl-top">
        <div className="bl-brand">
          <span className="bl-logo" />
          <h1>Fluid</h1>
          <span className="bl-sub">every signal becomes a card</span>
        </div>
        <div className="bl-counters">
          <span className="bl-stat">
            <b>{d.c.signalsToday}</b>
            <em>signals today</em>
          </span>
          <span className="bl-stat">
            <b>{d.c.openActions}</b>
            <em>open actions</em>
          </span>
          <span className={`bl-stat${d.c.remindersDue > 0 ? ' hot' : ''}`}>
            <b>{d.c.remindersDue}</b>
            <em>due now</em>
          </span>
        </div>
        <div className="bl-ctl">
          <span className={`sim-dot${s.paused ? ' sim-paused' : ''}`} />
          <button className="bl-pause" onClick={act.togglePause}>
            {s.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      <main className="bl-main">
        {/* People */}
        <section className="pane bl-panel">
          <PaneHead title="People" count={d.ranked.length} />
          {s.focusId && (
            <button className="bl-clear" onClick={clear}>
              ✕ Show everyone
            </button>
          )}
          <div className="pane-scroll">
            {d.ranked.map(({ p, heat }) => {
              const focused = s.focusId === p.id;
              return (
                <button
                  key={p.id}
                  className={`bl-person${focused ? ' focused' : ''}`}
                  onClick={() => act.focus(focused ? null : p.id)}
                >
                  <span className="bl-ava-wrap" style={{ ['--p' as never]: `${heat}` }}>
                    <Avatar name={p.name} />
                  </span>
                  <span className="bl-pcol">
                    <span className="bl-pname">{p.name}</span>
                    <span className="bl-pmeta">
                      {d.waiting.has(p.id) ? (
                        <span className="badge-waiting">waiting on us</span>
                      ) : (
                        <span className="bl-psub">{p.company ?? p.kind}</span>
                      )}
                    </span>
                  </span>
                  <span className="bl-heat">{heat}°</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Streams */}
        <section className="pane bl-panel">
          <PaneHead title="Streams" count={d.streams.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {groupStreamByDay(d.streams, s.now).map((g) => (
              <div key={g.label} className="sday">
                <div className="sday-label">{g.label}</div>
                {g.items.map((sig) => {
                  const p = s.people.find((x) => x.id === sig.personId);
                  const fresh = s.now - sig.at < 4000;
                  return (
                    <article key={sig.id} className={`card bl-sig${fresh ? ' fresh' : ''}`}>
                      <div className="card-top">
                        <span className="card-who">
                          {p && <Avatar name={p.name} />}
                          {p?.name ?? '—'}
                        </span>
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
        <section className="pane bl-panel">
          <PaneHead title="Actions" count={d.actions.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {d.actions.map((a) => {
              const p = s.people.find((x) => x.id === a.personId);
              const fresh = s.now - a.createdAt < 5000;
              return (
                <article
                  key={a.id}
                  className={`card bl-act kind-${a.kind}${fresh ? ' fresh' : ''}${A.leaving.has(a.id) ? ' leaving' : ''}`}
                >
                  <div className="card-top">
                    <span className={`kind-chip kind-chip-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                    <span className="card-age">{fmtAge(a.createdAt, s.now)}</span>
                  </div>
                  <h3 className="bl-act-title">{a.title}</h3>
                  <div className="bl-person-line">
                    {p && <Avatar name={p.name} />}
                    {p?.name ?? '—'}
                  </div>
                  <Prov s={s} a={a} />
                  <Ops onDone={() => A.depart(a.id, act.done)} onSnooze={() => A.depart(a.id, act.snooze)} />
                </article>
              );
            })}
            {d.actions.length === 0 && (
              <div className="bl-zero">
                <span>🌿</span> All clear{fname ? ` for ${fname}` : ''} — nothing waiting on us.
              </div>
            )}
          </div>
        </section>

        {/* Reminders */}
        <section className="pane bl-panel">
          <PaneHead title="Reminders" count={d.reminders.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {d.reminders.map((r) => {
              const p = s.people.find((x) => x.id === r.personId);
              const due = r.dueAt <= s.now;
              const born = r.bornLive && s.now - r.createdAt < 8000;
              return (
                <article
                  key={r.id}
                  className={`card rem-card bl-rem ${due ? 'overdue due' : 'upcoming'}${born ? ' born' : ''}${R.leaving.has(r.id) ? ' leaving' : ''}`}
                >
                  <div className="card-top">
                    <DueChip dueAt={r.dueAt} now={s.now} />
                    {born && <span className="chip-born">just captured</span>}
                  </div>
                  <h3 className="bl-act-title">{r.note}</h3>
                  <div className="bl-person-line">
                    {p && <Avatar name={p.name} />}
                    {p?.name ?? '—'}
                  </div>
                  <RemProv s={s} r={r} />
                  <Ops onDone={() => R.depart(r.id, act.remDone)} onSnooze={() => R.depart(r.id, act.remSnooze)} />
                </article>
              );
            })}
            {d.reminders.length === 0 && <Empty>No open reminders{fname ? ` for ${fname}` : ''}.</Empty>}
          </div>
        </section>

        {/* Automations */}
        <section className="pane bl-panel">
          <PaneHead
            title="Automations"
            count={`${s.seqInstances.filter((i) => i.doneAt === null).length} running`}
          />
          <div className="pane-scroll">
            <AutomationsPanel s={s} act={act} />
          </div>
        </section>

        {/* Context */}
        <aside className="pane bl-panel bl-ctx">
          <PaneHead title="Context" count={fname ?? undefined} />
          <div className="pane-scroll">
            <ContextPanel s={s} act={act} />
          </div>
        </aside>
      </main>
    </div>
  );
}
