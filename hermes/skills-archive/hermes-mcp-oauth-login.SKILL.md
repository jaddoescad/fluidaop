<!-- Archived from /opt/data/skills/autonomous-ai-agents/hermes-mcp-oauth-login/SKILL.md on 2026-08-30.
     usage=9 enabled=False usedBy=[] -->

---
name: hermes-mcp-oauth-login
description: "Use when an OAuth-based Hermes MCP server needs login."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [hermes, mcp, oauth, pkce, login, supabase, headless]
---

# Hermes MCP OAuth Login (headless / hosted)

## When to Use

- An MCP server configured with `auth: oauth` (e.g. Supabase MCP, GitHub MCP) needs its first authorization.
- `hermes mcp test <server>` reports something like "non-interactive environment and no cached tokens found" or "MCP OAuth ... authorization required".
- NEVER fall back to API keys, service-role keys, database passwords, or PATs for MCP auth — the OAuth flow is the only supported path. Stop and get the human to authorize.

## Flow (verified in a hosted container, 2026-08)

1. Inspect the server entry in `config.yaml` under `mcp_servers.<name>`: the `url` (may carry query params such as `project_ref`, `read_only`, `features`), and `auth: oauth`. Redact anything token-like if you print config.
2. `hermes mcp test <name>` to confirm the state (expected when unauthed: auth required error).
3. Start the interactive login in a **background PTY**: `terminal(command="hermes mcp login <name>", background=true, pty=true)`. A plain foreground call will hang or fail on TTY detection.
4. `process(action=wait, timeout=10)` — the flow prints "Open this URL in your browser:" plus "Or paste the redirect URL here (or the `?code=...&state=...` portion) and press Enter."
5. **STOP and hand the authorization URL to the user verbatim** — a human must authorize; do not continue with credentials. In hosted setups the `redirect_uri` is `http://127.0.0.1:<port>/callback`, which the user's browser cannot reach — that is expected, not an error. After the failed redirect the browser address bar still contains `?code=...&state=...`; that is what gets pasted back.
6. When the user pastes the redirect URL (or just the query portion), submit it to the running process **immediately**: `process(action=submit, data=<paste>, session_id=<id>)` (submit sends the data plus Enter).
7. Confirm success with `hermes mcp test <name>` (should pass) and `hermes mcp list` (server enabled). Hermes caches the OAuth tokens itself — never print tokens, Authorization headers, or token fragments anywhere.

## Pitfalls (all observed in practice)

1. **Authorization codes are single-use and die with the process.** If the login process exits before the code is exchanged, the pasted code is worthless (the PKCE verifier lived in that process). Do not retry with the old code — restart the whole flow and hand the user a NEW URL.
2. **The flow self-restarts while waiting for input.** If the paste-back takes too long, `hermes mcp login` prints a second authorization URL with a NEW `state`, then fails with `OAuth callback port <N> is already in use ([Errno 98] Address already in use)` — it collides with its own first callback server — and exits. Recovery: confirm the port is free (`ss -tlnp | grep <port>`), restart the login, give the user the fresh URL, and submit promptly.
3. **Submitting to a dead process fails** with "Process has already finished" — poll/wait first; if it exited, apply pitfalls 1 and 2 (restart with a fresh URL).
4. **Promptness matters**: the paste-back should happen as soon as the user authorizes; long waits trigger the self-restart in pitfall 2. Warn the user about this when you hand them the URL.
5. Headless environments print "(Headless environment detected — open the URL manually.)" — normal, not an error.
6. `hermes mcp` is a subcommand tree (`serve`, `add`, `list`, `test`, `login`, `reauth`, ...); check `hermes mcp --help` and `hermes mcp login --help` before assuming flags. The hermes CLI may not be on PATH in hosted containers — locate it (e.g. `/opt/hermes/bin/hermes`) and export PATH.
7. **`hermes mcp login` re-registers the client every run** — it performs a fresh Dynamic Client Registration and overwrites `$HERMES_HOME/mcp-tokens/<server>.client.json` (new client_id, new callback port each time). Patching that cache file (e.g. adding `token_endpoint_auth_method`) does NOT survive a login run; don't use it as a fix.

## Token Storage Layout
`$HERMES_HOME/mcp-tokens/` (0600 files):
- `<server>.json` — OAuth tokens (access/refresh)
- `<server>.client.json` — DCR client registration (client_id, client_secret, redirect_uris)
- `<server>.meta.json` — discovered OAuth server metadata

## Token Exchange Failures (code pasted, then 4xx)

If the browser flow completes but the token POST is rejected, don't blindly re-run: check the provider's advertised token-endpoint auth methods (`token_endpoint_auth_methods_supported` in its OAuth authorization-server metadata). Providers that only support `client_secret_basic`/`client_secret_post` (e.g. **Supabase hosted MCP** → `422 {"message":"Required parameter: client_secret"}`) break the MCP SDK's default public-client exchange: their DCR issues a client_secret but omits `token_endpoint_auth_method` from the response, so the SDK defaults to `None` and never sends the secret. Verified metadata, DCR behavior, and the supported fix path (pre-registering the client via the server's `oauth:` config block): see `references/supabase-hosted-mcp-token-exchange.md`.

## Verification Checklist

- [ ] `hermes mcp test <name>` passes with no auth error
- [ ] `hermes mcp list` shows the server enabled
- [ ] No token/key/Authorization value was printed anywhere in chat, files, or logs

## References

- `references/ottawa-painters-supabase-mcp.md` — worked example: Supabase MCP server config + OAuth scopes for project `bwbckdkouqghdadpkjvn`.
- `references/supabase-hosted-mcp-token-exchange.md` — verified Supabase OAuth token-exchange quirk (`422 client_secret`) + the pre-registration fix path.
