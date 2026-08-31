# Cron jobs deleted 2026-08-30 (intentional, by the operator)

Recorded from /api/hermes/jobs and the Hermes cron page earlier the same day.
All deletions below were intentional, made through the Hermes cron page.
"Automatic Gmail tagging" was deleted separately via Fluid and is archived as
automatic-gmail-tagging.json.

| Job | State | Schedule | Script | Mode |
|---|---|---|---|---|
| Daily DripJobs Jobs List amounts + production month — 6am Toronto | ACTIVE | Daily at 10:00 | (dripjobs export) | no_agent |
| Daily Meta Ads backend sync — every 4 hours | ACTIVE | Every 4 h | meta-ads-backend-sync.sh | no_agent |
| Deploy Meta backend sync — one time | paused | Every 7 d | verify-meta-backend-sync-20260820.sh | no_agent |
| Fluid Quo Contact Enrichment — every 6 hours | paused | Every 6 h | — | no_agent |
| Fluid Signal Reconciliation — nightly | paused | Daily at 02:33 | — | no_agent |
| Install Fluid Action Library policy — one time | paused | Every 1 h | — | no_agent |

The two ACTIVE ones are the operational loss: DripJobs job amounts and the
Meta Ads rolling window will no longer refresh.

Their scripts still exist under /opt/data, so the cron entries can be recreated.
