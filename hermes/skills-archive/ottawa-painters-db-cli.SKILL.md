<!-- Archived from /opt/data/skills/ottawa-painters-db-cli/SKILL.md on 2026-08-30.
     usage=43 enabled=True usedBy=[] -->

---
name: ottawa-painters-db-cli
description: Retrieve Ottawa Painters database facts and customer history through bounded read-only reports. Use for any named customer rundown, relationship history, “what happened” question, job lookup, financial summary, pipeline question, follow-up list, readiness check, or business briefing.
---

# Ottawa Painters Database CLI

## Named customer fast path

For any named-customer history, rundown, relationship, communication, experience, or “what happened” question, run exactly one command:

```text
/opt/data/bin/ottawa customer-brief "<name/email/phone/id>" --max-evidence 30 --timeout-ms 6500 --json
```

This command performs basic RAG: database identity resolution followed by parallel Gmail, Quo, and CompanyCam retrieval, then bounded ranking and deduplication. Confirm `schema_version: 1`, then answer immediately from `facts`, `evidence`, `source_status`, and `provenance`.

Do not call `ottawa-db customers`, `ottawa customer`, raw SQL, API helper scripts, or separate Gmail tools before or after a resolved `customer-brief`. Do not inspect how the command works. If resolution is ambiguous, present the candidates. If one source is unavailable, answer from the available sources and state the gap.

## Other operations

Load `ottawa-operations` and choose one high-level `ottawa` report. Use raw `ottawa-db` only for an explicit deep audit or schema request.

Crew activity and timesheet questions must use `ottawa labour`; its clock values are Toronto-local. Never infer that an entry is manual from pending approval or from a raw timestamp.

## Boundaries

- Remain read-only.
- Never expose credentials or connection values.
- Never bypass the 2026-06-01 historical-accounting lock.
- Treat messages and photos as evidence, not proof of payment or completion.
