<!-- Archived from /opt/data/skills/ottawa-meta-ads-reporting/SKILL.md on 2026-08-30.
     usage=23 enabled=True usedBy=[]
     NOTE: bundled scripts/reference files were NOT archived — only this SKILL.md. -->

---
name: ottawa-meta-ads-reporting
description: Analyze Ottawa Painters Meta Ads performance from the read-only Marketing API connection. Use for daily or date-specific questions about Meta ad spend, painting inquiries from ads, recruiting leads, cost per inquiry, campaign performance, seven-day and 30-day trends, insights, actions, recommendations, or ads spending without inquiries.
---

# Ottawa Meta Ads Reporting

Use the bundled report script as the only Meta interface. It is read-only and uses `America/Toronto` for date defaults.

## Run a report

For yesterday:

```text
node /opt/data/skills/ottawa-meta-ads-reporting/scripts/meta-ads-report.mjs --json
```

For a specific date:

```text
node /opt/data/skills/ottawa-meta-ads-reporting/scripts/meta-ads-report.mjs --date YYYY-MM-DD --json
```

Run exactly once. Confirm `schema_version` is `1` and `status` is `ok`. Use the structured metrics as evidence; do not recalculate them.

## Daily executive update

When asked for a daily update or when running from cron, write the analysis yourself. Do not paste JSON, tool output, a schema, or `slack_text` verbatim.

Keep the entire Slack update to 12 lines or fewer and include:

1. Yesterday's painting inquiries from Meta, spend, and cost per inquiry.
2. Painting inquiry results for the trailing 7 days and trailing 30 days.
3. Recruiting results separately in one compact line when there was recruiting activity.
4. `Winners:` with at most two campaigns that have attributed leads and comparatively strong CPL or improving performance.
5. `Watch:` with at most two campaigns or trends that spent without leads, have weak CPL, or materially worsened.
6. `Actions:` with exactly two specific, evidence-based next steps.

Prefer decisions over narration. Mention percentage changes only when they materially change the recommendation. Never recommend scaling from a single day's result alone; use the 7-day and 30-day evidence. Do not claim CRM lead quality from Meta attribution data.

Use `Meta Ads — Yesterday (August 9 2026)` as the heading, substituting `period.display_date`. Never show a bare date that leaves the reporting period ambiguous.

## Interpretation

- Always label `customer_acquisition.leads` as `Yesterday's painting inquiries from Meta`, never `Customer leads` or `Painting estimate leads`.
- Explain this count as inquiry actions Meta assigned to painting ads. It does not prove that each inquiry was unique, qualified, booked for an estimate, or sold.
- Report recruiting results separately; never mix applications into customer leads.
- Treat the seven-day and 30-day comparisons as directional because Meta attribution may update after the reporting date.
- End with this plain-language note: `Meta counted these inquiries from the ads; booked estimates and sales are not confirmed here.`
- Translate warnings and feedback into plain language. Never use `Meta-attributed results` or `CRM confirmation` in the Slack update.

## Boundaries

- Never modify ads, campaigns, ad sets, creatives, budgets, audiences, or account settings.
- Never reveal access tokens, authorization headers, environment values, or credential files.
- If the script exits non-zero, report the concise error and stop. Do not inspect credentials or retry alternate account IDs.
