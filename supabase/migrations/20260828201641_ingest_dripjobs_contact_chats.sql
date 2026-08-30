-- Bulk DripJobs chat ingestion is Contact-based. A chat channel identifies a
-- DripJobs Contact, while date boundaries decide which of that Contact's deals
-- receive each message. Overlapping boundaries intentionally link to both.
create or replace function public.ingest_dripjobs_contact_chat_messages(
  p_workspace_key text,
  p_dripjobs_contact_id text,
  p_channel_key text,
  p_support_user_id text,
  p_messages jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_person_id uuid;
  v_person_count integer;
  v_deal_count integer;
  v_only_deal_id text;
  v_customer_name text;
  v_customer_email text;
  v_customer_phone text;
  v_message jsonb;
  v_external_id text;
  v_direction text;
  v_text text;
  v_actor_name text;
  v_occurred_at timestamptz;
  v_attachment_count integer;
  v_activity_id bigint;
  v_inserted integer := 0;
  v_existing integer := 0;
  v_link_rows integer := 0;
  v_unassigned integer := 0;
begin
  if p_workspace_key is null
     or p_workspace_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or p_dripjobs_contact_id is null
     or char_length(p_dripjobs_contact_id) not between 1 and 200
     or p_channel_key is null
     or char_length(p_channel_key) not between 1 and 500
     or p_support_user_id is null
     or char_length(p_support_user_id) not between 1 and 500 then
    raise exception 'Invalid DripJobs chat Contact or channel identity';
  end if;

  if jsonb_typeof(p_messages) <> 'array'
     or jsonb_array_length(p_messages) not between 1 and 500
     or pg_column_size(p_messages) > 5242880 then
    raise exception 'DripJobs chat import must contain 1 to 500 bounded messages';
  end if;

  select
    min(deal.person_id::text)::uuid,
    count(distinct deal.person_id),
    count(distinct deal.deal_id),
    case when count(distinct deal.deal_id) = 1 then min(deal.deal_id) end
  into v_person_id, v_person_count, v_deal_count, v_only_deal_id
  from public.dripjobs_sales_deals deal
  join public.people person
    on person.id = deal.person_id
   and person.workspace_key = p_workspace_key
   and person.status = 'active'
  where deal.dripjobs_contact_id = p_dripjobs_contact_id;

  if v_person_id is null or v_person_count <> 1 then
    raise exception 'DripJobs Contact does not resolve to exactly one active Fluid Contact';
  end if;

  select person.display_name, person.primary_email, person.primary_phone
  into v_customer_name, v_customer_email, v_customer_phone
  from public.people person
  where person.id = v_person_id;

  for v_message in select value from jsonb_array_elements(p_messages)
  loop
    if jsonb_typeof(v_message) <> 'object' then
      raise exception 'Every DripJobs chat message must be an object';
    end if;

    v_external_id := nullif(btrim(v_message ->> 'externalId'), '');
    v_direction := nullif(btrim(v_message ->> 'direction'), '');
    v_text := nullif(btrim(v_message ->> 'text'), '');
    v_actor_name := nullif(btrim(v_message ->> 'actorName'), '');

    begin
      v_occurred_at := (v_message ->> 'occurredAt')::timestamptz;
      v_attachment_count := greatest(0, least(100, coalesce((v_message ->> 'attachmentCount')::integer, 0)));
    exception when others then
      raise exception 'Every DripJobs chat message needs a valid occurredAt and attachmentCount';
    end;

    if v_external_id is null or char_length(v_external_id) > 500
       or v_direction not in ('inbound', 'outbound')
       or v_text is null or char_length(v_text) > 100000
       or v_occurred_at is null
       or (v_actor_name is not null and char_length(v_actor_name) > 500) then
      raise exception 'Invalid DripJobs chat message';
    end if;

    select activity.id into v_activity_id
    from public.activities activity
    where activity.workspace_key = p_workspace_key
      and activity.source = 'dripjobs'
      and activity.external_id = v_external_id;

    if v_activity_id is null then
      insert into public.activities (
        workspace_key,
        source,
        account_email,
        account_phone,
        external_id,
        external_thread_id,
        event_type,
        direction,
        actor_name,
        actor_email,
        actor_phone,
        subject,
        preview,
        body_text,
        occurred_at,
        has_attachments,
        attachment_count,
        source_labels,
        source_metadata
      ) values (
        p_workspace_key,
        'dripjobs',
        null,
        null,
        v_external_id,
        'stream:messaging:' || p_channel_key,
        case when v_direction = 'inbound' then 'message.received' else 'message.sent' end,
        v_direction,
        coalesce(v_actor_name, case when v_direction = 'inbound' then v_customer_name else 'Ottawa Painters' end),
        case when v_direction = 'inbound' then v_customer_email else null end,
        case when v_direction = 'inbound' then v_customer_phone else null end,
        'DripJobs chat with ' || v_customer_name,
        left(regexp_replace(v_text, '[[:space:]]+', ' ', 'g'), 500),
        v_text,
        v_occurred_at,
        v_attachment_count > 0,
        v_attachment_count,
        array['dripjobs-chat'],
        jsonb_build_object(
          'dripjobsContactId', p_dripjobs_contact_id,
          'channelKey', p_channel_key,
          'supportUserId', p_support_user_id,
          'providerMessageId', v_external_id,
          'provider', 'stream_chat',
          'importMethod', 'stream_api',
          'attachmentTypes', coalesce(v_message -> 'attachmentTypes', '[]'::jsonb),
          'automated', coalesce((v_message ->> 'automated')::boolean, false)
        )
      ) returning id into v_activity_id;
      v_inserted := v_inserted + 1;
    else
      update public.activities activity
      set external_thread_id = 'stream:messaging:' || p_channel_key,
          event_type = case when v_direction = 'inbound' then 'message.received' else 'message.sent' end,
          direction = v_direction,
          actor_name = coalesce(v_actor_name, case when v_direction = 'inbound' then v_customer_name else 'Ottawa Painters' end),
          actor_email = case when v_direction = 'inbound' then v_customer_email else null end,
          actor_phone = case when v_direction = 'inbound' then v_customer_phone else null end,
          subject = 'DripJobs chat with ' || v_customer_name,
          preview = left(regexp_replace(v_text, '[[:space:]]+', ' ', 'g'), 500),
          body_text = v_text,
          occurred_at = v_occurred_at,
          has_attachments = v_attachment_count > 0,
          attachment_count = v_attachment_count,
          source_metadata = activity.source_metadata || jsonb_build_object(
            'dripjobsContactId', p_dripjobs_contact_id,
            'channelKey', p_channel_key,
            'supportUserId', p_support_user_id,
            'providerMessageId', v_external_id,
            'provider', 'stream_chat',
            'importMethod', 'stream_api',
            'attachmentTypes', coalesce(v_message -> 'attachmentTypes', '[]'::jsonb),
            'automated', coalesce((v_message ->> 'automated')::boolean, false)
          ),
          updated_at = now()
      where activity.id = v_activity_id;
      v_existing := v_existing + 1;
    end if;

    insert into public.activity_people (
      activity_id, person_id, relationship, matched_by, confidence
    ) values (
      v_activity_id, v_person_id, 'counterparty', 'provider_id', 1
    )
    on conflict (activity_id, person_id, relationship) do update
    set matched_by = excluded.matched_by,
        confidence = excluded.confidence,
        updated_at = now();

    v_activity_id := null;
  end loop;

  -- A provider Contact with exactly one Fluid deal is unambiguous even when a
  -- coarse deal-age estimate starts a few hours after the first chat message.
  if v_only_deal_id is not null then
    insert into public.deal_activity_links (
      workspace_key, activity_id, deal_id, stage_event_id, stage_name,
      attribution_method, stage_evidence, confidence, reason, metadata
    )
    select
      p_workspace_key,
      activity.id,
      v_only_deal_id,
      case when latest_event.to_stage is not null then latest_event.id end,
      latest_event.to_stage,
      'single_deal_contact',
      case when latest_event.to_stage is null then 'unknown'
        else private.stage_evidence_kind(latest_event.source, latest_event.event_kind) end,
      0.850,
      'The exact DripJobs Contact has one Fluid deal; its chat message belongs to that deal.',
      jsonb_build_object(
        'providerContactId', p_dripjobs_contact_id,
        'channelKey', p_channel_key
      )
    from public.activities activity
    left join lateral (
      select event.id, event.event_kind, event.to_stage, event.source
      from public.dripjobs_pipeline_stage_events event
      where event.workspace_key = p_workspace_key
        and event.deal_id = v_only_deal_id
        and (event.effective_at, event.id) <= (activity.occurred_at, 9223372036854775807::bigint)
      order by event.effective_at desc, event.id desc
      limit 1
    ) latest_event on true
    where activity.workspace_key = p_workspace_key
      and activity.source = 'dripjobs'
      and activity.source_metadata ->> 'dripjobsContactId' = p_dripjobs_contact_id
      and activity.source_metadata ->> 'channelKey' = p_channel_key
      and not exists (
        select 1 from public.deal_activity_links existing
        where existing.workspace_key = p_workspace_key
          and existing.activity_id = activity.id
      )
    on conflict (workspace_key, activity_id, deal_id) do nothing;
  end if;

  select count(*) into v_link_rows
  from public.deal_activity_links link
  join public.activities activity on activity.id = link.activity_id
  where activity.workspace_key = p_workspace_key
    and activity.source = 'dripjobs'
    and activity.source_metadata ->> 'dripjobsContactId' = p_dripjobs_contact_id
    and activity.source_metadata ->> 'channelKey' = p_channel_key;

  select count(*) into v_unassigned
  from public.activities activity
  where activity.workspace_key = p_workspace_key
    and activity.source = 'dripjobs'
    and activity.source_metadata ->> 'dripjobsContactId' = p_dripjobs_contact_id
    and activity.source_metadata ->> 'channelKey' = p_channel_key
    and not exists (
      select 1 from public.deal_activity_links link
      where link.workspace_key = p_workspace_key
        and link.activity_id = activity.id
    );

  return jsonb_build_object(
    'contactId', p_dripjobs_contact_id,
    'personId', v_person_id,
    'dealCount', v_deal_count,
    'inserted', v_inserted,
    'existing', v_existing,
    'linkRows', v_link_rows,
    'unassigned', v_unassigned
  );
end;
$$;

revoke all on function public.ingest_dripjobs_contact_chat_messages(text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_dripjobs_contact_chat_messages(text, text, text, text, jsonb)
  to service_role;

comment on function public.ingest_dripjobs_contact_chat_messages(text, text, text, text, jsonb) is
  'Idempotently imports one Stream Chat channel by exact DripJobs Contact and assigns messages to all matching deal date windows.';
