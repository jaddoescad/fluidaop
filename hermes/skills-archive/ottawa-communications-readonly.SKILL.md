<!-- Archived from /opt/data/skills/ottawa-communications-readonly/SKILL.md on 2026-08-30.
     usage=12 enabled=True usedBy=[] -->

---
name: ottawa-communications-readonly
description: Read and summarize Ottawa Painters customer communication context from the main Gmail inbox and Quo phone conversations. Use for inbox review, customer timelines, promised payments, missed calls, unanswered messages, proposal outcomes, and evidence needed before recommending a follow-up.
---

# Ottawa Communications (Read Only)

Use Gmail and Quo only to retrieve evidence. This skill never sends, drafts, replies, forwards, labels, archives, marks read/unread, creates contacts, or changes conversation state.

## Fast customer RAG

For a named customer, run exactly one command:

```text
ottawa customer-brief "<name/email/phone/id>" --max-evidence 30 --timeout-ms 6500 --json
```

Answer immediately from `facts`, ranked `evidence`, `source_status`, and `provenance`. Distinguish customer statements, company statements, database facts, and inference. Do not call Gmail or Quo tools separately after a resolved result. Manual source calls are reserved for an explicit deep audit or a focused source-diagnostic request.

## Hard boundaries

- Use Gmail search/read/fetch capabilities only. If a connected Gmail tool also exposes write actions, never call them under this skill.
- The Quo CLI is allowlisted to GET endpoints and hard-scoped to the Sales and Production phone lines. Never use Quo's send-message, contact-write, webhook-write, or conversation-state endpoints.
- Do not broaden a search from one customer to the full inbox unless the user asks for inbox-wide triage.
- Do not expose full message bodies when a concise business summary answers the question. Avoid unnecessary personal data.
- A statement that payment was/will be sent is evidence, not proof of payment. Reconcile against `ottawa cash` or `ottawa job`.
- If the user asks to send or modify something, stop using this skill and explain that the current connection is intentionally read-only.

Read `references/oauth-boundary.md` when configuring or diagnosing Gmail authorization.
