import { fmtAge } from '../time';
import {
  AutomationsPanel,
  Avatar,
  Burst,
  classifyIntent,
  ContextPanel,
  derive,
  DueChip,
  Empty,
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
import './feed.css';

const KIND_EMOJI: Record<string, string> = { reply: '💬', reminder: '⏰', nudge: '👋' };

export function FeedV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();
  const clear = () => act.focus(null);
  const fname = d.focusPerson?.name ?? null;

  return (
    <div className="v v-feed">
      <header className="fd-top">
        <div className="fd-brand">
          <span className="fd-logo">💧</span>
          <h1>Fluid</h1>
        </div>
        <div className="fd-counters">
          <span className="counter">⚡ <b>{d.c.signalsToday}</b></span>
          <span className="counter">🎯 <b>{d.c.openActions}</b></span>
          <span className={`counter${d.c.remindersDue > 0 ? ' hot' : ''}`}>⏰ <b>{d.c.remindersDue}</b></span>
        </div>
        <div className="fd-ctl">
          <span className={`sim-dot${s.paused ? ' sim-paused' : ''}`} />
          <button className="fd-pause" onClick={act.togglePause}>
            {s.paused ? '▶️ Resume' : '⏸️ Pause'}
          </button>
        </div>
      </header>

      {/* stories rail */}
      <div className="fd-stories">
        <button className={`fd-story${s.focusId === null ? ' on' : ''}`} onClick={clear}>
          <span className="fd-ring fd-ring-all">
            <span className="fd-all">👀</span>
          </span>
          <span className="fd-story-name">Everyone</span>
        </button>
        {d.ranked.map(({ p, heat }) => {
          const on = s.focusId === p.id;
          const temp = tempOf(heat);
          const money = moneyBadge(s, p.id);
          return (
            <button
              key={p.id}
              className={`fd-story temp-${temp.key}${on ? ' on' : ''}`}
              onClick={() => act.focus(on ? null : p.id)}
              title={`${p.name} · ${heat}° ${temp.label}${money ? ` · ${money.label}` : ''}`}
            >
              <span className="fd-ring">
                <Avatar name={p.name} />
                <span className="fd-emoji">{money ? money.emoji : temp.emoji}</span>
                {d.waiting.has(p.id) && <span className="fd-waitdot" />}
              </span>
              <span className="fd-story-name">{p.name.split(' ')[0]}</span>
              <span className="fd-story-heat">{heat}°</span>
            </button>
          );
        })}
        {fname && (
          <button className="fd-clearchip" onClick={clear}>
            ✕ {fname}
          </button>
        )}
      </div>

      <main className="fd-main">
        {/* the feed */}
        <section className="pane fd-feed">
          <div className="pane-scroll fd-feed-scroll">
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
                      className={`card fd-post${fresh ? ' fresh' : ''}${intent ? ` int-${intent}` : ''}`}
                    >
                      {money && fresh && <Burst emojis={['💸', '🎉', '💰', '✨']} />}
                      <div className="fd-post-head">
                        {p && <Avatar name={p.name} />}
                        <div className="fd-post-who">
                          <b>{p?.name ?? '—'}</b>
                          <span className="fd-post-meta">
                            <SourceTag channel={sig.channel} /> · {fmtAge(sig.at, s.now)}
                          </span>
                        </div>
                        {meta && (
                          <span className={`fd-sticker int-${intent}`}>
                            <span className="fd-sticker-emoji">{meta.emoji}</span>
                            {meta.label}
                          </span>
                        )}
                      </div>
                      <p className="fd-post-text">{sig.text}</p>
                      {sig.requiresReply && <span className="fd-needs">💬 needs a reply</span>}
                    </article>
                  );
                })}
              </div>
            ))}
            {d.streams.length === 0 && <Empty>No signals for this filter yet.</Empty>}
          </div>
        </section>

        {/* now (actions) */}
        <section className="pane">
          <PaneHead title="🎯 Now" count={d.actions.length} focusName={fname} onClear={clear} />
          <div className="pane-scroll">
            {d.actions.map((a) => {
              const p = s.people.find((x) => x.id === a.personId);
              const fresh = s.now - a.createdAt < 5000;
              return (
                <article
                  key={a.id}
                  className={`card fd-act kind-${a.kind}${fresh ? ' fresh' : ''}${A.leaving.has(a.id) ? ' leaving' : ''}`}
                >
                  <div className="fd-act-top">
                    <span className="fd-act-emoji">{KIND_EMOJI[a.kind] ?? '🎯'}</span>
                    <div className="fd-act-body">
                      <h3 className="fd-act-title">{a.title}</h3>
                      <div className="fd-act-person">
                        {p?.name ?? '—'} · {fmtAge(a.createdAt, s.now)}
                      </div>
                    </div>
                  </div>
                  <Prov s={s} a={a} />
                  <Ops onDone={() => A.depart(a.id, act.done)} onSnooze={() => A.depart(a.id, act.snooze)} />
                </article>
              );
            })}
            {d.actions.length === 0 && (
              <div className="fd-zero">🌈 All caught up{fname ? ` on ${fname}` : ''}!</div>
            )}
          </div>
        </section>

        {/* later (reminders + automations) */}
        <section className="pane">
          <PaneHead title="⏰ Later" count={d.reminders.length} focusName={fname} onClear={clear} />
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
                  {born && <Burst emojis={['✨', '⏳', '📌']} />}
                  <div className="card-top">
                    <DueChip dueAt={r.dueAt} now={s.now} />
                    {born && <span className="chip-born">✨ new</span>}
                  </div>
                  <h3 className="fd-rem-note">
                    {due ? '🔔 ' : '📌 '}
                    {r.note}
                  </h3>
                  <div className="fd-act-person">{p?.name ?? '—'}</div>
                  <RemProv s={s} r={r} />
                  <Ops onDone={() => R.depart(r.id, act.remDone)} onSnooze={() => R.depart(r.id, act.remSnooze)} />
                </article>
              );
            })}
            {d.reminders.length === 0 && <Empty>Nothing scheduled{fname ? ` for ${fname}` : ''}.</Empty>}

            <div className="fd-autos-head">🤖 Autopilot</div>
            <AutomationsPanel s={s} act={act} />
          </div>
        </section>

        {/* context */}
        <aside className="pane fd-ctx">
          <PaneHead title="👤 Context" count={fname ?? undefined} />
          <div className="pane-scroll">
            <ContextPanel s={s} act={act} />
          </div>
        </aside>
      </main>
    </div>
  );
}
