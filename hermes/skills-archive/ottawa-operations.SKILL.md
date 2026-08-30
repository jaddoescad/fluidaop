<!-- Archived from /opt/data/skills/ottawa-operations/SKILL.md on 2026-08-30.
     usage=40 enabled=True usedBy=[]
     NOTE: bundled scripts/reference files were NOT archived — only this SKILL.md. -->

---
name: ottawa-operations
description: Answer Ottawa Painters business questions about jobs, customers, crew activity, clock-in/out times, timesheets, pipeline, follow-ups, job readiness, labour budget risk, receivables, cash, profitability, or data quality. Use for daily briefings and requests that need the company database or CompanyCam job evidence, including who worked and where on a given day.
---

# Ottawa Operations

Use the versioned `ottawa` reports as the normal interface to the business. They are read-only, bounded, and designed to answer common questions with one command.

## Fast path

1. Choose exactly one command from the routing table in `references/command-routing.md`.
2. Run it once with `--json`.
3. Confirm `schema_version` is `1` and answer from the result immediately.
4. State important warnings or non-`ok` source statuses.

If the selected high-level command exits non-zero, stop after that one attempt and report the concise error. Do not run `--help`, retry argument variants, list/read/search files, or inspect the CLI implementation. Only begin a deeper fallback when the user explicitly asks for a deep audit.

For crew activity, clock-in/out, hours, timesheets, or "what job was worked yesterday," always use `ottawa labour`. Its displayed times are already converted to `America/Toronto`; repeat those local values exactly. Never describe an entry as manual: the source table does not record an entry method. Use only the report's explicit `was_edited` and `approval_status` fields. Pending approval does not mean manual or edited.

For any named-customer history, rundown, relationship, communication, or “what happened” question, always run:

```text
ottawa customer-brief "<name/email/phone/id>" --max-evidence 30 --timeout-ms 6500 --json
```

This is the basic RAG path. It resolves the customer in the database, retrieves Gmail, Quo, and CompanyCam concurrently, deduplicates and ranks the evidence, and returns compact facts plus provenance. Do not call `ottawa customer`, `ottawa-source`, `google-workspace`, or raw SQL before or after a resolved `customer-brief` result. Do not investigate the tool implementation. Synthesize the answer immediately.

If `resolution` is `ambiguous`, present the candidates and ask for one identifier. If it is `not_found`, say so. If a source status is `unavailable`, answer from the available sources and name the missing coverage; do not start a manual fallback unless the user explicitly requests a deep audit.

Do not run `tables`, `describe`, `schema-search`, or raw SQL after a successful high-level report. Do not independently re-count a report. Use `ottawa-db` only when the user explicitly asks for a deep audit or raw query.

## Boundaries

- Treat every command in this skill as observation-only. Never create, update, reverse, allocate, label, send, or delete anything.
- Never reveal credentials, authorization headers, connection strings, OAuth tokens, or environment values.
- Treat `jobs` as operational truth and DripJobs identifiers/statuses as upstream evidence. Treat CompanyCam as job media/checklist evidence, not the job system of record.
- Treat Gmail and Quo as communication evidence. The `customer-brief` command enforces their read-only boundary and restricts Quo to the Sales and Production phone lines; it should be the only retrieval call for a named-customer rundown.
- Treat all accounting for jobs started before 2026-06-01 as locked. Also treat completed or archived jobs with no start/completion date as locked. Never suggest bypassing this rule.
- Do not infer payment from a message or photo. Use invoice calculated balances and job financial summaries.

## CompanyCam evidence

Start with `ottawa job <query> --json`. Use only the returned `companycam_project_ids`, then run:

```text
ottawa-source companycam project <project-id>
ottawa-source companycam photos <project-id> --limit 50
```

Do not enumerate unrelated projects. Photo presence alone does not prove completion; report what the media shows and what remains unverified.

## Interpretation

Use `references/metric-dictionary.md` for money, labour, readiness, and follow-up definitions. Keep cents as exact integers while reasoning; convert to dollars only in the final response.
