-- Keep repaired calls in the same conversation key format as live Quo events.
-- North American E.164 numbers omit their leading country code in this key.

with normalized as (
  select
    activity.id,
    regexp_replace(activity.actor_phone, '[^0-9]', '', 'g') as digits
  from public.activities activity
  where activity.workspace_key = 'ottawa-painters'
    and activity.source = 'quo'
    and activity.event_type = 'call.completed'
    and activity.source_metadata ->> 'counterpartyDerivation'
      = 'external-participant-v2'
)
update public.activities activity
set external_thread_id = 'quo:' || coalesce(
      nullif(activity.source_metadata ->> 'phoneNumberId', ''),
      activity.account_phone
    ) || ':' || case
      when length(normalized.digits) = 11 and normalized.digits like '1%'
        then substring(normalized.digits from 2)
      else normalized.digits
    end,
    updated_at = now()
from normalized
where activity.id = normalized.id;
