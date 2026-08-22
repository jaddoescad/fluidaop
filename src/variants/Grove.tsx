import { fmtAge, isOverdue } from '../time';
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
  KIND_LABEL,
  moneyBadge,
  Ops,
  Prov,
  RemProv,
  SourceTag,
  tempOf,
  useDepart,
  VProps,
} from './shared';
import './grove.css';

type Stage = 'hot' | 'warm' | 'cool' | 'cold';

/** A hand-drawn plant whose growth stage is the relationship temperature:
 *  cold = wilting, cool = sprout, warm = bud, hot = full bloom. */
function Plant({ stage }: { stage: Stage }) {
  return (
    <svg className={`plant plant-${stage}`} viewBox="0 0 28 36" width="26" height="34" aria-hidden>
      <path className="plant-ground" d="M5 33.5 Q14 30.8 23 33.5" />
      {stage === 'cold' && (
        <g>
          <path className="plant-stem" d="M14 33 C14 27 14 23 17.5 21 C20.5 19.3 21.5 17.8 21.5 15.5" />
          <path className="plant-leaf" d="M21.5 15.5 Q25.5 19.5 21.8 23.5 Q18.6 19.5 21.5 15.5 Z" />
          <path className="plant-leaf" d="M14 28.5 Q9.5 27.5 8.5 23.5 Q13 25 14 28.5 Z" />
        </g>
      )}
      {stage === 'cool' && (
        <g>
          <path className="plant-stem" d="M14 33 C14 29 14 25.5 14 22" />
          <path className="plant-leaf" d="M14 27 Q8 25.5 7 19.5 Q13.2 21.5 14 27 Z" />
          <path className="plant-leaf" d="M14 24 Q20 22 21 16.5 Q14.8 18.5 14 24 Z" />
        </g>
      )}
      {stage === 'warm' && (
        <g>
          <path className="plant-stem" d="M14 33 C14 27 14 21 14 15" />
          <path className="plant-leaf" d="M14 28 Q7.5 26.5 6.5 20 Q13 22 14 28 Z" />
          <path className="plant-leaf" d="M14 24.5 Q20.5 22.5 21.5 16.5 Q15 18.5 14 24.5 Z" />
          <ellipse className="plant-bud" cx="14" cy="11.5" rx="3.4" ry="4.6" />
          <path className="plant-sepal" d="M11.2 13.6 Q14 17.2 16.8 13.6 Q14 15.8 11.2 13.6 Z" />
        </g>
      )}
      {stage === 'hot' && (
        <g>
          <path className="plant-stem" d="M14 33 C14 27 14 20 14 14.5" />
          <path className="plant-leaf" d="M14 29 Q7 27.5 6 21 Q12.8 23 14 29 Z" />
          <path className="plant-leaf" d="M14 25.5 Q21 23.5 22 17.5 Q15.2 19.5 14 25.5 Z" />
          <g className="plant-flower">
            {[0, 72, 144, 216, 288].map((a) => (
              <ellipse
                key={a}
                className="plant-petal"
                cx="14"
                cy="4.8"
                rx="2.7"
                ry="4.6"
                transform={`rotate(${a} 14 9.5)`}
              />
            ))}
            <circle className="plant-heart" cx="14" cy="9.5" r="2.6" />
          </g>
        </g>
      )}
    </svg>
  );
}

function GroveMark() {
  return (
    <span className="gr-mark" aria-hidden>
      <svg viewBox="0 0 28 28" width="18" height="18">
        <path className="gr-mark-stem" d="M14 24 C14 19 14 16 14 12" />
        <path className="gr-mark-leaf" d="M14 17 Q7.5 15.5 6.5 9 Q13 11 14 17 Z" />
        <path className="gr-mark-leaf" d="M14 14 Q20.5 12 21.5 6 Q15 8 14 14 Z" />
      </svg>
    </span>
  );
}

