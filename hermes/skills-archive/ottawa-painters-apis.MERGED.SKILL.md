---
name: ottawa-painters-apis
description: Retrieve Ottawa Painters Gmail, Quo, CompanyCam, and customer database evidence without writes. Use for any named customer rundown, communication timeline, phone or email history, CompanyCam evidence, proposal outcome, customer experience, inbox review, promised payments, missed calls, unanswered messages, or evidence needed before recommending a follow-up.
---

# Ottawa Painters APIs

## Customer fast path

For any named customer, run exactly one command:

```text
/opt/data/bin/ottawa customer-brief "<name/email/phone/id>" --max-evidence 30 --timeout-ms 6500 --json
```

The command resolves the customer and queries Gmail, Quo, and CompanyCam concurrently. Answer immediately from `facts`, ranked `evidence`, `source_status`, and `provenance`. Distinguish customer statements, company statements, database facts, and inference.

Do not call the legacy Python API helper, `ottawa-source`, `google-workspace`, or raw API endpoints after a resolved result. Manual source calls are reserved for an explicit deep audit or focused source diagnostic. If resolution is ambiguous, present the candidates. If one source is unavailable, answer from the available sources and state the gap.

## Boundaries

- Use GET/read-only access only.
- Use Gmail search/read/fetch capabilities only. If a connected Gmail tool also exposes write actions, never call them under this skill.
- Quo retrieval is restricted to the Sales and Production phone lines. Do not attempt to enumerate or query any other line. Never use Quo's send-message, contact-write, webhook-write, or conversation-state endpoints.
- Never send, draft, reply, forward, label, archive, mark read/unread, create contacts, or otherwise modify email or Quo data.
- Never modify CompanyCam or enumerate unrelated projects.
- Never print tokens, keys, authorization headers, or environment values.
- Do not broaden a search from one customer to the full inbox unless the user asks for inbox-wide triage.
- Do not expose full message bodies when a concise business summary answers the question. Avoid unnecessary personal data.
- A statement that payment was or will be sent is evidence, not proof of payment. Reconcile against `ottawa cash` or `ottawa job`.
- If the user asks to send or modify something, stop using this skill and explain that the current connection is intentionally read-only.

Read `references/oauth-boundary.md` when configuring or diagnosing Gmail authorization.
