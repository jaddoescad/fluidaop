<!-- Archived from /opt/data/skills/ottawa-gmail-labeling/SKILL.md on 2026-08-30.
     usage=10 enabled=True usedBy=[] -->

---
name: ottawa-gmail-labeling
description: Add approved existing user labels to Gmail messages for Ottawa Painters. Use when the user explicitly asks Hermes to label, tag, or categorize one or more emails, including applying a lead, customer, estimate, production, billing, or recruiting label after inbox review.
---

# Ottawa Gmail Labeling

Use the dedicated add-only executable. Do not use a general Gmail modification tool.

## Workflow

1. Identify the exact message from Gmail read/search results. Use its Gmail message ID; never infer an ID.
2. Confirm the requested label. If the user did not name a label and the classification is not an already approved automation, ask before changing mail.
3. Check available user labels when needed:

```text
/opt/data/bin/ottawa-gmail-label labels --json
```

4. Validate the exact operation without changing Gmail:

```text
/opt/data/bin/ottawa-gmail-label add --message-id "<gmail-id>" --label "<label>" --dry-run --json
```

5. After an explicit user request, apply the label:

```text
/opt/data/bin/ottawa-gmail-label add --message-id "<gmail-id>" --label "<label>" --yes --json
```

6. Report only the message identifier and label name unless the user asks for more context.

## Hard boundaries

- Add only labels present in `HERMES_GMAIL_LABEL_ALLOWLIST`.
- Add only Gmail user labels. Never apply system labels such as `INBOX`, `UNREAD`, `TRASH`, `SPAM`, `STARRED`, or `IMPORTANT`.
- Never remove a label, archive, delete, mark read/unread, send, draft, reply, forward, or create/rename/delete a label.
- Never use an arbitrary HTTP client or URL to bypass the executable.
- Never expose OAuth tokens, client secrets, credential files, or authorization codes.
- Stop and report the exact error if Google authorization lacks `gmail.modify`; do not broaden access to `mail.google.com`.
- Treat a bulk or automated classification rule as a separate change. Obtain user approval for the rule and test it in dry-run mode before applying labels.

The separate `ottawa-communications-readonly` skill remains the source for searching and reading messages.
