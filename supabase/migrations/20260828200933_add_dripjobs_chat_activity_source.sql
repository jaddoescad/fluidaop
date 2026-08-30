-- DripJobs' own chat is a communication provider, not Quo. Store its
-- messages as first-class activities so deal journeys and later analysis can
-- distinguish what was sent through DripJobs from calls/SMS handled by Quo.

alter table public.activities
  drop constraint activities_source_check,
  drop constraint activities_account_identity_check;

alter table public.activities
  add constraint activities_source_check
    check (source in ('gmail', 'quo', 'dripjobs')),
  add constraint activities_account_identity_check
    check (
      (source = 'gmail' and account_email is not null and account_phone is null)
      or
      (source = 'quo' and account_phone is not null and account_email is null)
      or
      (source = 'dripjobs' and account_email is null and account_phone is null)
    );

-- Gmail and Quo use account_key in their provider identity. DripJobs chat is
-- scoped by Fluid workspace because there is no email/phone account key.
create unique index activities_dripjobs_external_identity_key
  on public.activities (workspace_key, external_id)
  where source = 'dripjobs';

comment on index public.activities_dripjobs_external_identity_key is
  'Idempotency key for DripJobs chat messages inside one Fluid workspace.';

create or replace function public.ingest_dripjobs_chat_messages(
  p_workspace_key text,
  p_deal_id text,
  p_dripjobs_contact_id text,
  p_channel_key text,
  p_messages jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_person_id uuid;
  v_customer_name text;
  v_customer_email text;
  v_customer_phone text;
  v_message jsonb;
  v_external_id text;
  v_direction text;
  v_text text;
  v_occurred_at timestamptz;
  v_activity_id bigint;
  v_stage_event_id bigint;
  v_stage_name text;
  v_stage_evidence text;
  v_inserted integer := 0;
  v_existing integer := 0;
  v_linked integer := 0;
begin
  if p_workspace_key is null
     or p_workspace_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
     or p_deal_id is null
     or char_length(p_deal_id) > 200
     or p_dripjobs_contact_id is null
     or char_length(p_dripjobs_contact_id) > 200
     or p_channel_key is null
     or char_length(p_channel_key) not between 1 and 500 then
    raise exception 'Invalid DripJobs chat import identity';
  end if;

  if jsonb_typeof(p_messages) <> 'array'
     or jsonb_array_length(p_messages) not between 1 and 500
     or pg_column_size(p_messages) > 5242880 then
    raise exception 'DripJobs chat import must contain 1 to 500 bounded messages';
  end if;

  select deal.person_id, deal.customer_name, person.primary_email, person.primary_phone
  into v_person_id, v_customer_name, v_customer_email, v_customer_phone
  from public.dripjobs_sales_deals deal
  join public.people person
    on person.id = deal.person_id
   and person.workspace_key = p_workspace_key
   and person.status = 'active'
  where deal.deal_id = p_deal_id
    and deal.dripjobs_contact_id = p_dripjobs_contact_id;

  if v_person_id is null then
    raise exception 'DripJobs deal and Contact do not identify one active Fluid Contact';
  end if;

  for v_message in select value from jsonb_array_elements(p_messages)
  loop
    if jsonb_typeof(v_message) <> 'object' then
      raise exception 'Every DripJobs chat message must be an object';
    end if;

    v_external_id := nullif(btrim(v_message ->> 'externalId'), '');
    v_direction := nullif(btrim(v_message ->> 'direction'), '');
    v_text := nullif(btrim(v_message ->> 'text'), '');

    begin
      v_occurred_at := (v_message ->> 'occurredAt')::timestamptz;
    exception when others then
      raise exception 'Every DripJobs chat message needs a valid occurredAt';
    end;

    if v_external_id is null or char_length(v_external_id) > 500
       or v_direction not in ('inbound', 'outbound')
       or v_text is null or char_length(v_text) > 100000
       or v_occurred_at is null then
      raise exception 'Invalid DripJobs chat message';
    end if;

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
      source_labels,
      source_metadata
    ) values (
      p_workspace_key,
      'dripjobs',
      null,
      null,
      v_external_id,
      'dripjobs-chat:' || p_channel_key,
      case when v_direction = 'inbound' then 'message.received' else 'message.sent' end,
      v_direction,
      case when v_direction = 'inbound' then v_customer_name else 'Ottawa Painters' end,
      case when v_direction = 'inbound' then v_customer_email else null end,
      case when v_direction = 'inbound' then v_customer_phone else null end,
      'DripJobs chat with ' || v_customer_name,
      left(regexp_replace(v_text, '[[:space:]]+', ' ', 'g'), 500),
      v_text,
      v_occurred_at,
      array['dripjobs-chat'],
      jsonb_build_object(
        'dripjobsDealId', p_deal_id,
        'dripjobsContactId', p_dripjobs_contact_id,
        'channelKey', p_channel_key,
        'provider', 'dripjobs_chat',
        'importMethod', coalesce(nullif(v_message ->> 'importMethod', ''), 'provider_export'),
        'automated', coalesce((v_message ->> 'automated')::boolean, false)
      )
    )
    on conflict (workspace_key, external_id) where source = 'dripjobs'
      do nothing
    returning id into v_activity_id;

    if v_activity_id is null then
      select activity.id into v_activity_id
      from public.activities activity
      where activity.workspace_key = p_workspace_key
        and activity.source = 'dripjobs'
        and activity.external_id = v_external_id;
      v_existing := v_existing + 1;
    else
      v_inserted := v_inserted + 1;
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

    select event.id,
           event.to_stage,
           case
             when event.to_stage is null then 'unknown'
             else private.stage_evidence_kind(event.source, event.event_kind)
           end
    into v_stage_event_id, v_stage_name, v_stage_evidence
    from public.dripjobs_pipeline_stage_events event
    where event.workspace_key = p_workspace_key
      and event.deal_id = p_deal_id
      and (event.effective_at, event.id) <= (v_occurred_at, 9223372036854775807::bigint)
    order by event.effective_at desc, event.id desc
    limit 1;

    insert into public.deal_activity_links (
      workspace_key,
      activity_id,
      deal_id,
      stage_event_id,
      stage_name,
      attribution_method,
      stage_evidence,
      confidence,
      reason,
      metadata
    ) values (
      p_workspace_key,
      v_activity_id,
      p_deal_id,
      case when v_stage_name is not null then v_stage_event_id end,
      v_stage_name,
      'provider_deal_id',
      coalesce(v_stage_evidence, 'unknown'),
      1,
      'The imported DripJobs chat channel names this deal''s exact provider Contact.',
      jsonb_build_object(
        'providerDealId', p_deal_id,
        'providerContactId', p_dripjobs_contact_id,
        'channelKey', p_channel_key
      )
    )
    on conflict (workspace_key, activity_id, deal_id) do update
    set stage_event_id = excluded.stage_event_id,
        stage_name = excluded.stage_name,
        attribution_method = excluded.attribution_method,
        stage_evidence = excluded.stage_evidence,
        confidence = excluded.confidence,
        reason = excluded.reason,
        metadata = excluded.metadata,
        updated_at = now();

    v_linked := v_linked + 1;
    v_activity_id := null;
    v_stage_event_id := null;
    v_stage_name := null;
    v_stage_evidence := null;
  end loop;

  return jsonb_build_object(
    'dealId', p_deal_id,
    'contactId', p_dripjobs_contact_id,
    'inserted', v_inserted,
    'existing', v_existing,
    'linked', v_linked
  );
end;
$$;

revoke all on function public.ingest_dripjobs_chat_messages(text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_dripjobs_chat_messages(text, text, text, text, jsonb)
  to service_role;

comment on function public.ingest_dripjobs_chat_messages(text, text, text, text, jsonb) is
  'Idempotently imports one provider-identified DripJobs chat into Fluid activities and its exact deal journey.';
