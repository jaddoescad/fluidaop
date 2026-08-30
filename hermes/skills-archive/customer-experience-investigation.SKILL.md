<!-- Archived from /opt/data/skills/ottawa-painters/customer-experience-investigation/SKILL.md on 2026-08-30.
     usage=9 enabled=False usedBy=[] -->

---
name: customer-experience-investigation
description: "Use when building a multi-source customer experience report."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [customer-experience, investigation, reconciliation, read-only, ottawa-painters]
    related_skills: [ottawa-painters-db-cli, ottawa-painters-apis, google-workspace]
---

# Customer Experience Investigation (multi-source)

## When to Use

Trigger phrases: "customer experience report", "how did the experience go", "investigate <customer> across all sources", "360 review of customer <name>". The Ottawa Painters configuration spans four read-only sources:
- **Supabase DB** → `ottawa-db` CLI (skill: `ottawa-painters-db-cli`)
- **Quo** (SMS/phone) → `ottawa_apis.py quo ...` (skill: `ottawa-painters-apis`)
- **CompanyCam** (photos) → `ottawa_apis.py cc ...` (same skill)
- **Gmail** → `google_api.py gmail ...` (skill: `google-workspace`)

This skill is the orchestration layer: identity resolution, cross-source search, reconciliation, and report structure. The access skills above hold the tool-level details (flags, allowlists, guards).

## Golden Rules

1. **Read-only everywhere.** No sends, no writes, no label changes, no contact edits. Quo key has full account privileges — GET only.
2. **Never print raw internal UUIDs** in the report. Resolve to names, invoice numbers, addresses, phone numbers. (UUIDs are fine internally for joins.)
3. **Never invent.** Every dated claim must trace to a message, photo, transaction, or email. Label anything reconstructed as inference.
4. **Use exact dates** (from timestamps/emails), concise factual paraphrase, quote SMS only when tone matters.
5. Credentials/tokens/headers are never echoed. Report status/counts only.

## Workflow

### Step 0 — Resolve identity in the DB (authoritative anchor)
```bash
ottawa-db customers --search "<surname>" --json    # e.g. "yacoub", "abdulla"
ottawa-db customer "<name>" --json --limit 50       # contact info, jobs, quotes, invoices, totals
```
- Disambiguate same-name contacts: different email/phone = different person (e.g. "Abdullah Turki" ≠ "Yacoub Abdulla").
- Capture: email, phone (E.164 for Quo), job/quote/invoice numbers, contact creation vs backfill dates.

### Step 1 — Extract verified identifiers (DB deep dive)
- `ottawa-db query "SELECT ... FROM public.jobs WHERE contact_id = '<uuid>'"` — jobs carry `address_line_1/city/province/postal_code`, `companycam_project_ids` (array → CompanyCam!), `lead_id`, `accepted_quote_id`, `source`, `started_on/completed_on`.
- `public.leads` has `dripjobs_deal_id`, `normalized_channel` (channel of lead, e.g. paid_social), `captured_at`.
- Payments: join `transactions` → `transaction_allocations` → `invoices` to see e-transfer amounts/dates (columns: `posted_on`, `transaction_type`, `amount_cents`, `description`, `review_status` — NOT `status`/`transaction_date`).
- Known schema traps (verified 2026-08): `invoices` has no `description`/`counterparty` columns; `invoice_job_allocations` uses `total_cents` (no `amount_cents`); `time_entries` uses `started_at/ended_at` (no `date`); `job_budgets` has no `budget_amount_cents`. Always `ottawa-db describe <table>` before ad-hoc SQL.
- See `references/cross-system-key-map.md` for the master join map.

### Step 2 — Quo (SMS/calls)
```bash
python3 .../ottawa_apis.py quo phone-numbers --full     # enumerate ALL business lines (threads live on any line)
python3 .../ottawa_apis.py quo messages --phone-number-id <PN> --participants +1XXXXXXXXXX --max-results 100 --pages 5 --full
```
- Search **every** phone number line — a customer's thread may span Sales + Production lines.
- Message objects use the `text` field (NOT `body`); fields: `direction` (incoming/outgoing), `status` (received/delivered), `createdAt`, `conversationId`. IDs look like `AC...`.
- Server `totalItems` is the true count; the CLI's `count` counts fetched pages.
- `contact-search` returning 0 hits does NOT mean no history — search by participant E.164 anyway.
- **Calls are NOT retrievable** via the helper: the live Quo `/calls` endpoint now requires `participants`+`phoneNumberId` params the allowlist won't pass (400, code 0100400). Report call history as an unknown; calls are often referenced inside SMS.
- Paginate with `--pages 5` (cap), sort by `createdAt` client-side for the timeline.

