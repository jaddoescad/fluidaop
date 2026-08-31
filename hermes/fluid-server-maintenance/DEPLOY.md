# Fluid server maintenance

Install `fluid-server-maintenance.mjs` as a Hermes script job running every minute. Set:

- `FLUID_SERVER_MAINTENANCE_URL` to the HTTPS `/api/internal/hermes-maintenance` endpoint;
- `FLUID_SERVER_MAINTENANCE_SECRET` to the same strong secret configured on the Fluid server.

Create a contract with `automationKey` `fluid-server-maintenance`, no subject types, and display name `Fluid server maintenance — connections and Gmail queues`.

This replaces the former in-process timers. Do not add a host crontab, Supabase cron, or application timer as a fallback.
