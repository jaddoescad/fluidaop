# Fluid — signal triage

Every inbound client signal (SMS · Quo, Email · Gmail, Call, Form · Website) becomes
a card. Cards are enriched into actions and reminders and triaged in one place. The
board still uses seeded concept data, while `/connections` now has a real server-side
Gmail OAuth connection.

## Run

```sh
npm install
npm run dev        # starts Vite and the connections API
npm run typecheck  # tsc --noEmit
npm run build      # checks the client + server and builds the UI
```

## Connect Gmail

1. In Google Cloud, enable the Gmail API and create an OAuth 2.0 **Web application**
   client.
2. Add `http://localhost:5173/api/oauth/google/callback` as an authorized redirect URI
   for local development. Use the same `/api/oauth/google/callback` path on the deployed
   origin later.
3. Configure the OAuth audience. If `paintersottawa.com` is a Google Workspace
   organization you control, an Internal app is the simplest durable option. An External
   app left in Testing issues Gmail refresh tokens that expire after seven days, so move
   it to Production before relying on unattended checks.
4. Copy `.env.example` to `.env`, add the Google client ID and secret, and generate a
   stable token encryption key with `openssl rand -hex 32`.
5. Run `npm run dev`, open `/connections`, and choose **Connect Gmail**. Google must be
   authorized as `info@paintersottawa.com`; the server rejects a different mailbox.

The server encrypts the refresh token at rest and checks the live Gmail profile every
five minutes. A manual **Check now** uses the same refresh-and-profile path. Disconnecting
revokes the Google grant and removes the local credential.

## Sync Gmail activity

`/activity` is backed by the real `activities` and `gmail_sync_state` tables in Supabase.
Choose **Sync Gmail** to import the connected account's last 30 days of mail. The import is
idempotent by Gmail message ID, stores plain text rather than remote email HTML, matches
counterparties to existing contacts by normalized email, and writes to Supabase through a
server-authenticated Edge Function. The browser never receives a Supabase secret key.

The Activity page shows received, sent, attachment, unread, and needs-reply views. The
needs-reply view excludes Gmail categories and headers that identify bulk or automated
mail; it does not send, label, archive, or otherwise modify Gmail.

## The five panes

1. **People** — sorted by relationship heat (rises with inbound activity, decays over
   time). "Waiting on us" badge = open action. Click to isolate every pane to that
   person; click again or use the clear-filter banner to reset.
2. **Streams** — raw inbound signals, newest first.
3. **Actions** — open actions only, each with provenance (the quoted source message).
   Hover a card for Done / Snooze (snoozed items return after 45 s).
4. **Reminders** — sorted by due date; overdue is red, upcoming is neutral. A reminder
   that reaches its date also becomes an action.
5. **Context** — profile, heat, tags + accept-able suggested tags, one-click
   next-best-actions, open reminders, full history grouped by day, completed-today,
   and the global activity log.

## Action generators

- **Reply-due** — the latest inbound signal from a person requires a response.
- **Reminder-due** — a reminder reached its date.
- **Staleness** — suggestions sit untouched while a thread goes quiet (5–45 min).

## Demo script

On load, 8 seeded people carry weeks of history. In the first ~40 s a scripted story
plays (history → today's signal → action), including an SMS whose "reach out in about
three months" births a ~90-day reminder, and a pre-seeded reminder that comes due at
45 s. After the script, plausible random signals arrive every few seconds; Pause/Resume
in the header freezes the simulation (pending events shift forward while paused).

Implementation notes: actions/reminders use stable keys (`action:{signalId}`,
`action:rem:{id}`); a completed-set prevents resurrection; stored signals are capped at
40 (signals still referenced by open actions/reminders are never dropped) and the log
at 12 entries.
