# Fluid

Fluid turns connected business signals into reliable operational context for Ottawa
Painters. Gmail and Quo remain customer-facing Activity sources. Slack is read-only
internal context attached to Jobs. The Board is backed by canonical Job cases and
persistent work items; it does not use seeded demo cards.

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
npm run typecheck
npm run typecheck:server
npm run build
```

The Vite app and local API share `http://localhost:5173` in development. Browser code
never receives provider tokens, the Supabase service role, or raw Slack data.

## Connections

### Gmail

Create a Google OAuth Web application with the Gmail modify scope and add:

```text
http://localhost:5173/api/oauth/google/callback
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a stable
`CONNECTION_TOKEN_ENCRYPTION_KEY`. Fluid accepts only `info@paintersottawa.com`, stores
the refresh token encrypted, checks the connection every five minutes, and imports
messages incrementally. Each Activity is one email; Gmail thread history is separate,
collapsed context. Signal triage is the only classifier. A deterministic worker projects
its topic onto new inbound messages as a single `Fluid/<topic>` Gmail label. It removes
only superseded `Fluid/` topic labels and never sends, archives, deletes, or changes
personal labels. Existing mail is not backfilled.

### Quo

Quo messages and calls are ingested for the selected Sales line. Signed webhook events
provide live updates, while bounded backfill and contact enrichment fill provider
context without importing every workspace contact.

### Slack

Create a Slack OAuth app with the read-only user scopes `channels:read`,
`channels:history`, and `users:read`, then add:

```text
http://localhost:5173/api/oauth/slack/callback
```

Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` locally. Set `SLACK_SIGNING_SECRET` as a
Supabase Edge Function secret, then subscribe the app's `message.channels` user event
to:

```text
https://bwbckdkouqghdadpkjvn.supabase.co/functions/v1/fluid-slack-events
```

Fluid automatically selects public `#job-*` channels and `#sales`. A job channel links
only when its final numeric suffix exactly matches the Job's DripJobs proposal ID.
`#all-ottawa-painters`, private channels, Slack writeback, and file downloads are out of
scope. Initial backfill is resumable and bounded to the latest 15 messages per selected
channel, with thread replies fetched only for sampled messages that have replies.

## Operational cases and the fixed Board

Every Job has one operational Case. Structured DripJobs, scheduling, completion, and
payment facts outrank communication evidence. Gmail, Quo, and Slack support the case;
Hermes interprets them but cannot override stronger facts.

The Case tracks production, scheduling, assignment, and financial state independently.
Work items use stable fingerprints and reconcile on every Case revision, so retries do
not duplicate records and completed or cancelled production cannot be resurrected by
old messages. Job context contains bounded, paginated evidence and work-item history.

The Board keeps its fixed five-column UI: People, Signals, Actions, Reminders, and
Automations. People and Gmail/Quo Signals are live, cursor-paginated data. Slack stays
inside linked Job context and never appears as a global Signal. Actions, Reminders, and
Automations show only user-created records, so earlier generated operational work items
remain available for audit without appearing on the Board.

Opening an eligible inbound Gmail Signal can show one concrete Hermes recommendation
for an enabled capability. The user must accept it before an Action exists. The first
working capability is **Draft email to customer**; it creates an editable draft in the
existing Board Actions column. **Send (simulation)** records an audit event only: it
does not call Gmail, create an outbound Activity, or claim the customer received it.
The Signal stays unresolved until a real outbound Gmail message appears or the Action
is cancelled. **No action needed** remains an explicit, idempotent dismissal.

`/actions` is the built-in Action Library. It separates reusable Hermes capabilities
from live Board instances. Draft email is enabled; SMS draft, follow-up reminder, and
internal task remain disabled placeholders until their handlers exist. Playwright
screenshot coverage locks the five-column Board layout against silent redesigns.

## Hermes reconciliation

`hermes/fluid-case-reconciler` contains the `case-reconciler` skill, one-minute precheck,
and nightly deterministic reconciliation script. Hermes receives bounded canonical
state, unresolved work, and evidence references. Its structured proposal is validated
inside the database before any write. The first 50 proposed actions stay in shadow mode.

`hermes/fluid-signal-recommender` contains the v2 Signal recommendation skill,
one-minute precheck, and nightly deterministic repair script. It runs only after triage
and identity resolution, uses bounded attachment/transcript, conversation, Contact, Job,
Case, and linked Slack context, and returns zero or one enabled Action recommendation.
The first 25 eligible Gmail Signals remain shadow-only until their quality is reviewed.

`hermes/fluid-action-runner` contains the separate drafting skill and one-minute
precheck. It receives only user-accepted Actions and returns the email body. Fluid owns
and locks the recipient, Gmail thread, and subject, then rejects stale completions so an
agent result cannot overwrite a user's newer edit.

## Supabase

Migrations live in `supabase/migrations`. The deployed Edge Functions are:

- `fluid-gmail-activities` — server-only Gmail activity ingestion and Signal read models.
- `fluid-gmail-label-sync` — server-only leased outbox for deterministic Gmail labels.
- `fluid-slack-events` — custom Slack signature verification and event ingestion.
- `fluid-operational-context` — authenticated Board, Job context, work-item resolution,
  and reconciliation RPC bridge.
- `fluid-real-board` — authenticated, cursor-paginated five-column Board read models
  and the idempotent no-action settlement endpoint.
- `fluid-signal-recommender` — server-only Hermes claim, completion, failure, and
  reconciliation bridge.
- `fluid-action-runner` — server-only leased drafting jobs and revision-safe completion.

New raw-provider and reconciliation tables are server-only with RLS enabled. Manager
read access is limited to the public case/work-item projections required by the app.
