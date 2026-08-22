import { fmtAge } from '../time';
import {
  AutomationsPanel,
  Burst,
  classifyIntent,
  ContextPanel,
  derive,
  DueChip,
  Empty,
  groupStreamByDay,
  INTENT_META,
  moneyBadge,
  PaneHead,
  Prov,
  RemProv,
  SourceTag,
  tempOf,
  useDepart,
  VProps,
} from './shared';
import './arcade.css';

const KIND_EMOJI: Record<string, string> = { reply: '📨', reminder: '⏰', nudge: '👋' };
const MEDALS = ['🥇', '🥈', '🥉'];

export function ArcadeV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();
  const clear = () => act.focus(null);
  const fname = d.focusPerson?.name ?? null;

  return (
    <div className="v v-arcade">
      <header className="ar-top">
        <div className="ar-brand">
          <span className="ar-coin">🪙</span>
          <b>FLUID</b>
          <span className="ar-sub">ARCADE MODE</span>
        </div>
        <div className="ar-counters">
          <span className="ar-stat">
            ⚡ <b>{d.c.signalsToday}</b> <em>signals</em>
          </span>
          <span className="ar-stat">
            ⚔️ <b>{d.c.openActions}</b> <em>quests</em>
          </span>
          <span className={`ar-stat${d.c.remindersDue > 0 ? ' hot' : ''}`}>
            ⏰ <b>{d.c.remindersDue}</b> <em>due</em>
          </span>
        </div>
        <div className="ar-ctl">
          <span className={`sim-dot${s.paused ? ' sim-paused' : ''}`} />
          <button className="ar-pause" onClick={act.togglePause}>
            {s.paused ? '▶️ PLAY' : '⏸️ PAUSE'}
          </button>
        </div>
      </header>

      <main className="ar-cols">
        {/* leaderboard */}
        <section className="pane">
          <PaneHead title="🏆 Leaderboard" />
          {s.focusId && (
            <button className="ar-clear" onClick={clear}>
              ✕ SHOW ALL
            </button>
          )}
          <div className="pane-scroll">
            {d.ranked.map(({ p, heat }, i) => {
              const focused = s.focusId === p.id;
              const temp = tempOf(heat);
              const money = moneyBadge(s, p.id);
              return (
                <button
                  key={p.id}
                  className={`ar-player temp-${temp.key}${focused ? ' focused' : ''}`}
                  onClick={() => act.focus(focused ? null : p.id)}
                >
                  <span className="ar-rank">{MEDALS[i] ?? `#${i + 1}`}</span>
                  <span className="ar-pcol">
                    <span className="ar-pname">{p.name}</span>
                    <span className="ar-pbadges">
                      <em className={`ar-temp temp-${temp.key}`}>
                        {temp.emoji} {temp.label}
                      </em>
                      {money && (
                        <em className="ar-money">
                          {money.emoji} {money.label}
                        </em>
                      )}
                    </span>
                  </span>
                  <span className="ar-score">
                    {heat}°{d.waiting.has(p.id) ? ' ❗' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* incoming */}
        <section className="pane">
          <PaneHead title="📡 Incoming" count={d.streams.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {groupStreamByDay(d.streams, s.now).map((g) => (
              <div key={g.label} className="sday">
                <div className="sday-label">{g.label}</div>
                {g.items.map((sig) => {
                  const p = s.people.find((x) => x.id === sig.personId);
                  const fresh = s.now - sig.at < 4000;
                  const intent = classifyIntent(sig);
                  const meta = intent ? INTENT_META[intent] : null;
                  const money = intent === 'ready' || intent === 'paid';
                  return (
                    <article
                      key={sig.id}
                      className={`card ar-sig${fresh ? ' fresh' : ''}${intent ? ` int-${intent}` : ''}`}
                    >
                      {money && fresh && <Burst emojis={['🪙', '💰', '✨', '🎉']} />}
                      <div className="ar-sig-row">
                        <span className="ar-sig-emoji">{meta ? meta.emoji : '📥'}</span>
                        <div className="ar-sig-body">
                          <div className="card-top">
                            <span className="card-who">{p?.name ?? '—'}</span>
                            <span className="card-age">{fmtAge(sig.at, s.now)}</span>
                          </div>
                          {meta && <span className={`ar-tag int-${intent}`}>{meta.label}</span>}
                          <p className="card-text">{sig.text}</p>
                          <div className="card-sub">
                            <SourceTag channel={sig.channel} />
                            {sig.requiresReply && <span className="chip-reply">reply!</span>}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ))}
            {d.streams.length === 0 && <Empty>No signals for this filter yet.</Empty>}
          </div>
        </section>

        {/* quests */}
        <section className="pane">
          <PaneHead title="⚔️ Quests" count={d.actions.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {d.actions.map((a) => {
              const p = s.people.find((x) => x.id === a.personId);
              const fresh = s.now - a.createdAt < 5000;
              return (
                <article
                  key={a.id}
                  className={`card ar-quest kind-${a.kind}${fresh ? ' fresh' : ''}${A.leaving.has(a.id) ? ' leaving' : ''}`}
                >
                  <div className="ar-quest-top">
                    <span className="ar-quest-emoji">{KIND_EMOJI[a.kind] ?? '⚔️'}</span>
                    <div className="ar-quest-body">
                      <h3 className="ar-quest-title">{a.title}</h3>
                      <div className="ar-quest-person">
                        {p?.name ?? '—'} · {fmtAge(a.createdAt, s.now)}
                      </div>
                    </div>
                  </div>
                  <Prov s={s} a={a} />
                  <div className="ar-btns">
                    <button className="ar-btn ar-btn-done" onClick={() => A.depart(a.id, act.done)}>
                      ✅ DONE
                    </button>
                    <button className="ar-btn ar-btn-zzz" onClick={() => A.depart(a.id, act.snooze)}>
                      💤 45s
                    </button>
                  </div>
                </article>
              );
            })}
            {d.actions.length === 0 && (
              <div className="ar-zero">🏅 QUEST BOARD CLEAR{fname ? ` — ${fname.toUpperCase()}` : ''}!</div>
            )}
          </div>
        </section>

        {/* timers */}
        <section className="pane">
          <PaneHead title="⏰ Timers" count={d.reminders.length} focusName={fname} onClear={clear} />
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
                  {born && <Burst emojis={['✨', '⏳', '🔮']} />}
                  <div className="card-top">
                    <DueChip dueAt={r.dueAt} now={s.now} />
                    {born && <span className="chip-born">✨ spawned</span>}
                  </div>
                  <h3 className="ar-rem-note">
                    {due ? '🚨 ' : '⏳ '}
                    {r.note}
                  </h3>
                  <div className="ar-quest-person">{p?.name ?? '—'}</div>
                  <RemProv s={s} r={r} />
                  <div className="ar-btns">
                    <button className="ar-btn ar-btn-done" onClick={() => R.depart(r.id, act.remDone)}>
                      ✅ DONE
                    </button>
                    <button className="ar-btn ar-btn-zzz" onClick={() => R.depart(r.id, act.remSnooze)}>
                      💤 45s
                    </button>
                  </div>
                </article>
              );
            })}
            {d.reminders.length === 0 && <Empty>No timers running{fname ? ` for ${fname}` : ''}.</Empty>}
          </div>
        </section>

        {/* bots */}
        <section className="pane">
          <PaneHead title="🤖 Bots" count={`${s.seqInstances.filter((i) => i.doneAt === null).length} live`} />
          <div className="pane-scroll">
            <AutomationsPanel s={s} act={act} />
          </div>
        </section>

        {/* dossier */}
        <aside className="pane ar-side">
          <PaneHead title="📇 Dossier" count={fname ?? undefined} />
          <div className="pane-scroll">
            <ContextPanel s={s} act={act} />
          </div>
        </aside>
      </main>
    </div>
  );
}
