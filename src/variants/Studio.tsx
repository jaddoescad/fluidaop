import { ReactNode } from 'react';
import { CHANNEL_LABEL } from '../data';
import { heatOf, openReminders, personById } from '../engine';
import { fmtAge, fmtClock, isOverdue, startOfToday } from '../time';
import { Signal } from '../types';
import {
  ActivityLog,
  AutomationsPanel,
  classifyIntent,
  derive,
  DueChip,
  Empty,
  firstNameOf,
  groupStreamByDay,
  INTENT_META,
  KIND_LABEL,
  moneyBadge,
  Prov,
  RemProv,
  SourceTag,
  tempOf,
  useDepart,
  VProps,
} from './shared';
import './studio.css';

/* Intents that deserve a louder "stamped" arrival. */
const LOUD = new Set(['paid', 'ready', 'urgent', 'lead']);

function PaneTape({ title, count, note }: { title: string; count?: number | string; note?: string }) {
  return (
    <header className="st-ph">
      <span className="st-ph-tape">
        <b>{title}</b>
        {count !== undefined && <i>{count}</i>}
      </span>
      {note && <span className="st-ph-note">{note}</span>}
    </header>
  );
}

function OpsRow({
  onDone,
  onSnooze,
  doneWord,
}: {
  onDone: () => void;
  onSnooze: () => void;
  doneWord?: string;
}) {
  return (
    <div className="st-ops">
      <button className="st-do" onClick={onDone}>
        <i className="st-check" aria-hidden />
        {doneWord ?? 'Done'}
      </button>
      <button className="st-later" onClick={onSnooze}>
        Snooze 45s
      </button>
    </div>
  );
}

function Ticket({ s, sig, name }: { s: VProps['s']; sig: Signal; name: string }) {
  const intent = classifyIntent(sig);
  const meta = intent ? INTENT_META[intent] : null;
  const fresh = s.now - sig.at < 5000;
  const loud = intent !== null && LOUD.has(intent);
  return (
    <article
      className={`st-ticket${fresh ? ' fresh' : ''}${intent ? ` int-${intent} has-int` : ''}${
        fresh && loud ? ' loud' : ''
      }`}
    >
      {meta && intent && (
        <div className={`st-int int-${intent}`}>
          <i className="st-dab" aria-hidden />
          <span>{meta.label}</span>
        </div>
      )}
      <div className="st-trow">
        <span className="st-tname">{name}</span>
        <span className="st-tage">{fmtAge(sig.at, s.now)}</span>
      </div>
      <div className="st-tsub">
        <SourceTag channel={sig.channel} />
        {sig.requiresReply && <span className="st-flag">needs reply</span>}
      </div>
      <p className="st-ttext">{sig.text}</p>
    </article>
  );
}

/* ---------- the client folder (context) ---------- */

