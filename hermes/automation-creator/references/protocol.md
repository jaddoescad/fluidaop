# Fluid automation protocol

## Vocabulary

- **Signal**: a customer or business event such as an email, text, or call.
- **Automation**: one registered agent or deterministic script.
- **Schedule**: the Hermes clock definition.
- **Job**: queued business work waiting for an agent.
- **Run**: one agent attempt against one subject.
- **Activity**: one Hermes schedule execution, including no-work ticks.

The database table named `activities` is legacy storage for Signals. Product
copy must not call those rows Activity.

## Identity

`automationKey` is the cross-system identity. It is lowercase kebab-case and
must be identical in the registry, verified Hermes contract, queue
`agent_key`, runtime worker, run record, APIs, and UI.

Display names are presentation only. Never join by display name or infer an
identity from a cron prompt.

## Subject and result

Every Signal-connected run stores the Signal's existing `activities.id` as its
subject. APIs expose subjects as `{ type: "signal", id, label, href }`; this
union can add Deals later without renaming Signal storage now.

The system of record owns the result. A completed run stores a bounded
presentation with a schema version, kind, title, summary, and structured
payload in the same transaction as its domain result and queue completion.
Hermes contributes timing, model, session, and safe diagnostics only.

Workers use `runtime-correlation.mjs` to capture the exact cron job, durable
execution, profile, and `HERMES_SESSION_ID` from Hermes-owned runtime state.
The helper reads the one active execution from the profile-local cron ledger
and fails closed if the identity is missing or ambiguous. These values are
never model arguments, and timestamp-nearest session matching is prohibited.
One Hermes execution and session may own zero or more domain runs for batched
processing.

## Visibility

- Agents lists verified model-reasoning jobs.
- Schedules lists every live Hermes agent and script job.
- Activity lists every Hermes execution, including no-work and manual ticks.
- A Signal's Agent activity lists its complete queue and run lifecycle.

Only a real Hermes execution receives a global Activity URL. Queue-only rows
open Signal-scoped queue details. When pending work has no active verified
consumer, show it as orphaned.

Run detail may expose stored business results and bounded diagnostics. Never
expose raw prompts, model transcripts, tool arguments/results, credentials,
recording URLs, or unbounded provider payloads.
