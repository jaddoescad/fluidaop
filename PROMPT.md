# Build "Fluid" — a signal-triage concept UI

## The idea

We run a painting company (residential + commercial). Client signals arrive from
everywhere: SMS, email, phone calls, website forms. Build a working front-end
CONCEPT — fully interactive, mock data only, zero backend — that demonstrates one
idea:

> Everything that happens becomes a CARD. Cards are created by connectors, enriched
> with meaning, and triaged in one place.

This is not a CRM. The card is the atom; people are discovered through cards. Think
"PagerDuty for client signals" — but calm enough to live in all day.

## What the product must be able to show (capabilities, not layout)

Arrange these however you think works best — columns, feeds, drawers, overlays,
whatever. All of them must be present and functional:

1. **People / leads** — everyone we know, ranked by relationship "heat" (rises with
   inbound activity, decays over time). Selecting a person isolates the entire UI to
   them, with an obvious way back. Each person carries their state at a glance:
   how warm the lead is (hot ↔ cold), whether we owe them something, and money
   state (ready to start, payment made) when their recent messages say so.
2. **Signals** — the raw inbound stream, newest first, grouped by day
   (Today / Yesterday / dates). Every signal shows who, channel + source
   (SMS · Quo, Email · Gmail, Call, Form · Website), age, and full text.
3. **Interpretation** — this is the heart. The UI must READ the messages. When a
   customer writes "I'm ready to start the project," that meaning must be
   unmissable at a glance — not buried in body text. Classify signals into intents
   (ready to start, payment made, new lead, time-sensitive, happy client, future
   work, question, logistics…) and surface them prominently on the signal, on the
   person, and anywhere else it earns its place.
4. **Actions** — open obligations only. Three generators, and every action must show
   its provenance (the exact message that caused it):
   - Reply-due: latest inbound signal from a person needs a response.
   - Reminder-due: a reminder reached its date.
   - Staleness: suggestions sit untouched while a thread goes quiet.
   Hover or persistent controls for Done / Snooze. Completing removes the card and
   writes an activity-log entry. Snoozed items return after 45 s (demo time).
5. **Reminders** — future commitments sorted by due date; due/overdue visually
   distinct from upcoming; same Done / Snooze; provenance to the message that
   created them.
6. **Automations (playbooks)** — account-level sequences, like a sales-email drip:
   a trigger event ("a website quote request arrives", "an estimate goes out",
   "a job completes", "an invoice goes out") enrolls a person, then steps execute
   over days (day 0 intro email → day 2 check-in text → day 5 call…). Show the
   playbook definitions (readable step schedules — no cryptic shorthand), each
   running instance (person, progress, next step + when, what triggered it), and a
   pause toggle that genuinely stops execution. Enrollment and step execution must
   be observable during the demo.
7. **Context** — everything about the focused person: profile, heat, tags plus
   accept-able suggested tags, one-click next-best-actions, their reminders, full
   history grouped by day with per-line source labels, today's completed items, and
   a global activity log. Sensible empty state when nobody is focused.

## The demo script (required — the app must tell its own story)

Seed ~8 realistic people with history spread over the past weeks (including
yesterday, so day grouping shows immediately). After load:

- The first ~5 inbound signals are scripted so past history causes today's signal
  (she sent floor plans 5 days ago → today: "any update on the estimate?" →
  reply-due action appears with the quote).
- One scripted SMS contains future intent ("reach out in about three months") →
  a reminder ~90 days out is visibly born from it.
- One pre-seeded reminder comes due within 60 s — the viewer watches it flip
  upcoming → due → actionable → done.
- At least one signal during the demo carries money intent ("we're ready to
  start", "payment sent") and visibly changes state somewhere.
- A scripted trigger enrolls someone into a playbook and its first step fires; one
  pre-seeded playbook instance has its next step land within ~90 s.
- Afterwards: plausible random signals every few seconds, a Pause/Resume control,
  and live counters in a header. Alive, never chaotic.

## Time formatting (strict)

Ages: "now", "2m ago", "3h ago", "2d ago" — never seconds. Due dates: minute
granularity minimum ("in 1m"), same-day as clock time, otherwise calendar date;
overdue stated explicitly ("2m overdue").

## Design brief

The visual direction is yours — surprise us. What we're after is **clean and
compelling**: a tool a professional would keep open all day that still makes the
important moments feel like moments. Hard-won guidance from previous attempts:

- Clear hierarchy between information (signals), obligations (actions), future
  commitments (reminders), and machinery (automations).
- Motion must communicate state change (created → needs attention → handled),
  never decorate. A payment landing can celebrate; a routine text cannot.
- Expressiveness is welcome — color, icons/emoji, animation — but in service of
  meaning. Previous rounds failed in both directions: sterile dashboard-template
  minimalism, and emoji-confetti maximalism. Neither hit.
- Everything must be readable in one pass: no invented shorthand (a step schedule
  reads "day 3 — gentle nudge email", never "d3 email"), no labels that need the
  legend explained.

## Engineering constraints

- Single-page app, React + TypeScript, `tsc --noEmit` clean under `strict`.
- All data generated client-side after mount; no network calls; no console errors.
- Each scrollable region scrolls independently (`flex-1 min-h-0 overflow-y-auto`);
  verify with 30+ items. Never reorder a list under the reader except
  people-by-heat.
- Stable keys (`action:{signalId}`, `rem:{id}`); completed/dismissed sets prevent
  resurrection; snooze = hidden until a timestamp passes.
- Cap stored signals (~40) without ever dropping a signal an open action or
  reminder still cites; cap the activity log (~12).

## Acceptance checklist

- [ ] Typechecks clean; runs without console errors
- [ ] All seven capabilities present; isolation works and clears
- [ ] Scripted story plays: history → signal → action → handled
- [ ] A reminder is visibly born from a message, later flips due, then completes
- [ ] Money intent visibly changes a person's state during the demo
- [ ] A playbook enrollment and a step execution happen on screen
- [ ] Provenance visible on every action and reminder
- [ ] Feels alive under simulation but never chaotic
