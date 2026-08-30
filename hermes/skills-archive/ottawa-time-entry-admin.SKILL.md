<!-- Archived from /opt/data/skills/ottawa-time-entry-admin/SKILL.md on 2026-08-30.
     usage=4 enabled=True usedBy=[] -->

---
name: ottawa-time-entry-admin
description: Change an Ottawa Painters employee's existing clock-in time from a Slack or chat request. Use for explicit write requests such as "change Scott's clock in to 8 am," "fix Michael's start time yesterday," or "set Sarah's clock-in on 2026-08-10 to 07:30." Infer omitted time zones as America/Toronto and omitted dates as today in that zone.
---

# Ottawa Time Entry Admin

Use the narrow server-side `ottawa-time` command for explicit clock-in edits. This is the only write allowed by this skill.

## Execute the edit

Run exactly one command:

```text
/opt/data/bin/ottawa-time set-clock-in --employee "<employee>" --at "<time>" --yes --json
```

Add `--date "yesterday"` or `--date "YYYY-MM-DD"` when the user supplies a date. Add `--project "<project>"` only when the user names the project. Do not run a read-only labour report first; the write command resolves the matching entry and returns its previous and new values.

Interpret Eastern, EST, EDT, or an omitted time zone as `America/Toronto`. Never convert using a fixed UTC offset; the command handles daylight saving time. If the date is omitted, use Toronto-local today.

The command selects the earliest clock-in for the uniquely matched employee on that local day. A supplied project limits selection to that project's entry.

## Handle the result

- Treat only `updated` or `unchanged` as success.
- On `updated`, confirm the employee, local date, previous clock-in, new clock-in, and project from the JSON response.
- On `unchanged`, say the clock-in was already set to that value.
- On `error`, report the error concisely. If an employee name is ambiguous, ask for the fuller name. If no entry exists, ask for a date or project only when that would resolve the request.
- Never retry with guessed employee names, dates, projects, or times.

## Boundaries

- Require explicit change language such as change, fix, adjust, or set. Do not write when the user is only asking what time someone clocked in.
- Never create or delete a time entry, change clock-out, approve a timesheet, or edit notes under this skill.
- Never expose credentials, environment values, authorization headers, or the dedicated Hermes token.
- Never claim success from intent alone; require the command's structured success result.
