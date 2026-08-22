import { fmtAge, fmtClock, MIN } from '../time';
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
  KIND_LABEL,
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
import './tower.css';

/**
 * Heat (0–100) → orbit radius as % of scope radius, hot near the center.
 * Piecewise so the band boundaries land exactly on the painted rings
 * (25 / 50 / 75 / 94), which are labeled with the tempOf zone words.
 */
function orbitOf(heat: number): number {
  const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));
  if (heat >= 55) return lerp(25, 9, (heat - 55) / 45);
  if (heat >= 25) return lerp(50, 25, (heat - 25) / 30);
  if (heat >= 10) return lerp(75, 50, (heat - 10) / 15);
  return lerp(94, 75, heat / 10);
}

/** Ring band midpoints (in % of scope radius) with their zone words. */
const ZONES = [
  { r: 17, label: 'hot' },
  { r: 37.5, label: 'warm' },
  { r: 62.5, label: 'cooling' },
  { r: 84.5, label: 'cold' },
];

export function TowerV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();
  const clear = () => act.focus(null);
  const fname = d.focusPerson?.name ?? null;

  // Stable bearing per person: evenly spread by seed order (s.people never re-sorts),
  // so blips hold their heading and only travel in/out with heat.
  const bearing = new Map<string, number>();
  s.people.forEach((p, i) => bearing.set(p.id, (i / Math.max(1, s.people.length)) * 360 + 205));

  // Latest inbound signal per person — powers the radar ping on fresh contact.
  const lastAt = new Map<string, number>();
  for (const sig of s.signals) lastAt.set(sig.personId, sig.at);

  // Longest-waiting obligation is closest to the runway (top of the pane).
  const approach = d.actions.slice().sort((a, b) => a.createdAt - b.createdAt);

  const overdueRems = d.reminders.filter((r) => r.dueAt <= s.now);
  const upcomingRems = d.reminders.filter((r) => r.dueAt > s.now);
  const runningCount = s.seqInstances.filter((i) => i.doneAt === null).length;

  return (
    <div className="v v-tower">
      {/* ---------- top bar ---------- */}
      <header className="tw-top">
        <div className="tw-brand">
          <span className={`tw-beacon${s.paused ? ' held' : ''}`}>
            <i />
          </span>
          <div className="tw-brand-t">
            <b>FLUID TOWER</b>
            <span>Meridian Painting Co. · signal control</span>
          </div>
        </div>
        <div className="tw-clock">{fmtClock(s.now)}</div>
        <div className="tw-readouts">
          <div className="tw-read">
            <b>{d.c.signalsToday}</b>
            <span>signals today</span>
          </div>
          <div className="tw-read">
            <b>{d.c.openActions}</b>
            <span>open actions</span>
          </div>
          <div className={`tw-read${d.c.remindersDue > 0 ? ' alert' : ''}`}>
            <b>{d.c.remindersDue}</b>
            <span>reminders due</span>
          </div>
        </div>
        <div className="tw-ctl">
          <span className={`tw-live${s.paused ? ' held' : ''}`}>
            <i />
            {s.paused ? 'holding' : 'live'}
          </span>
          <button className="tw-pause" onClick={act.togglePause}>
            {s.paused ? 'Resume feed' : 'Pause feed'}
          </button>
        </div>
      </header>

      {/* ---------- tracking banner (focus mode) ---------- */}
      {d.focusPerson && (
        <div className="tw-track" role="status">
          <span className="tw-track-ping" />
          <span className="tw-track-txt">
            Tracking <b>{d.focusPerson.name}</b> — every panel is filtered to this client
          </span>
          <button className="tw-track-back" onClick={clear}>
            ✕ Return to full scope
          </button>
        </div>
      )}

      <main className="tw-main">
        {/* ---------- inbound transmissions ---------- */}
        <section className="pane tw-col tw-inbound">
          <PaneHead title="Inbound" count={d.streams.length} focusName={fname} onClear={clear} />
          <div className="tw-hint">every client message, newest first — read the banner for what it means</div>
          <div className="pane-scroll">
            {groupStreamByDay(d.streams, s.now).map((g) => (
              <div key={g.label} className="sday">
                <div className="sday-label">{g.label}</div>
                {g.items.map((sig) => {
                  const p = s.people.find((x) => x.id === sig.personId);
                  const fresh = s.now - sig.at < 5000;
                  const intent = classifyIntent(sig);
                  const meta = intent ? INTENT_META[intent] : null;
                  return (
                    <article
                      key={sig.id}
                      className={`card tw-sig${fresh ? ' fresh' : ''}${intent ? ` int-${intent}` : ''}`}
                    >
                      {meta && (
                        <div className={`tw-intent int-${intent}`}>
                          <span className="tw-intent-mark">{meta.emoji}</span>
                          {meta.label}
                        </div>
                      )}
                      <div className="card-top">
                        <span className="card-who">{p?.name ?? '—'}</span>
                        <span className="card-age">
                          {fmtClock(sig.at)} · {fmtAge(sig.at, s.now)}
                        </span>
                      </div>
                      <div className="card-sub">
                        <SourceTag channel={sig.channel} />
                        {sig.requiresReply && <span className="chip-reply">needs reply</span>}
                      </div>
                      <p className="card-text">“{sig.text}”</p>
                    </article>
                  );
                })}
              </div>
            ))}
            {d.streams.length === 0 && <Empty>Quiet frequency — no transmissions for this filter yet.</Empty>}
          </div>
        </section>

        {/* ---------- center: scope + approach/departures ---------- */}
        <div className="tw-center">
          <section className="tw-scope-panel">
            <header className="tw-scope-head">
              <h2>Scope</h2>
              <span className="tw-hint">
                every client on radar — closer to the office means a hotter relationship · click a blip or strip to
                isolate
              </span>
            </header>
            <div className="tw-scope-body">
              <div className={`tw-scope${s.paused ? ' held' : ''}`}>
                <div className="tw-sweep" />
                <i className="tw-axis tw-axis-h" />
                <i className="tw-axis tw-axis-v" />
                {[3, 12.5, 25, 37.5].map((inset) => (
                  <i key={inset} className="tw-ring" style={{ inset: `${inset}%` }} />
                ))}
                {ZONES.map((z) => (
                  <span key={z.label} className="tw-zone-word" style={{ top: `${50 - z.r / 2}%` }}>
                    {z.label}
                  </span>
                ))}
                <span className="tw-office">
                  <i />
                  office
                </span>
                {s.paused && <span className="tw-scope-hold">feed held</span>}
                {d.ranked.map(({ p, heat }) => {
                  const temp = tempOf(heat);
                  const money = moneyBadge(s, p.id);
                  const waiting = d.waiting.has(p.id);
                  const ang = ((bearing.get(p.id) ?? 0) * Math.PI) / 180;
                  const r = orbitOf(heat);
                  const left = 50 + (r / 2) * Math.cos(ang);
                  const top = 50 + (r / 2) * Math.sin(ang);
                  const fresh = s.now - (lastAt.get(p.id) ?? 0) < 6000;
                  const focused = s.focusId === p.id;
                  const dimmed = s.focusId !== null && !focused;
                  return (
                    <button
                      key={p.id}
                      className={`tw-blip temp-${temp.key}${left > 55 ? ' tag-left' : ''}${
                        focused ? ' on' : ''
                      }${dimmed ? ' dim' : ''}`}
                      style={{ left: `${left}%`, top: `${top}%` }}
                      onClick={() => act.focus(focused ? null : p.id)}
                      title={`${p.name} — ${temp.label}, heat ${heat}°`}
                    >
                      <i className="tw-blip-dot" />
                      {fresh && <i className="tw-blip-ping" />}
                      <span className="tw-blip-tag">
                        <b>
                          {firstNameOf(p.name)} <i>{heat}°</i>
                        </b>
                        {money && <u className="tw-money">{money.label}</u>}
                        {waiting && <u className="tw-wait">waiting on us</u>}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="tw-rack">
                <div className="tw-rack-h">Strip rack · ranked by heat</div>
                {d.ranked.map(({ p, heat }, i) => {
                  const temp = tempOf(heat);
                  const money = moneyBadge(s, p.id);
                  const waiting = d.waiting.has(p.id);
                  const focused = s.focusId === p.id;
                  return (
                    <button
                      key={p.id}
                      className={`tw-strip temp-${temp.key}${focused ? ' on' : ''}`}
                      onClick={() => act.focus(focused ? null : p.id)}
                    >
                      <span className="tw-strip-rank">{String(i + 1).padStart(2, '0')}</span>
                      <span className="tw-strip-main">
                        <b>{p.name}</b>
                        <span className="tw-strip-badges">
                          <em className="tw-temp">{temp.label}</em>
                          {money && <em className="tw-money">{money.label}</em>}
                          {waiting && <em className="tw-wait">waiting on us</em>}
                        </span>
                      </span>
                      <span className="tw-strip-heat">{heat}°</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <div className="tw-lower">
            {/* ---------- on approach: open obligations ---------- */}
            <section className="pane tw-col tw-appr-pane">
              <PaneHead title="On approach" count={approach.length} focusName={fname} onClear={clear} />
              <div className="tw-hint">what we owe people — the longest-waiting is next to land, top of the stack</div>
              <div className="pane-scroll">
                {approach.map((a) => {
                  const p = s.people.find((x) => x.id === a.personId);
                  const fresh = s.now - a.createdAt < 5000;
                  const prog = Math.min(1, (s.now - a.createdAt) / (30 * MIN));
                  return (
                    <article
                      key={a.id}
                      className={`card tw-appr kind-${a.kind}${fresh ? ' fresh' : ''}${
                        A.leaving.has(a.id) ? ' leaving landing' : ''
                      }`}
                    >
                      <div className="tw-glide" aria-hidden>
                        <i className="tw-thresh" />
                        <i className="tw-plane" style={{ left: `${6 + prog * 80}%` }} />
                      </div>
                      <div className="card-top">
                        <span className={`kind-chip kind-chip-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                        <span className="card-age">{fmtAge(a.createdAt, s.now)}</span>
                      </div>
                      <h3 className="tw-title">{a.title}</h3>
                      <div className="tw-who">{p?.name ?? '—'}</div>
                      <Prov s={s} a={a} />
                      <Ops onDone={() => A.depart(a.id, act.done)} onSnooze={() => A.depart(a.id, act.snooze)} />
                    </article>
                  );
                })}
                {approach.length === 0 && (
                  <Empty>Approach is clear — nothing waiting on us{fname ? ` for ${fname}` : ''}.</Empty>
                )}
              </div>
            </section>

            {/* ---------- departures: future commitments ---------- */}
            <section className="pane tw-col tw-dep-pane">
              <PaneHead title="Departures" count={d.reminders.length} focusName={fname} onClear={clear} />
              <div className="tw-hint">promised follow-ups on a time rail — anything above the now-line is overdue</div>
              <div className="pane-scroll">
                <div className="tw-tl">
                  {overdueRems.length > 0 && (
                    <div className="tw-pastzone">
                      <div className="tw-zone-h">past the line — overdue</div>
                      {overdueRems.map((r) => {
                        const p = s.people.find((x) => x.id === r.personId);
                        return (
                          <article
                            key={r.id}
                            className={`card rem-card tw-dep overdue${R.leaving.has(r.id) ? ' leaving' : ''}`}
                          >
                            <div className="card-top">
                              <DueChip dueAt={r.dueAt} now={s.now} />
                            </div>
                            <h3 className="tw-title">{r.note}</h3>
                            <div className="tw-who">{p?.name ?? '—'}</div>
                            <RemProv s={s} r={r} />
                            <Ops
                              onDone={() => R.depart(r.id, act.remDone)}
                              onSnooze={() => R.depart(r.id, act.remSnooze)}
                            />
                          </article>
                        );
                      })}
                    </div>
                  )}
                  <div className="tw-nowline">
                    <span>now · {fmtClock(s.now)}</span>
                  </div>
                  {upcomingRems.map((r, i) => {
                    const p = s.people.find((x) => x.id === r.personId);
                    const born = r.bornLive && s.now - r.createdAt < 8000;
                    const prev = i === 0 ? s.now : upcomingRems[i - 1].dueAt;
                    const gapMin = Math.max(0, (r.dueAt - prev) / MIN);
                    const lead = Math.min(34, Math.round(gapMin * 0.4));
                    return (
                      <article
                        key={r.id}
                        className={`card rem-card tw-dep upcoming${born ? ' born' : ''}${
                          R.leaving.has(r.id) ? ' leaving' : ''
                        }`}
                        style={{ marginTop: lead }}
                      >
                        <div className="card-top">
                          <DueChip dueAt={r.dueAt} now={s.now} />
                          {born && <span className="chip-born">just captured</span>}
                        </div>
                        <h3 className="tw-title">{r.note}</h3>
                        <div className="tw-who">{p?.name ?? '—'}</div>
                        <RemProv s={s} r={r} />
                        <Ops
                          onDone={() => R.depart(r.id, act.remDone)}
                          onSnooze={() => R.depart(r.id, act.remSnooze)}
                        />
                      </article>
                    );
                  })}
                  {upcomingRems.length === 0 && (
                    <Empty>Nothing scheduled ahead{fname ? ` for ${fname}` : ''}.</Empty>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* ---------- flight plans: playbooks ---------- */}
        <section className="pane tw-col tw-plans">
          <PaneHead title="Flight plans" count={`${runningCount} running`} />
          <div className="tw-hint">scheduled outreach that flies itself — pause any plan and it truly stops</div>
          <div className="pane-scroll">
            <AutomationsPanel s={s} act={act} />
          </div>
        </section>

        {/* ---------- tower file: focused-person context ---------- */}
        <aside className="pane tw-col tw-file">
          <PaneHead title="Tower file" count={fname ?? 'no one tracked'} />
          <div className="pane-scroll">
            <ContextPanel s={s} act={act} />
          </div>
        </aside>
      </main>
    </div>
  );
}
