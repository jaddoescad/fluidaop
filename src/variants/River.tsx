import { ReactNode, useState } from 'react';
import { fmtAge, isOverdue } from '../time';
import { Reminder } from '../types';
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
  Prov,
  RemProv,
  SourceTag,
  tempOf,
  useDepart,
  VProps,
} from './shared';
import './river.css';

type Depart = ReturnType<typeof useDepart>;

/** One reach of the river: station sign, flowing surface, then the pool itself. */
function Stage({
  title,
  sub,
  count,
  elev,
  surge,
  children,
}: {
  title: string;
  sub: string;
  count?: number | string;
  elev: number;
  surge?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="rv-stage" style={{ marginTop: elev }}>
      <header className="rv-station">
        <div className="rv-station-row">
          <h2>{title}</h2>
          {count !== undefined && <span className="rv-count">{count}</span>}
        </div>
        <p className="rv-sub">{sub}</p>
      </header>
      <div className={`rv-surface${surge ? ' surge' : ''}`} aria-hidden />
      <div className="rv-pool">
        <div className="rv-pool-scroll">{children}</div>
      </div>
    </section>
  );
}

export function RiverV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();

  // Which way a departing card leaves: Done flows on downstream, Snooze sinks into an eddy.
  const [verbs, setVerbs] = useState<Record<string, 'done' | 'snooze'>>({});
  const go = (D: Depart, id: string, verb: 'done' | 'snooze', fn: (id: string) => void) => {
    setVerbs((m) => ({ ...m, [id]: verb }));
    D.depart(id, fn);
  };
  const leaveCls = (D: Depart, id: string) =>
    D.leaving.has(id) ? ` leaving leave-${verbs[id] ?? 'done'}` : '';

  const fname = d.focusPerson?.name ?? null;
  const surge = d.streams.length > 0 && s.now - d.streams[0].at < 4000;
  const dueNow = d.reminders.filter((r) => isOverdue(r.dueAt, s.now));
  const later = d.reminders.filter((r) => !isOverdue(r.dueAt, s.now));
  const runningSeqs = s.seqInstances.filter((i) => i.doneAt === null).length;

  const remCard = (r: Reminder) => {
    const p = s.people.find((x) => x.id === r.personId);
    const over = isOverdue(r.dueAt, s.now);
    const born = r.bornLive && s.now - r.createdAt < 8000;
    return (
      <article
        key={r.id}
        className={`card rv-rem ${over ? 'breaching' : 'held'}${born ? ' born' : ''}${leaveCls(R, r.id)}`}
      >
        <div className="rv-row">
          <DueChip dueAt={r.dueAt} now={s.now} />
          {born && <span className="rv-chip rv-born">just captured</span>}
        </div>
        <h3 className="rv-title">{r.note}</h3>
        <div className="rv-wholine">{p?.name ?? '—'}</div>
        <RemProv s={s} r={r} />
        <Ops
          onDone={() => go(R, r.id, 'done', act.remDone)}
          onSnooze={() => go(R, r.id, 'snooze', act.remSnooze)}
        />
      </article>
    );
  };

  return (
    <div className={`v-river${s.paused ? ' is-paused' : ''}`}>
      {/* gauging station */}
      <header className="rv-top">
        <div className="rv-brand">
          <span className="rv-mark" aria-hidden />
          <b>FLUID</b>
          <em className="rv-tag">river</em>
          <span className="rv-motto">every signal, one stream · Meridian Painting Co.</span>
        </div>
        <div className="rv-gauges">
          <span className="rv-gauge">
            <b>{d.c.signalsToday}</b> signals today
          </span>
          <span className="rv-gauge">
            <b>{d.c.openActions}</b> open actions
          </span>
          <span className={`rv-gauge${d.c.remindersDue > 0 ? ' alert' : ''}`}>
            <b>{d.c.remindersDue}</b> reminders due
          </span>
        </div>
        <div className="rv-flowstate">
          <span className="rv-current-dot" aria-hidden />
          <em className="rv-flowword">{s.paused ? 'the river is still' : 'the river is flowing'}</em>
          <button className="rv-pause" onClick={act.togglePause}>
            {s.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      {d.focusPerson && (
        <div className="rv-focusband">
          <span className="rv-focustext">
            Following <b>{d.focusPerson.name}</b> — every pool below carries only their water.
          </span>
          <button className="rv-back" onClick={() => act.focus(null)}>
            ✕ Back to the whole river
          </button>
        </div>
      )}

      <main className="rv-main">
        {/* tributaries: the people feeding the river */}
        <aside className={`rv-rail${s.focusId ? ' has-focus' : ''}`}>
          <header className="rv-station rv-rail-head">
            <div className="rv-station-row">
              <h2>Tributaries</h2>
              <span className="rv-count">{d.ranked.length}</span>
            </div>
            <p className="rv-sub">every client feeding the river, ranked by heat</p>
          </header>
          <div className="rv-rail-scroll">
            {d.ranked.map(({ p, heat }) => {
              const temp = tempOf(heat);
              const money = moneyBadge(s, p.id);
              const focused = s.focusId === p.id;
              return (
                <button
                  key={p.id}
                  className={`rv-trib t-${temp.key}${focused ? ' focused' : ''}`}
                  onClick={() => act.focus(focused ? null : p.id)}
                  title={focused ? 'Stop following' : `Follow ${p.name} through the whole river`}
                >
                  <span className="rv-trib-top">
                    <span className="rv-trib-name">{p.name}</span>
                    <span className="rv-deg">{heat}°</span>
                  </span>
                  <span className="rv-trib-co">
                    {p.company ? `${p.company} · ` : ''}
                    {p.kind}
                  </span>
                  <span className="rv-trib-meta">
                    <em className="rv-temp">
                      {temp.emoji} {temp.label}
                    </em>
                    {money && (
                      <em className="rv-chip rv-money">
                        {money.emoji} {money.label}
                      </em>
                    )}
                    {d.waiting.has(p.id) && <em className="rv-chip rv-wait">waiting on us</em>}
                    {focused && <em className="rv-chip rv-follow">following</em>}
                  </span>
                  <i
                    className="rv-trib-stream"
                    style={{ height: Math.max(2, Math.round(heat / 11)) }}
                    aria-hidden
                  />
                </button>
              );
            })}
          </div>
        </aside>

        {/* the river itself, descending left to right */}
        <div className="rv-stages">
          <Stage
            title="Headwaters"
            sub="raw inbound, read for meaning as it lands"
            count={d.streams.length}
            elev={0}
            surge={surge}
          >
            {groupStreamByDay(d.streams, s.now).map((g) => (
              <div key={g.label} className="rv-day">
                <div className="rv-mile">
                  <i aria-hidden />
                  {g.label}
                </div>
                {g.items.map((sig) => {
                  const p = s.people.find((x) => x.id === sig.personId);
                  const intent = classifyIntent(sig);
                  const meta = intent ? INTENT_META[intent] : null;
                  const fresh = s.now - sig.at < 5000;
                  return (
                    <article
                      key={sig.id}
                      className={`card rv-sig${intent ? ` int-${intent}` : ''}${fresh ? ' fresh' : ''}`}
                    >
                      {meta && (
                        <div className={`rv-read int-${intent}`}>
                          <span className="rv-read-emoji">{meta.emoji}</span>
                          <span className="rv-read-label">{meta.label}</span>
                        </div>
                      )}
                      <div className="rv-row">
                        <span className="rv-who">{p?.name ?? '—'}</span>
                        <span className="rv-age">{fmtAge(sig.at, s.now)}</span>
                      </div>
                      <div className="rv-srcline">
                        <SourceTag channel={sig.channel} />
                        {sig.requiresReply && <span className="rv-reply">needs a reply</span>}
                      </div>
                      <p className="rv-text">{sig.text}</p>
                    </article>
                  );
                })}
              </div>
            ))}
            {d.streams.length === 0 && (
              <Empty>The water is clear — no signals{fname ? ` from ${firstNameOf(fname)}` : ''} yet.</Empty>
            )}
          </Stage>

          <Stage
            title="The Weir"
            sub="obligations caught for a human — they cannot flow past"
            count={d.actions.length}
            elev={18}
          >
            {d.actions.map((a) => {
              const p = s.people.find((x) => x.id === a.personId);
              const fresh = s.now - a.createdAt < 5000;
              return (
                <article
                  key={a.id}
                  className={`card rv-act k-${a.kind}${fresh ? ' fresh' : ''}${leaveCls(A, a.id)}`}
                >
                  <div className="rv-row">
                    <span className={`rv-kind k-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                    <span className="rv-age">{fmtAge(a.createdAt, s.now)}</span>
                  </div>
                  <h3 className="rv-title">{a.title}</h3>
                  <div className="rv-wholine">{p?.name ?? '—'}</div>
                  <Prov s={s} a={a} />
                  <Ops
                    onDone={() => go(A, a.id, 'done', act.done)}
                    onSnooze={() => go(A, a.id, 'snooze', act.snooze)}
                  />
                </article>
              );
            })}
            {d.actions.length === 0 && (
              <Empty>Nothing caught — the current runs clean{fname ? ` for ${firstNameOf(fname)}` : ''}.</Empty>
            )}
          </Stage>

          <Stage
            title="Stillwater"
            sub="commitments held for later, released when due"
            count={d.reminders.length}
            elev={36}
          >
            {dueNow.length > 0 && <div className="rv-flag rv-flag-due">Breaching — due now</div>}
            {dueNow.map(remCard)}
            {later.length > 0 && <div className="rv-flag">Held for later</div>}
            {later.map(remCard)}
            {d.reminders.length === 0 && (
              <Empty>Still water — nothing held{fname ? ` for ${firstNameOf(fname)}` : ''}.</Empty>
            )}
          </Stage>

          <Stage
            title="The Canals"
            sub="playbooks carrying follow-through on their own"
            count={`${runningSeqs} running`}
            elev={54}
          >
            <AutomationsPanel s={s} act={act} />
          </Stage>

          <Stage
            title="The Delta"
            sub={
              fname
                ? `where ${firstNameOf(fname)}'s story settles`
                : 'where one person’s story settles'
            }
            count={fname ?? undefined}
            elev={72}
          >
            <ContextPanel s={s} act={act} />
          </Stage>
        </div>
      </main>
    </div>
  );
}
