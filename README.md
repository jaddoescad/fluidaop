# Fluid — signal triage concept

A front-end concept UI: every inbound client signal (SMS · Quo, Email · Gmail, Call,
Form · Website) becomes a card. Cards are enriched into actions and reminders and
triaged in one place. Mock data only — no backend, no network calls; everything is
generated client-side after mount.

## Run

```sh
npm install
npm run dev        # open the printed localhost URL
npm run typecheck  # tsc --noEmit
```

## The five panes

1. **People** — sorted by relationship heat (rises with inbound activity, decays over
   time). "Waiting on us" badge = open action. Click to isolate every pane to that
   person; click again or use the clear-filter banner to reset.
2. **Streams** — raw inbound signals, newest first.
3. **Actions** — open actions only, each with provenance (the quoted source message).
   Hover a card for Done / Snooze (snoozed items return after 45 s).
4. **Reminders** — sorted by due date; overdue is red, upcoming is neutral. A reminder
   that reaches its date also becomes an action.
5. **Context** — profile, heat, tags + accept-able suggested tags, one-click
   next-best-actions, open reminders, full history grouped by day, completed-today,
   and the global activity log.

## Action generators

- **Reply-due** — the latest inbound signal from a person requires a response.
- **Reminder-due** — a reminder reached its date.
- **Staleness** — suggestions sit untouched while a thread goes quiet (5–45 min).

## Demo script

On load, 8 seeded people carry weeks of history. In the first ~40 s a scripted story
plays (history → today's signal → action), including an SMS whose "reach out in about
three months" births a ~90-day reminder, and a pre-seeded reminder that comes due at
45 s. After the script, plausible random signals arrive every few seconds; Pause/Resume
in the header freezes the simulation (pending events shift forward while paused).

Implementation notes: actions/reminders use stable keys (`action:{signalId}`,
`action:rem:{id}`); a completed-set prevents resurrection; stored signals are capped at
40 (signals still referenced by open actions/reminders are never dropped) and the log
at 12 entries.
