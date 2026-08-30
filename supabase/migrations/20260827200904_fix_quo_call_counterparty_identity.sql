-- Quo call payloads include the connected business line in participants.
-- The webhook importer previously assumed participants[0] was the customer,
-- which made outbound calls identify the business line as their actor. Recover
-- the external participant; the existing Activity trigger will then attach the
-- call to an exact Contact identity when one exists.

with corrected_calls as (
  select
    activity.id,
    array(
      select private.fluid_normalize_phone(participant.value)
      from jsonb_array_elements_text(
        coalesce(activity.source_metadata -> 'participants', '[]'::jsonb)
      ) with ordinality as participant(value, position)
      where private.fluid_normalize_phone(participant.value) is not null
        and private.fluid_normalize_phone(participant.value)
          <> private.fluid_normalize_phone(activity.account_phone)
        and not exists (
          select 1
          from public.quo_phone_scopes scope
          where scope.active
            and private.fluid_normalize_phone(scope.phone_number_e164)
              = private.fluid_normalize_phone(participant.value)
        )
      order by participant.position
    ) as external_participants
  from public.activities activity
  where activity.workspace_key = 'ottawa-painters'
    and activity.source = 'quo'
    and activity.event_type = 'call.completed'
    and private.fluid_normalize_phone(activity.actor_phone)
      = private.fluid_normalize_phone(activity.account_phone)
)
update public.activities activity
set actor_phone = corrected.external_participants[1],
    to_phones = corrected.external_participants,
    external_thread_id = 'quo:' || coalesce(
      nullif(activity.source_metadata ->> 'phoneNumberId', ''),
      activity.account_phone
    ) || ':' || regexp_replace(corrected.external_participants[1], '[^0-9]', '', 'g'),
    source_metadata = activity.source_metadata || jsonb_build_object(
      'counterpartyDerivation', 'external-participant-v2'
    ),
    updated_at = now()
from corrected_calls corrected
where activity.id = corrected.id
  and cardinality(corrected.external_participants) > 0;