### Step 3 — CompanyCam (photos)
```bash
python3 .../ottawa_apis.py cc project <id> --full        # id from jobs.companycam_project_ids
python3 .../ottawa_apis.py cc photos <id> --per-page 100 --page 1 --full
```
- `created_at`/`captured_at`/`updated_at` are **unix epochs** — convert (e.g. `datetime.fromtimestamp(ts, datetime.UTC)`).
- Photo histogram by day = site-visit dates (estimate walkthrough vs work days vs touch-ups). `creator_name` shows who shot them. `description`/`tags` are usually empty.
- Project can be `status: active` AND `archived: true` (archived post-completion). `photo_count` + `public_url` useful for the evidence table.

### Step 4 — Gmail (search in:anywhere, not just Inbox)
```bash
GAPI="/opt/hermes/.venv/bin/python3 /opt/data/skills/productivity/google-workspace/scripts/google_api.py"
$GAPI gmail search "<name> in:anywhere" --max 25
$GAPI gmail search "<email> OR <phone> OR <address-street> in:anywhere" --max 25
$GAPI gmail search "<invoice#> OR <proposal#> in:anywhere" --max 10
```
- **Distinguish automated from human.** Automated: Dripjobs (`job-updates@dripjobs.com`: new lead, proposal accepted, invoice payment receipts), Interac (`notify@payments.interac.ca`: e-transfer deposits with legal sender name), Google Business Profile (`businessprofile-noreply@google.com`: review notifications), Sherwin-Williams statements, Jobber notifications (subcontractor invoices).
- Human: customer emails, colour consultants, coordinators — read the **full thread** (`gmail get <id>`) for these.
- Dripjobs + Interac notifications reconstruct the payment timeline with exact amounts/dates — cross-check against DB transactions (dates may differ by 1–2 days: Interac deposit vs Dripjobs posting).
- **Google review notifications truncate the review text** ("...and he was very…") — full text requires business.google.com access; report rating + snippet, mark full text as unknown. Duplicate notification emails arrive per review — dedupe by thread.
- Run google_api.py with the Hermes venv python; token lives at `/opt/data/google_token.json` (HERMES_HOME).

### Step 5 — Reconcile (the heart of the report)
- **Payment sums** across Interac emails, Dripjobs receipts, DB transactions must reconcile; note day-shifts.
- **Date conflicts**: DB backfilled records (created_at weeks/months later) can carry wrong job dates (e.g. started/completed dates contradicting SMS crew-start, CC photo days, and payment dates). Flag as data-quality issue, don't force-fit.
- **Discounts**: stated offers in SMS (e.g. $500 + $200) vs invoice discount lines ("Owner Discount", "Owner Discount 2") — reconcile which were actually applied.
- **Subcontractors**: payable invoices (e.g. Polaris Painters labour) + crew e-transfers may appear under a different counterparty than expected.
- Cross-check headline figures with an independent query before stating as fact (per ottawa-db discipline).

### Step 6 — Report structure (7 sections, in this order)
1. Executive verdict (mixed/positive/negative with the decisive facts)
2. Dated end-to-end timeline (lead → last follow-up)
3. Scope / price / payment facts
4. Communication & service-quality analysis (delays, complaints, rework, praise, unresolved)
5. Final outcome / current relationship
6. Evidence/source table (date | event | system)
7. Labeled unknowns & inferences (what could not be verified and why)

## Pitfalls (learned the hard way)

- `contact-search` needs `--search <term>` (positional term errors out).
- `--full` is required to see JSON bodies from `ottawa_apis.py`; Quo bodies are `{"data": [...]}` — parse `body['data']`.
- `from:`-only Gmail queries can error on JSON parse; search by name token + `in:anywhere` is more robust.
- Lead capture date (DB `leads.captured_at`) can be the backfill date; the true lead date is the Gmail "You've got a new lead" timestamp.
- Invoice "issued_on" may equal proposal-acceptance date (deposit day), not work day.

## Verification Checklist

- [ ] Contact identity disambiguated (email+phone match in at least 2 systems)
- [ ] Every Quo line queried; all message directions/statuses/dates captured
- [ ] CompanyCam project found via `companycam_project_ids`; photo histogram built
- [ ] Gmail searched in:anywhere with name, email, phone, address, invoice #; automated vs human separated
- [ ] Payments sum to invoice total across all three sources
- [ ] No UUIDs, no credentials, no writes anywhere
- [ ] Unknowns/inferences section explicitly labeled
