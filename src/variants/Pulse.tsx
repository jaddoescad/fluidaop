import { fmtAge } from '../time';
import {
  AutomationsPanel,
  classifyIntent,
  ContextPanel,
  derive,
  DueChip,
  Empty,
  firstNameOf,
  groupStreamByDay,
  INTENT_META,
  moneyBadge,
  Ops,
  PaneHead,
  Prov,
  RemProv,
  SourceTag,
  tempOf,
  useDepart,
  VProps,
} from './shared';
import './pulse.css';

const KIND_EMOJI: Record<string, string> = { reply: '✉️', reminder: '⏰', nudge: '👋' };

export function PulseV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();
  const clear = () => act.focus(null);
  const fname = d.focusPerson?.name ?? null;

  const headlines = s.signals
    .slice()
    .reverse()
    .map((sig) => ({ sig, intent: classifyIntent(sig) }))
    .filter((x) => x.intent !== null && x.intent !== 'ask')
    .slice(0, 8)
    .map(({ sig, intent }) => {
      const meta = INTENT_META[intent as NonNullable<typeof intent>];
      const p = s.people.find((x) => x.id === sig.personId);
      return `${meta.emoji} ${firstNameOf(p?.name ?? '?')} · ${meta.label}`;
    });
  const tickerText = headlines.length > 0 ? headlines.join('  ✦  ') : '📡 listening for signals…';

  return (
    <div className="v v-pulse">
      <header className="pu-top">
        <div className="pu-brand">
          <span className="pu-orb" />
          <b>FLUID</b>
          <span className="pu-sub">pulse · Meridian Painting Co.</span>
        </div>
        <div className="pu-counters">
          <span className="counter">⚡ <b>{d.c.signalsToday}</b> today</span>
          <span className="counter">🎯 <b>{d.c.openActions}</b> open</span>
          <span className={`counter${d.c.remindersDue > 0 ? ' hot' : ''}`}>⏰ <b>{d.c.remindersDue}</b> due</span>
        </div>
        <div className="pu-ctl">
          <span className={`sim-dot${s.paused ? ' sim-paused' : ''}`} />
          <button className="pu-pause" onClick={act.togglePause}>
            {s.paused ? '▶ Resume' : '⏸ Pause'}
          </button>
        </div>
      </header>

      <div className="pu-ticker">
        <div className="pu-ticker-inner">
          <span>{tickerText}</span>
          <span>{tickerText}</span>
        </div>
      </div>

      <main className="pu-cols">
        {/* People */}
        <section className="pane">
          <PaneHead title="🌡️ Leads" count={d.ranked.length} />
          {s.focusId && (
            <button className="pu-clear" onClick={clear}>
              ✕ clear filter
            </button>
          )}
          <div className="pane-scroll">
            {d.ranked.map(({ p, heat }) => {
              const focused = s.focusId === p.id;
              const temp = tempOf(heat);
              const money = moneyBadge(s, p.id);
              return (
                <button
                  key={p.id}
                  className={`pu-person temp-${temp.key}${focused ? ' focused' : ''}`}
                  onClick={() => act.focus(focused ? null : p.id)}
                >
                  <span className="pu-temp">{temp.emoji}</span>
                  <span className="pu-pcol">
                    <span className="pu-pname">{p.name}</span>
                    <span className="pu-pbadges">
                      {money && (
                        <em className="pu-money">
                          {money.emoji} {money.label}
                        </em>
                      )}
                      {d.waiting.has(p.id) && <em className="pu-wait">⚠ waiting on us</em>}
                    </span>
                  </span>
                  <span className="pu-heat">{heat}°</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Streams */}
        <section className="pane">
          <PaneHead title="📡 Streams" count={d.streams.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {groupStreamByDay(d.streams, s.now).map((g) => (
              <div key={g.label} className="sday">
                <div className="sday-label">{g.label}</div>
                {g.items.map((sig) => {
                  const p = s.people.find((x) => x.id === sig.personId);
                  const fresh = s.now - sig.at < 4000;
                  const intent = classifyIntent(sig);
                  const meta = intent ? INTENT_META[intent] : null;
                  return (
                    <article
                      key={sig.id}
                      className={`card pu-sig${fresh ? ' fresh' : ''}${intent ? ` int-${intent}` : ''}`}
                    >
                      {meta && (
                        <div className={`pu-intent int-${intent}`}>
                          <span className="pu-intent-emoji">{meta.emoji}</span>
                          {meta.label}
                        </div>
                      )}
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
          <PaneHead title="🎯 Actions" count={d.actions.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {d.actions.map((a) => {
              const p = s.people.find((x) => x.id === a.personId);
              const fresh = s.now - a.createdAt < 5000;
              return (
                <article
                  key={a.id}
                  className={`card pu-act kind-${a.kind}${fresh ? ' fresh' : ''}${A.leaving.has(a.id) ? ' leaving' : ''}`}
                >
                  <div className="pu-act-row">
                    <span className="pu-act-emoji">{KIND_EMOJI[a.kind] ?? '🎯'}</span>
                    <div className="pu-act-body">
                      <h3 className="pu-act-title">{a.title}</h3>
                      <div className="pu-act-person">
                        {p?.name ?? '—'} · {fmtAge(a.createdAt, s.now)}
                      </div>
                      <Prov s={s} a={a} />
                    </div>
                  </div>
                  <Ops onDone={() => A.depart(a.id, act.done)} onSnooze={() => A.depart(a.id, act.snooze)} />
                </article>
              );
            })}
            {d.actions.length === 0 && <Empty>😎 Nothing waiting on us{fname ? ` for ${fname}` : ''}.</Empty>}
          </div>
        </section>

        {/* Reminders */}
        <section className="pane">
          <PaneHead title="⏰ Reminders" count={d.reminders.length} focusName={fname} onClear={clear} />
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
                    {born && <span className="chip-born">✨ just captured</span>}
                  </div>
                  <h3 className="pu-rem-note">
                    {due ? '🔔 ' : ''}
                    {r.note}
                  </h3>
                  <div className="pu-act-person">{p?.name ?? '—'}</div>
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
          <PaneHead title="🤖 Autopilot" count={`${s.seqInstances.filter((i) => i.doneAt === null).length} running`} />
          <div className="pane-scroll">
            <AutomationsPanel s={s} act={act} />
          </div>
        </section>

        {/* Context */}
        <aside className="pane pu-side">
          <PaneHead title="👤 Context" count={fname ?? undefined} />
          <div className="pane-scroll">
            <ContextPanel s={s} act={act} />
          </div>
        </aside>
      </main>
    </div>
  );
}
