# fluid-history — how Fluid reaches Hermes, and how to deploy this plugin

Read this before touching anything under `hermes/fluid-history/`. It records
findings that are not derivable from the code, and that cost real time to work
out.

## The one-paragraph version

Fluid is a wrapper over a Nous-hosted Hermes instance at
`https://ottawa-painters-hermes-5745.agents.nousresearch.com`. Fluid **cannot**
call Hermes' native API. The only way data gets from Hermes into Fluid is this
plugin, which runs *inside* Hermes and returns whatever it chooses to return.
If a field is missing in the Fluid UI, the usual cause is that this plugin
never put it in the response — not a bug, not permissions.

## Why the native Hermes API is unusable from Fluid

Hermes exposes `/api/cron/jobs`, `/api/profiles`, `/api/jobs` etc. These would
give us everything including prompts. They are gated behind Nous' own auth
provider, which needs an interactive browser session. A service token cannot
get one. Verified 2026-08-30:

```
# no auth
401  /api/cron/jobs
# with the Fluid history bearer token
503  /api/cron/jobs  {"detail":"Auth provider 'nous' unreachable"}
200  /api/plugins/fluid-history/agents
```

Do not spend time trying to make `HERMES_API_SERVER_KEY` or the history token
work against native routes. It is not a configuration problem.

## Auth

The plugin registers its own `DashboardAuthProvider` (`FluidHistoryTokenProvider`)
and calls `register_token_route()` for **each exact path**. Two consequences:

- A new endpoint must be added to `ROUTE_PATHS` or it will 401.
- `register_token_route` takes literal paths, so prefer **query parameters over
  path parameters** for new endpoints (`/sessions?session=...`, not
  `/sessions/{id}`). This is why the endpoints look the way they do.

The bearer secret is `HERMES_FLUID_HISTORY_SECRET` on the Hermes host. Fluid
derives the same value in `server/index.ts::hermesHistoryToken()` from
`HERMES_HISTORY_TOKEN`, or by HMAC over `CONNECTION_TOKEN_ENCRYPTION_KEY`.

## Endpoints (v2.0.0)

| Plugin route | Fluid route | Notes |
|---|---|---|
| `GET /agents` | `/api/hermes/agents`, `/api/hermes/schedules` | Curated fields + `definition` + `raw` (full record) |
| `GET /jobs?job=` | `/api/hermes/jobs` | Complete job records, unfiltered |
| `GET /profiles` | `/api/hermes/profiles` | |
| `GET /runs?agent=\|job=` | `/api/hermes/agents/:id/runs` | limit ≤ 200 |
| `GET /sessions?session=&profile=` | `/api/hermes/sessions/:id` | **Unverified — see below** |
| `GET /introspect` | `/api/hermes/introspect` | Reports what this Hermes build exposes |
| `GET /skills` | `/api/hermes/skills` | |
| `POST /actions` | `/api/hermes/agents/:id/:action` | pause / resume / delete only |

Reads return whole records with credential-looking **keys** masked
(`_SECRET_KEY_PARTS`). Note the mask is key-based: a secret pasted inline into
prompt *prose* is NOT caught. Writes stay narrow deliberately.

## Deploying

The Hermes dashboard (log in at the base URL above) has two relevant pages.

### Plugins page — "Install from GitHub / Git URL" (preferred)

The form accepts a subdirectory path, quoting its own help text: *"For a plugin
in a subdirectory, append the path: `owner/repo/path/to/plugin`"*. So for this
repo — which is **public** on GitHub as `jaddoescad/fluidaop` — the identifier is:

```
jaddoescad/fluidaop/hermes/fluid-history
```

Tick **Force reinstall** and **Enable after install**. Commit and push
`hermes/fluid-history/**` first; the installer pulls from the default branch.

### Files page — upload to `/opt/data`

Browses the host filesystem with upload/create/delete. Use this to patch files
in place, or to inspect where things actually live.

## OPEN QUESTION — resolve before the first GitHub install

The running `fluid-history` plugin **does not appear** in the dashboard's
"Installed plugins" list (which showed only bundled `browser-*` and `chronos`).
The page notes that only user-installed plugins under `~/.hermes/plugins` can be
removed. So the live copy was placed on disk by some other route — most likely a
Hermes chat session using its terminal tool; session history shows tasks like
*"Deploy contractor invoice library — In `/opt/data/repos/ottawa-painters-adm…`"*.

**Risk:** installing from GitHub creates a copy at `~/.hermes/plugins/fluid-history`
while the existing copy stays where it is. Two plugins declaring the same name
may shadow each other or double-register routes.

**Do first:** find the live copy's path via the Files page (start at
`/opt/data/.hermes/plugins`, then `/opt/data/repos/`), and either remove it or
overwrite it in place rather than installing a second one.

## Pending work

1. **Deploy v2.0.0.** The host is still serving the older build, so
   `/api/hermes/agents` returns no `definition` and the Fluid agent detail page
   shows "Definition not exposed". Nothing else blocks it — the Fluid side is
   built and parses the field defensively.
2. **Finish `/sessions`.** `_TRANSCRIPT_ACCESSORS` guesses at four plausible
   `hermes_cli.web_server` helper names because that module is only readable on
   the host. After deploying, call `/api/hermes/introspect` and rewrite
   `_transcript_payload()` against the real helper. Until then it returns 501
   naming what it tried.
3. **Regenerate presentation contracts.** Both live agents report
   `contractStatus: "stale"`, so their names/summaries in Fluid are wrong and
   the UI shows a warning banner. See `agent_contracts.py::build_contract`.
4. **Impact tab (not started).** Supabase already records what agents actually
   did — `agent_runs`, `agent_jobs`, `signal_triage_decisions`,
   `signal_recommendations`, `signal_labels`, all keyed by `agent_key` /
   `agent_run_id` with confidence, reason, evidence, model, prompt_version.
   None of it is surfaced on the Agents page yet.

## Local development notes

- `fluid-history` is **not** installed on the developer's local Hermes
  (`hermes plugins list`), so it cannot be exercised locally. There is also no
  SSH access to the host from the dev machine.
- `hermes_cli` is not importable locally, so anything touching `web_server`
  helpers cannot be tested before deploy. Prefer `getattr` probes with an
  explicit 501 over assuming a helper exists.
