<!-- Archived from /opt/data/skills/ottawa-painters-apis/SKILL.md on 2026-08-30.
     usage=31 enabled=True usedBy=[] -->

---
name: ottawa-painters-apis
description: Retrieve Ottawa Painters Gmail, Quo, CompanyCam, and customer database evidence without writes. Use for any named customer rundown, communication timeline, phone or email history, CompanyCam evidence, proposal outcome, customer experience, or “how did things go” question.
---

# Ottawa Painters APIs

## Customer fast path

For any named customer, run exactly one command:

```text
/opt/data/bin/ottawa customer-brief "<name/email/phone/id>" --max-evidence 30 --timeout-ms 6500 --json
```

The command resolves the customer and queries Gmail, Quo, and CompanyCam concurrently. Answer from its ranked evidence. Do not call the legacy Python API helper, `ottawa-source`, `google-workspace`, or raw API endpoints after a resolved result. Manual source calls are reserved for an explicit deep audit or focused source diagnostic.

## Boundaries

- Use GET/read-only access only.
- Quo retrieval is restricted to the Sales and Production phone lines. Do not attempt to enumerate or query any other line.
- Never send, draft, label, archive, or modify email or Quo data.
- Never modify CompanyCam or enumerate unrelated projects.
- Never print tokens, keys, authorization headers, or environment values.
