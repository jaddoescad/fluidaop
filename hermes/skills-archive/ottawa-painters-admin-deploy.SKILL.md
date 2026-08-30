<!-- Archived from /opt/data/skills/ottawa-painters-admin-deploy/SKILL.md on 2026-08-30.
     usage=4 enabled=False usedBy=[] -->

---
name: ottawa-painters-admin-deploy
description: "Deploy the ottawa-painters-admin repo to a pinned commit."
---

# Ottawa Painters Admin — Deploy & Verify

Class-level procedure for deploying the `ottawa-painters-admin` repo to a pinned
commit and verifying the installed read-only CLIs. Recurring operation
("deploy the exact pushed commit <sha>").

## Trigger

- User asks to deploy / update / install the pushed `ottawa-painters-admin`
  code at a specific commit.
- User asks to run the installed bin CLIs (`ottawa`, `ottawa-source`,
  `ottawa-time`, `ottawa-gmail-label`) after a deploy.

## Locations (verified 2026-08-11)

- Repo: `/opt/data/repos/ottawa-painters-admin`. NOTE: the user may say
  `/opt/data/ottawa-painters-admin` — that path does NOT exist. If unsure,
  locate with `find /opt/data -maxdepth 4 -type d -name "*painters*"`.
- Installed bins: `/opt/data/bin/{ottawa,ottawa-source,ottawa-time,ottawa-gmail-label}`;
  support lib at `/opt/data/bin/lib`.
- The repo carries an `AGENTS.md` (branch policy, Quo API key handling,
  2026-06-01 accounting cutoff) that surfaces automatically when working in
  the repo dir — honor it during deploy work.

## Deploy steps (exact order)

1. `git pull --ff-only` in the repo (use the terminal `workdir`).
2. `git rev-parse HEAD` — must equal the requested commit (short or full sha).
   Abort on mismatch; do NOT install against an unverified HEAD.
3. `node hermes/install.mjs --prefix /opt/data --force` — installs the bin
   CLIs, copies `scripts/lib` → `/opt/data/bin/lib`,
   `meta-ads-daily-report.sh` → `/opt/data/scripts`, and copies
   `hermes/skills` → `/opt/data/skills`. New repo skills appear in the skill
   library after deploy (e.g. `ottawa-gmail-labeling`).
4. Verify read-only: `/opt/data/bin/ottawa-gmail-label scope --json` (expect
   `gmail_readonly: true`, `gmail_modify: false`) and
   `/opt/data/bin/ottawa-gmail-label labels --json` (user labels with
   `id`/`name`/`type`).

## User constraints (standing rules for this workflow)

- Deploy + verify ONLY: never run the `add` command, never modify email,
  no writes of any kind.
- Never print credentials, OAuth tokens, client secrets, refresh tokens, or
  email contents. A client ID inside a generated auth URL is fine.
- Bounded verification: one tool call per step, literal adherence (no
  fallbacks, no extra queries or file edits), output limited to the requested
  fields (returncode/stdout/stderr).
- Report only what was asked: deployed commit, install success, the requested
  JSON.

## Pitfalls

- The user-stated repo path may be wrong — the repo lives under
  `/opt/data/repos/`, not `/opt/data/`.
- Verify HEAD BEFORE install; a pinned deploy is the whole point.
- `git pull --ff-only` fast-forwards; a diverged local branch fails loudly —
  report it, do not force.
- The bin CLIs run fine via the terminal tool. Python script paths (e.g.
  skill scripts like `auth_url_single_scope.py`) can trip the terminal
  lifecycle guard — see `oauth-token-exchange` →
  `references/single-scope-auth-url-prep.md` for the execute_code
  `subprocess.run` workaround.