function Head({
  title,
  gloss,
  count,
  focusName,
  onClear,
}: {
  title: string;
  gloss: string;
  count?: number | string;
  focusName?: string | null;
  onClear?: () => void;
}) {
  return (
    <header className="gr-head">
      <div className="gr-head-row">
        <h2>{title}</h2>
        {count !== undefined && <span className="gr-count-pill">{count}</span>}
        {focusName && onClear && (
          <button className="gr-focus-pill" onClick={onClear} title="Show everyone">
            {focusName} ✕
          </button>
        )}
      </div>
      <p className="gr-gloss">{gloss}</p>
    </header>
  );
}

export function GroveV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();
  const clear = () => act.focus(null);
  const fname = d.focusPerson?.name ?? null;

  return (
    <div className={`v v-grove${s.paused ? ' is-paused' : ''}`}>
      <header className="gr-top">
        <div className="gr-brand">
          <GroveMark />
          <div>
            <b>Fluid</b>
            <span className="gr-brand-sub">Grove · Meridian Painting Co.</span>
          </div>
        </div>

        <div className="gr-counters">
          <span className="gr-count">
            <b>{d.c.signalsToday}</b> signals today
          </span>
          <span className="gr-count">
            <b>{d.c.openActions}</b> to tend
          </span>
          <span className={`gr-count${d.c.remindersDue > 0 ? ' ripe' : ''}`}>
            <b>{d.c.remindersDue}</b> due now
          </span>
        </div>

        <div className="gr-weather">
          <span className="gr-dot" />
          <span className="gr-status">{s.paused ? 'the grove is resting' : 'listening'}</span>
          <button className="gr-pause" onClick={act.togglePause}>
            {s.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      {d.focusPerson && (
        <div className="gr-focusband">
          <span className="gr-focustext">
            Tending to <b>{d.focusPerson.name}</b> — everything below is theirs alone.
          </span>
          <button className="gr-unfocus" onClick={clear}>
            ← Back to the whole grove
          </button>
        </div>
      )}

      <main className="gr-cols">
        {/* People — the grove itself */}
        <section className="pane">
          <Head title="The Grove" gloss="clients, ranked by warmth" count={d.ranked.length} />
          <div className="pane-scroll">
            {d.ranked.map(({ p, heat }) => {
              const focused = s.focusId === p.id;
              const temp = tempOf(heat);
              const money = moneyBadge(s, p.id);
              return (
                <button
                  key={p.id}
                  className={`gr-bed temp-${temp.key}${focused ? ' focused' : ''}`}
                  onClick={() => act.focus(focused ? null : p.id)}
                  title={focused ? 'Show everyone' : `Tend to ${p.name}`}
                >
                  <Plant stage={temp.key} />
                  <span className="gr-bed-main">
                    <span className="gr-bed-name">{p.name}</span>
                    <span className="gr-bed-temp">
                      {temp.label} · <b>{heat}°</b>
                    </span>
                    {(money || d.waiting.has(p.id)) && (
                      <span className="gr-bed-badges">
                        {money && (
                          <em className="gr-money">
                            {money.emoji} {money.label}
                          </em>
                        )}
                        {d.waiting.has(p.id) && <em className="gr-wait">waiting on us</em>}
                      </span>
                    )}
                  </span>
                  <span className="gr-soil">
                    <i style={{ width: `${heat}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Signals */}
        <section className="pane">
          <Head
            title="Signals"
            gloss="what came in, newest first"
            count={d.streams.length}
            focusName={fname}
            onClear={clear}
          />
          <div className="pane-scroll">
            {groupStreamByDay(d.streams, s.now).map((g) => (
              <div key={g.label} className="sday">
                <div className="sday-label">{g.label}</div>
                {g.items.map((sig) => {
                  const p = s.people.find((x) => x.id === sig.personId);
                  const fresh = s.now - sig.at < 5000;
                  const intent = classifyIntent(sig);
                  const meta = intent ? INTENT_META[intent] : null;
                  const money = intent === 'paid' || intent === 'ready';
                  return (
                    <article
                      key={sig.id}
                      className={`card gr-sig${fresh ? ' fresh' : ''}${intent ? ` int-${intent}` : ''}`}
                    >
                      {meta && (
                        <div className={`gr-intent gi-${intent}`}>
                          <i className="gi-dot" />
                          <span>{meta.label}</span>
                        </div>
                      )}
                      {money && fresh && <Burst emojis={['✨', '🌼', '✨']} />}
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
            {d.streams.length === 0 && (
              <Empty>Nothing has landed here yet — the grove is quiet.</Empty>
            )}
          </div>
        </section>

        {/* Actions — obligations */}
        <section className="pane">
          <Head
            title="Tending"
            gloss="what we owe people right now"
            count={d.actions.length}
            focusName={fname}
            onClear={clear}
          />
          <div className="pane-scroll">
            {d.actions.map((a) => {
              const p = s.people.find((x) => x.id === a.personId);
              const fresh = s.now - a.createdAt < 5000;
              return (
                <article
                  key={a.id}
                  className={`card gr-act kind-${a.kind}${fresh ? ' fresh' : ''}${A.leaving.has(a.id) ? ' leaving' : ''}`}
                >
                  <span className={`gr-kind gk-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                  <h3 className="gr-title">{a.title}</h3>
                  <div className="gr-meta">
                    {p?.name ?? '—'} · {fmtAge(a.createdAt, s.now)}
                  </div>
                  <Prov s={s} a={a} />
                  <Ops
                    onDone={() => A.depart(a.id, act.done)}
                    onSnooze={() => A.depart(a.id, act.snooze)}
                  />
                </article>
              );
            })}
            {d.actions.length === 0 && (
              <Empty>Nothing needs your hands{fname ? ` for ${fname}` : ''} — well tended.</Empty>
            )}
          </div>
        </section>

        {/* Reminders — future commitments */}
        <section className="pane">
          <Head
            title="Planted"
            gloss="future commitments, ready when due"
            count={d.reminders.length}
            focusName={fname}
            onClear={clear}
          />
          <div className="pane-scroll">
            {d.reminders.map((r) => {
              const p = s.people.find((x) => x.id === r.personId);
              const due = isOverdue(r.dueAt, s.now);
              const born = r.bornLive && s.now - r.createdAt < 8000;
              return (
                <article
                  key={r.id}
                  className={`card rem-card gr-rem ${due ? 'due overdue' : 'upcoming'}${born ? ' born' : ''}${R.leaving.has(r.id) ? ' leaving' : ''}`}
                >
                  <div className="card-top">
                    <DueChip dueAt={r.dueAt} now={s.now} />
                    {born && <span className="chip-born">just planted</span>}
                  </div>
                  <h3 className="gr-title">{r.note}</h3>
                  <div className="gr-meta">{p?.name ?? '—'}</div>
                  <RemProv s={s} r={r} />
                  <Ops
                    onDone={() => R.depart(r.id, act.remDone)}
                    onSnooze={() => R.depart(r.id, act.remSnooze)}
                  />
                </article>
              );
            })}
            {d.reminders.length === 0 && (
              <Empty>Nothing planted{fname ? ` for ${fname}` : ''} — the beds are clear.</Empty>
            )}
          </div>
        </section>

        {/* Playbooks */}
        <section className="pane">
          <Head
            title="Playbooks"
            gloss="routines that run on their own"
            count={`${s.seqInstances.filter((i) => i.doneAt === null).length} running`}
          />
          <div className="pane-scroll">
            <AutomationsPanel s={s} act={act} />
          </div>
        </section>

        {/* Context */}
        <aside className="pane gr-side">
          <Head title="Field notes" gloss="everything about one person" count={fname ?? undefined} />
          <div className="pane-scroll">
            <ContextPanel s={s} act={act} />
          </div>
        </aside>
      </main>
    </div>
  );
}
