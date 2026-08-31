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
```

The Vite app and local API share `http://localhost:5173` in development. The API binds
only to `127.0.0.1`; this is intentionally a single-user local application and has no
login flow. Browser code never receives provider tokens, the Supabase database secret,
or unbounded/unlinked Slack payloads. Linked Slack excerpts are deliberately returned
only inside the relevant Job context.

The code-only quality gate is `npm run verify:code`. With the local Supabase stack
running, `npm run verify` also executes the SQL contract suite.

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
its topic onto new inbound messages as one `Fluid/<topic>` label, with managed role
labels in the same `Fluid/` namespace. It removes only superseded labels in that managed
namespace (or labels already recorded in Fluid's mapping table) and never sends,
archives, deletes, or changes labels outside Fluid's ownership. Existing mail is not
backfilled.

### Quo

Quo messages and calls are ingested for the selected Sales line. Signed webhook events
provide live updates, while bounded backfill and contact enrichment fill provider
context without importing every workspace contact.

### Slack

Slack is dormant infrastructure, not a connection offered by the local UI. This repo
contains the signed event receiver and the database-backed internal sync contract, but
does not contain a Slack OAuth callback or a token-owning sync client. Do not configure
the previously documented `/api/oauth/slack/callback`; it does not exist.

If an external connector is added later, it must provision workspaces, channels, users,
messages, and sync state through the internal `fluid-slack-events` actions using
`FLUID_SLACK_SYNC_SECRET`, and Slack event delivery must use `SLACK_SIGNING_SECRET`.
Only selected public `#job-*` channels and `#sales` are modeled. A job channel links only
when its final numeric suffix exactly matches the Job's DripJobs proposal ID.
`#all-ottawa-painters`, private channels, Slack writeback, and file downloads remain out
of scope.

## Operational cases and the Board

Every Job has one operational Case. Structured DripJobs, scheduling, completion, and
payment facts outrank communication evidence. Gmail, Quo, and Slack support the case;
Hermes interprets them but cannot override stronger facts.

The Case tracks production, scheduling, assignment, and financial state independently.
Work items use stable fingerprints and reconcile on every Case revision, so retries do
not duplicate records and completed or cancelled production cannot be resurrected by
old messages. Job context contains bounded, paginated evidence and work-item history.

The Board combines a live, cursor-paginated Signal inbox with the DripJobs sales
pipeline. Pipeline stages and archived history come from provider data rather than a
hard-coded demo layout. Contacts, Employees, Activity, Labels, Actions, Schedules, and
Connections each have a dedicated route. Slack stays inside linked Job context and
never appears as a global Signal.

Opening an eligible inbound Gmail Signal can show one concrete Hermes recommendation
for an enabled capability. The user must accept it before an Action exists. The first
working capability is **Draft email to customer**; it creates an editable draft in the
existing Action detail flow. **Send (simulation)** records an audit event only: it
does not call Gmail, create an outbound Activity, or claim the customer received it.
Pending Signals stay unresolved until a person explicitly settles them. A Signal with
an open Action must be completed through that Action; it cannot also be settled as
`no_action`. Provider activity may complete an Action, but it never silently makes the
Signal review decision.

`/actions` is the built-in Action Library. It separates reusable Hermes capabilities
from live Board instances. Draft email is the only supported capability; the unused SMS,
reminder, and internal-task placeholders were retired. Playwright covers the real Board,
pipeline, Signal decision, Action, connection-cleanup, and failure states.

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

Migrations live in `supabase/migrations`. Edge Functions share one runtime helper for
database-secret loading, constant-time service-secret checks, admin-client creation, and
JSON responses. They are called server-to-server with dedicated runtime secrets; no
browser login or user-auth layer was added. The main function groups are:

- `fluid-gmail-activities` — server-only Gmail activity ingestion and Signal read models.
- `fluid-gmail-label-sync` — server-only leased outbox for deterministic Gmail labels.
- `fluid-slack-events` — custom Slack signature verification and event ingestion.
- `fluid-operational-context` — Board, Job context, work-item resolution,
  and reconciliation RPC bridge.
- `fluid-real-board` — cursor-paginated Signal/pipeline read models, Action definitions,
  recommendation acceptance, and guarded no-action settlement.
- `fluid-signal-recommender` — server-only Hermes claim, completion, failure, and
  reconciliation bridge.
- `fluid-action-runner` — server-only leased drafting jobs and revision-safe completion.
- `fluid-customer-sync` — canonical lead sync and Contacts/Employees projections; the
  legacy function name remains only as a deployment-compatible wrapper.
- `fluid-dripjobs-events`, `fluid-dripjobs-pipeline`, `fluid-quo-events`, and
  `fluid-signal-triage` — provider ingestion and deterministic processing endpoints.

New raw-provider and reconciliation tables are server-only with RLS enabled. Manager
read access is limited to the public case/work-item projections required by the app.

### Migration-history warning

The checked-in chain now has a conditional root-schema compatibility baseline, targeted
foreign-key indexes, canonical lead/Action contracts, queue lifecycle hardening, and SQL
contract coverage. Seeding is disabled because there is no seed file.

The linked project's complete historical SQL is **not** present: the read-only snapshot
records 191 remote-only versions, including 119 unavailable prehistory bodies. The
baseline makes a clean local replay possible; it is not recovered remote history. Read
`supabase/migrations/REMOTE_HISTORY_MANIFEST.md` before deployment. Do not run a normal
`db push --include-all` or repair the remote migration ledger until the missing bodies or
an explicit reconciliation plan have been reviewed. This cleanup did not push, repair,
or otherwise mutate the linked database.