function Folder({ s, act }: VProps) {
  const person = s.focusId ? personById(s, s.focusId) : undefined;

  if (!person) {
    return (
      <div className="st-folder st-folder-closed">
        <div className="st-folder-hint">
          <span className="st-hint-dab" aria-hidden />
          <p className="st-hand-big">Pull a paint chip from the client deck.</p>
          <p className="st-hint-sub">
            Their whole folder opens here — history, promises, tags, and the best next moves.
          </p>
        </div>
        <ActivityLog s={s} />
      </div>
    );
  }

  const heat = heatOf(s, person.id);
  const temp = tempOf(heat);
  const personRems = openReminders(s).filter((r) => r.personId === person.id);
  const history = s.signals.filter((x) => x.personId === person.id).slice().reverse();
  const sod = startOfToday(s.now);
  const completedToday = s.log.filter((e) => e.personId === person.id && e.at >= sod);

  return (
    <div className="st-folder">
      <div className="ctx-section st-profile">
        <div className="st-folder-name">
          <h3>{person.name}</h3>
          <span className="st-folder-kind">
            {person.company ? `${person.company} · ` : ''}
            {person.kind}
          </span>
        </div>
        <p className="st-pencil">{person.note}</p>
        <div className="st-gauge" title={`Relationship heat ${heat}`}>
          <span className="st-gauge-track">
            <i style={{ width: `${heat}%` }} />
          </span>
          <b>{heat}°</b>
          <em>{temp.label}</em>
        </div>
      </div>

      <div className="ctx-section">
        <h4>Tags</h4>
        <div className="st-tags">
          {person.tags.map((t) => (
            <span key={t} className="st-tag">
              {t}
            </span>
          ))}
          {person.suggestedTags.map((t) => (
            <button
              key={t}
              className="st-tag st-tag-sug"
              onClick={() => act.acceptTag(person.id, t)}
              title="Accept suggested tag"
            >
              + {t}
            </button>
          ))}
          {person.tags.length === 0 && person.suggestedTags.length === 0 && (
            <span className="dim">none yet</span>
          )}
        </div>
      </div>

      <div className="ctx-section">
        <h4>Suggested next</h4>
        {person.nbas.length === 0 && <Empty>All suggestions handled.</Empty>}
        {person.nbas.map((n) => (
          <div key={n.id} className="st-nba">
            <span className="st-nba-label">{n.label}</span>
            <button className="st-run" onClick={() => act.runNba(person.id, n.id)}>
              Run
            </button>
          </div>
        ))}
      </div>

      <div className="ctx-section">
        <h4>Reminders</h4>
        {personRems.length === 0 && <Empty>Nothing promised right now.</Empty>}
        {personRems.map((r) => (
          <div key={r.id} className="st-frem">
            <DueChip dueAt={r.dueAt} now={s.now} />
            <span className="st-frem-note">{r.note}</span>
          </div>
        ))}
      </div>

      <div className="ctx-section">
        <h4>History</h4>
        {groupStreamByDay(history, s.now).map((g) => (
          <div key={g.label} className="hist-day">
            <div className="hist-day-label">{g.label}</div>
            {g.items.map((sig) => (
              <div key={sig.id} className="hist-row">
                <span className="hist-time">{fmtClock(sig.at)}</span>
                <span className={`hist-src src-${sig.channel}`}>{CHANNEL_LABEL[sig.channel]}</span>
                <span className="hist-text">{sig.text}</span>
              </div>
            ))}
          </div>
        ))}
        {history.length === 0 && <Empty>No history yet.</Empty>}
      </div>

      <div className="ctx-section">
        <h4>Completed today</h4>
        {completedToday.length === 0 && <Empty>Nothing completed yet today.</Empty>}
        {completedToday.map((e) => (
          <div key={e.id} className="log-row">
            <span className="log-age">{fmtAge(e.at, s.now)}</span>
            <span className="log-text">{e.text}</span>
          </div>
        ))}
      </div>

      <ActivityLog s={s} />
    </div>
  );
}

/* ---------- main variant ---------- */

