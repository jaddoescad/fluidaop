-- Quo serializes multi-recipient message destinations as one comma-separated
-- string. Earlier webhook parsing treated that whole string as one phone and
-- lost the counterparty identity. Recover the retained webhook events; the
-- normal Activity trigger then resolves the new Identity and revises triage.

with latest_delivery as (
  select distinct on (payload #>> '{data,object,id}')
    payload #>> '{data,object,id}' as external_id,
    payload #>> '{data,object,to}' as raw_to,
    payload #>> '{data,object,phoneNumberId}' as phone_number_id
  from public.quo_webhook_events
  where event_type = 'message.delivered'
    and payload #>> '{data,object,id}' is not null
  order by payload #>> '{data,object,id}', received_at desc
), recipient_tokens as (
  select delivery.external_id, delivery.phone_number_id, token.ordinality,
    btrim(token.value) as raw_phone,
    regexp_replace(btrim(token.value), '[^0-9]', '', 'g') as digits
  from latest_delivery delivery
  cross join lateral regexp_split_to_table(
    coalesce(delivery.raw_to, ''), '[[:space:]]*,[[:space:]]*'
  ) with ordinality as token(value, ordinality)
), normalized_recipients as (
  select external_id, phone_number_id, ordinality,
    case
      when raw_phone ~ '^[+][1-9][0-9]{6,14}$' then raw_phone
      when digits ~ '^1[0-9]{10}$' then '+' || digits
      when digits ~ '^[0-9]{10}$' then '+1' || digits
      else null
    end as phone
  from recipient_tokens
), delivery_recipients as (
  select external_id, phone_number_id,
    array_agg(phone order by ordinality) filter (where phone is not null) as phones
  from normalized_recipients
  group by external_id, phone_number_id
)
update public.activities activity
set actor_phone = recipients.phones[1],
    to_phones = recipients.phones,
    external_thread_id = coalesce(
      activity.external_thread_id,
      'quo:' || coalesce(recipients.phone_number_id, activity.account_phone) || ':' ||
        regexp_replace(recipients.phones[1], '[^0-9]', '', 'g')
    ),
    source_metadata = activity.source_metadata || jsonb_build_object(
      'phoneNumberId', recipients.phone_number_id,
      'recipientCount', cardinality(recipients.phones)
    ),
    updated_at = now()
from delivery_recipients recipients
where activity.source = 'quo'
  and activity.event_type = 'message.sent'
  and activity.external_id = recipients.external_id
  and cardinality(recipients.phones) > 0
  and (
    nullif(btrim(activity.actor_phone), '') is null
    or cardinality(activity.to_phones) = 0
    or activity.external_thread_id is null
  );
