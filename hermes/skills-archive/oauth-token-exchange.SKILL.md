<!-- Archived from /opt/data/skills/security/oauth-token-exchange/SKILL.md on 2026-08-30.
     usage=8 enabled=False usedBy=[] -->

---
name: oauth-token-exchange
description: "Use for prepared OAuth code exchanges and token cleanup."
version: 1.0.0
author: Hermes curator
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [OAuth, PKCE, tokens, credentials, security, cleanup, Google]
    related_skills: [google-workspace, himalaya, notion]
---

# OAuth Token Exchange & Credential Hygiene

Class-level procedure for finishing an OAuth authorization-code flow that was
prepared by another session (pending state + PKCE verifier already stored),
and for securely persisting, verifying, and cleaning up the resulting
credentials. Provider-agnostic procedure; Google's endpoints and token format
are the concrete validated reference.

## When to use

- Credentials arrive as environment variables (e.g. `GOOGLE_OAUTH_REDIRECT_URL`,
  `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`) instead of a
  client-secret file, with a pending session already on disk.
- A pending session file holds `state` + `code_verifier` + `redirect_uri`
  (the Google skill stores it at `HERMES_HOME/google_oauth_pending.json`).
- You must persist a refresh token into a standard credential location.
- Post-setup security cleanup: strip temp env entries, delete prep files,
  verify token integrity WITHOUT calling the provider API.

## Workflow

1. **Locate the pending session.** `HERMES_HOME` resolves to `$HERMES_HOME`
   or `~/.hermes`; the pending file holds `state`, `code_verifier`,
   `redirect_uri`. Missing pending file → stop; the flow needs a fresh
   authorization URL first (`references/single-scope-auth-url-prep.md`).
2. **Parse the callback URL** (env `*_REDIRECT_URL`): extract `code`,
   `state`, `scope` with `urllib.parse.parse_qs`.
3. **Validate state.** Redirect `state` MUST equal pending `state`. Abort on
   mismatch — never exchange a mismatched code.
4. **Exchange the code.** Raw POST to the token endpoint (Google:
   `https://oauth2.googleapis.com/token`) with `grant_type=authorization_code`,
   `code`, `client_id`, `client_secret`, `redirect_uri` (from the PENDING
   session, not from memory — it must match what the auth URL used), and
   `code_verifier` (from pending). Stdlib `urllib` is enough; no
   provider SDK install needed.
5. **Verify the grant.** Response must contain `refresh_token`; the response
   `scope` field (space-joined string — split and compare as a SET) must
   equal EXACTLY the expected scope set, nothing more. Cross-check the
   callback URL's `scope` parameter too. Any extra scope → treat as failure.
6. **Persist the token.** Google authorized_user format at
   `HERMES_HOME/google_token.json`, mode 0600: `type`, `client_id`,
   `client_secret`, `refresh_token`, `token`, `token_uri`, `scopes`.
   The file embeds client_id/client_secret, so refreshes work standalone.
7. **Clean up the one-time pending file**, then confirm with the provider's
   `--check` if one exists (Google skill: `setup.py --check`).

## Security hygiene (standing requirement)

- NEVER print or echo secrets: env values, codes, verifiers, access/refresh
  tokens. Mask inspection output (`KEY=<masked>`); inspect `.env` key-only.
- Verify token integrity FILE-LEVEL only: exists, mode 0600
  (`oct(stat.S_IMODE(...)) == 0o600`), `refresh_token` present, `scopes`
  exactly matches. No provider API calls just to check.
- Cleanup: remove ONLY the named temp env entries from the `.env` (if they
  were its only lines the file ends up empty — leave the empty file unless
  told to delete it), delete ONLY the named temp prep files, and never
  delete/modify/display/rotate the token file. Prefer anchored `sed`/regex
  deletion over `patch` when the matching lines contain secrets you must
  not put in tool arguments.

## Pitfalls

- Auth codes are single-use and short-lived. `invalid_grant` means expired or
  reused — get a fresh authorization URL; do not retry the same code.
- Google's token response `scope` is space-joined; always compare sets.
- `authorized_user` token files must embed `client_id`/`client_secret` or
  refresh fails with `invalid_client`/`invalid_scope`.
- Google's localhost redirect (`http://localhost:1`) fails to load in the
  browser — expected; the user copies the full URL from the address bar.
- Redirect URI must be taken from the pending session — it must match the one
  used when the auth URL was generated, or the exchange fails.
- Scope parameter can arrive URL-encoded; `parse_qs` decodes it for you.

## References

- `references/google-env-var-exchange.md` — validated end-to-end script,
  verification snippet, and cleanup commands for the Google env-var flow.
- `references/single-scope-auth-url-prep.md` — generate a single-scope Google
  auth URL (auth_url_single_scope.py) with no exchange, the loopback redirect
  URI, read-only token-file triage, and the execute_code subprocess workaround
  for the terminal lifecycle guard.