export function StudioV({ s, act }: VProps) {
  const d = derive(s);
  const A = useDepart();
  const R = useDepart();
  const clear = () => act.focus(null);
  const focusName = d.focusPerson?.name ?? null;
  const running = s.seqInstances.filter((i) => i.doneAt === null).length;

  const nameOf = (personId: string): string =>
    s.people.find((x) => x.id === personId)?.name ?? '—';

  const counterTag = (n: number, label: string, extra?: string): ReactNode => (
    <span className={`st-ctag${extra ?? ''}`}>
      <b>{n}</b>
      <span>{label}</span>
    </span>
  );

  return (
    <div className="v v-studio">
      <header className="st-top">
        <div className="st-brand">
          <span className="st-roller" aria-hidden>
            <i />
          </span>
          <b>FLUID</b>
          <span className="st-brand-sub">the job board — Meridian Painting Co.</span>
        </div>
        <div className="st-ctags">
          {counterTag(d.c.signalsToday, 'signals today')}
          {counterTag(d.c.openActions, 'waiting on us')}
          {counterTag(d.c.remindersDue, 'due right now', d.c.remindersDue > 0 ? ' hot' : '')}
        </div>
        <div className="st-live">
          <span className={`st-sign${s.paused ? ' off' : ''}`}>
            <i aria-hidden />
            {s.paused ? 'on break' : 'crew live'}
          </span>
          <button className="st-pause" onClick={act.togglePause}>
            {s.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      {d.focusPerson && (
        <div className="st-focus-tape">
          <span>
            showing only <b>{d.focusPerson.name}</b>’s paperwork
          </span>
          <button onClick={clear}>peel off — show everyone</button>
        </div>
      )}

      <main className="st-cols">
        {/* clients: the paint-chip deck */}
        <section className="pane st-pane">
          <PaneTape title="Clients" count={d.ranked.length} note="warmest chips on top" />
          <div className="pane-scroll">
            {d.ranked.map(({ p, heat }) => {
              const focused = s.focusId === p.id;
              const temp = tempOf(heat);
              const money = moneyBadge(s, p.id);
              return (
                <button
                  key={p.id}
                  className={`st-chip temp-${temp.key}${focused ? ' focused' : ''}${
                    s.focusId && !focused ? ' dimmed' : ''
                  }`}
                  onClick={() => act.focus(focused ? null : p.id)}
                  title={focused ? 'Unpin — show everyone' : `Pin the board to ${firstNameOf(p.name)}`}
                >
                  <span className="st-chip-band">
                    <em className="st-chip-temp">{temp.label}</em>
                    <em className="st-chip-heat">{heat}°</em>
                  </span>
                  <span className="st-chip-body">
                    <span className="st-chip-name">{p.name}</span>
                    <span className="st-chip-sub">{p.company ?? p.kind}</span>
                    {(money || d.waiting.has(p.id)) && (
                      <span className="st-chip-badges">
                        {money && (
                          <em className={`st-stamp ${money.label === 'paid' ? 'stamp-paid' : 'stamp-ready'}`}>
                            {money.label}
                          </em>
                        )}
                        {d.waiting.has(p.id) && <em className="st-owe">waiting on us</em>}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* signals: job tickets */}
        <section className="pane st-pane">
          <PaneTape title="Signals" count={d.streams.length} note="every message, read for meaning" />
          <div className="pane-scroll">
            {groupStreamByDay(d.streams, s.now).map((g) => (
              <div key={g.label} className="st-day">
                <div className="st-day-tape">{g.label}</div>
                {g.items.map((sig) => (
                  <Ticket key={sig.id} s={s} sig={sig} name={nameOf(sig.personId)} />
                ))}
              </div>
            ))}
            {d.streams.length === 0 && <Empty>No paperwork here yet.</Empty>}
          </div>
        </section>

        {/* actions: work orders on the clipboard */}
        <section className="pane st-pane">
          <PaneTape title="Work orders" count={d.actions.length} note="what we owe people" />
          <div className="pane-scroll">
            {d.actions.map((a) => {
              const fresh = s.now - a.createdAt < 5000;
              return (
                <article
                  key={a.id}
                  className={`st-order kind-${a.kind}${fresh ? ' fresh' : ''}${
                    A.leaving.has(a.id) ? ' leaving' : ''
                  }`}
                >
                  <div className="st-orow">
                    <span className={`st-kind kchip-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
                    <span className="st-tage">{fmtAge(a.createdAt, s.now)}</span>
                  </div>
                  <h3 className="st-otitle">{a.title}</h3>
                  <div className="st-operson">{nameOf(a.personId)}</div>
                  <Prov s={s} a={a} />
                  <OpsRow
                    onDone={() => A.depart(a.id, act.done)}
                    onSnooze={() => A.depart(a.id, act.snooze)}
                  />
                </article>
              );
            })}
            {d.actions.length === 0 && (
              <Empty>Board’s clear — nothing waiting on us{focusName ? ` for ${focusName}` : ''}.</Empty>
            )}
          </div>
        </section>

        {/* reminders: sticky notes */}
        <section className="pane st-pane">
          <PaneTape title="Promised" count={d.reminders.length} note="stickies come due" />
          <div className="pane-scroll">
            {d.reminders.map((r) => {
              const due = isOverdue(r.dueAt, s.now);
              const born = r.bornLive && s.now - r.createdAt < 8000;
              return (
                <article
                  key={r.id}
                  className={`st-sticky${due ? ' due' : ''}${born ? ' born' : ''}${
                    R.leaving.has(r.id) ? ' leaving' : ''
                  }`}
                >
                  <div className="st-srow">
                    <DueChip dueAt={r.dueAt} now={s.now} />
                    {born && <span className="st-born">just captured</span>}
                  </div>
                  <p className="st-snote">{r.note}</p>
                  <div className="st-sperson">{nameOf(r.personId)}</div>
                  <RemProv s={s} r={r} />
                  <OpsRow
                    onDone={() => R.depart(r.id, act.remDone)}
                    onSnooze={() => R.depart(r.id, act.remSnooze)}
                  />
                </article>
              );
            })}
            {d.reminders.length === 0 && (
              <Empty>Nothing promised{focusName ? ` to ${focusName}` : ''} right now.</Empty>
            )}
          </div>
        </section>

        {/* playbooks: recipe cards */}
        <section className="pane st-pane">
          <PaneTape title="Playbooks" count={`${running} running`} note="runs by itself — pause any" />
          <div className="pane-scroll">
            <AutomationsPanel s={s} act={act} />
          </div>
        </section>

        {/* the client folder */}
        <aside className="pane st-pane st-side">
          <PaneTape title="Client folder" count={focusName ?? 'closed'} />
          <div className="pane-scroll">
            <Folder s={s} act={act} />
          </div>
        </aside>
      </main>
    </div>
  );
}
