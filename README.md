# Fluid

Fluid turns connected business signals into reliable operational context for Ottawa
Painters. Gmail and Quo remain customer-facing Signal sources. Slack is read-only
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
messages incrementally. Each Signal is one email; Gmail thread history is separate,
collapsed context. Fluid retains historical managed labels in its own `Fluid/`
namespace, but no classifier assigns new topic or urgency labels. Gmail ingestion never
sends, archives, or deletes mail.

### Quo

Quo messages and calls are ingested for the selected Sales line. Signed webhook events
provide live updates, while bounded backfill and contact enrichment fill provider
context without importing every workspace contact.

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

Signals carry read state. Opening one records the read; unopened cards stay bright
with a dot, opened ones recede, and the column head counts the unread ones across the
whole column. Everything that existed when the feature shipped was marked read.

**Potential Leads** sits between Signals and the pipeline. It holds inbound emails,
texts, and calls from people the CRM does not know yet. The independent
**Potential Lead Classifier — inbound email, text, call → Potential Leads** reads that
bounded inbound stream, decides whether each item may be painting work, and sends only
eligible candidates here for human review.
It runs independently. The database refuses outbound mail, automated sends, system
senders, existing Contacts, anything unreachable (no email or phone), and anything
from before the feature started, so nothing is historically backfilled. A person marks
each card **Lead** or **Not a lead**; the card dims and moves under a *Decided* divider
rather than disappearing. The decision remains auditable; the card leaves only after
an active canonical Contact claims the identity. Fluid never creates the provider
Contact.

Signals do not expose a manual-settlement control. The former Signal Recommender and
its draft-email recommendation were removed; opening a Signal no longer queues that
worker or offers an AI-generated Action.

`/actions` is the built-in Action Library. It separates reusable Hermes capabilities
from live Board instances. Draft email is the only supported capability; the unused SMS,
reminder, and internal-task placeholders were retired. Playwright covers the real Board,
pipeline, Signal decision, Action, connection-cleanup, and failure states.

## Hermes reconciliation

Hermes is Fluid's only scheduler. Every recurring agent or fixed-code script is
registered in `hermes/automations.json`, carries one verified `automationKey`, and
appears in global Activity for every invocation, including no-work ticks. Supabase
ingests events, leases queues, and stores authoritative results; it does not schedule
AI work. Host crontab, Supabase cron, and application business timers are prohibited.
Read `hermes/automation-creator/SKILL.md` before creating, changing, or retiring any
automation.

`hermes/fluid-case-reconciler` contains the `case-reconciler` skill, one-minute precheck,
and nightly deterministic reconciliation script. Hermes receives bounded canonical
state, unresolved work, and evidence references. Its structured proposal is validated
inside the database before any write. The first 50 proposed actions stay in shadow mode.

`hermes/fluid-action-runner` contains the separate drafting skill and one-minute
precheck. It receives only user-accepted Actions and returns the email body. Fluid owns
and locks the recipient, Gmail thread, and subject, then rejects stale completions so an
agent result cannot overwrite a user's newer edit.

`hermes/fluid-potential-lead-classifier` contains the dedicated skill and bounded
worker named **Potential Lead Classifier — inbound email, text, call → Potential
Leads**. It has its own queue, Edge Function, runtime secret, pre-check, and completion
contract. Its inputs are unknown inbound Gmail and Quo communications; its decision is
lead or not-lead; its output is a database-validated Potential Lead for a person to
review. See `hermes/fluid-potential-lead-classifier/DEPLOY.md`.

## Supabase

Migrations live in `supabase/migrations`. Edge Functions share one runtime helper for
database-secret loading, constant-time service-secret checks, admin-client creation, and
JSON responses. They are called server-to-server with dedicated runtime secrets; no
browser login or user-auth layer was added. The main function groups are:

- `fluid-gmail-activities` — server-only Gmail Signal ingestion and read models (the legacy function name is retained).
- `fluid-gmail-label-sync` — server-only leased outbox for deterministic Gmail labels.
- `fluid-operational-context` — Board, Job context, work-item resolution,
  and reconciliation RPC bridge.
- `fluid-real-board` — cursor-paginated Signal/pipeline read models, Action definitions,
  recommendation acceptance, Signal read state, and Potential Lead review controls.
- `fluid-action-runner` — server-only leased drafting jobs and revision-safe completion.
- `fluid-potential-lead-classifier` — independently classifies unknown inbound email,
  text, and calls and submits eligible candidates to Potential Leads for human review.
- `fluid-customer-sync` — canonical lead sync and Contacts/Employees projections; the
  legacy function name remains only as a deployment-compatible wrapper.
- `fluid-dripjobs-events`, `fluid-dripjobs-pipeline`, and `fluid-quo-events` — provider
  ingestion and deterministic processing endpoints.

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
