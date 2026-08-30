-- Make a deal's stage history useful as a CRM audit trail. Activities remain
-- immutable provider events; this migration adds an evidence-bearing link to
-- exactly one deal and derives the stage window from append-only stage events.

alter table public.dripjobs_pipeline_stage_events
  drop constraint dripjobs_pipeline_stage_events_source_check;

alter table public.dripjobs_pipeline_stage_events
  add constraint dripjobs_pipeline_stage_events_source_check
  check (source in (
    'baseline',
    'zapier',
    'snapshot',
    'api',
    'webhook',
    'report_import'
  ));

create table public.deal_activity_links (
  workspace_key text not null default 'ottawa-painters'
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  activity_id bigint not null references public.activities(id) on delete cascade,
  deal_id text not null references public.dripjobs_sales_deals(deal_id) on delete cascade,
  stage_event_id bigint references public.dripjobs_pipeline_stage_events(id) on delete set null,
  stage_name text,
  attribution_method text not null check (attribution_method in (
    'provider_deal_id',
    'unique_stage_window',
    'single_deal_contact',
    'manual'
  )),
  stage_evidence text not null check (stage_evidence in (
    'exact',
    'observed',
    'inferred',
    'unknown'
  )),
  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  reason text not null check (char_length(reason) between 1 and 1000),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_key, activity_id)
);

create index deal_activity_links_deal_stage_time_idx
  on public.deal_activity_links (workspace_key, deal_id, stage_event_id, activity_id);
create index deal_activity_links_stage_event_idx
  on public.deal_activity_links (stage_event_id, activity_id)
  where stage_event_id is not null;

alter table public.deal_activity_links enable row level security;
revoke all on table public.deal_activity_links from public, anon, authenticated;
grant select, insert, update, delete on table public.deal_activity_links to service_role;

comment on table public.deal_activity_links is
  'One evidence-bearing deal attribution per customer activity. Automatic links are withheld when concurrent deals are ambiguous.';
comment on column public.deal_activity_links.stage_event_id is
  'The stage-entry event whose half-open time window contains the activity; null means the deal is known but the historical stage is not.';

create table public.deal_milestone_events (
  id bigint generated always as identity primary key,
  workspace_key text not null default 'ottawa-painters'
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  deal_id text not null references public.dripjobs_sales_deals(deal_id) on delete cascade,
  external_key text not null check (char_length(external_key) between 1 and 500),
  milestone_type text not null check (milestone_type in (
    'appointment_scheduled',
    'appointment_completed',
    'appointment_cancelled',
    'proposal_sent',
    'proposal_viewed',
    'proposal_accepted',
    'proposal_rejected'
  )),
  occurred_at timestamptz not null,
  source text not null check (source in ('api', 'webhook', 'report_import', 'manual')),
  evidence_kind text not null check (evidence_kind in ('exact', 'observed', 'inferred')),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 262144),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_key, external_key)
);

create index deal_milestone_events_deal_time_idx
  on public.deal_milestone_events (workspace_key, deal_id, occurred_at, id);

alter table public.deal_milestone_events enable row level security;
revoke all on table public.deal_milestone_events from public, anon, authenticated;
revoke all on sequence public.deal_milestone_events_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.deal_milestone_events to service_role;
grant usage, select on sequence public.deal_milestone_events_id_seq to service_role;

comment on table public.deal_milestone_events is
  'Deal-specific DripJobs milestones such as appointments and proposal lifecycle events; report-derived rows retain inferred evidence.';

create or replace function private.stage_evidence_kind(
  p_source text,
  p_event_kind text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_source in ('api', 'webhook', 'zapier') then 'exact'
    when p_source = 'report_import' then 'inferred'
    when p_source in ('snapshot', 'baseline') or p_event_kind = 'baseline' then 'observed'
    else 'unknown'
  end;
$$;

revoke all on function private.stage_evidence_kind(text, text)
  from public, anon, authenticated;
grant execute on function private.stage_evidence_kind(text, text)
  to service_role;

create or replace function private.reconcile_person_deal_activity_links(
  p_workspace_key text,
  p_person_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_provider integer := 0;
  v_window integer := 0;
  v_single_deal integer := 0;
begin
  if p_workspace_key is null or p_person_id is null then
    return jsonb_build_object(
      'personId', p_person_id,
      'deleted', 0,
      'provider', 0,
      'stageWindow', 0,
      'singleDeal', 0
    );
  end if;

  delete from public.deal_activity_links link
  using public.dripjobs_sales_deals deal
  where link.workspace_key = p_workspace_key
    and link.deal_id = deal.deal_id
    and deal.person_id = p_person_id
    and link.attribution_method <> 'manual';
  get diagnostics v_deleted = row_count;

  -- An explicit provider deal id is the strongest evidence. The Contact must
  -- still agree so a malformed payload cannot silently cross-link people.
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
  )
  select
    p_workspace_key,
    activity.id,
    deal.deal_id,
    case when latest_event.to_stage is not null then latest_event.id end,
    latest_event.to_stage,
    'provider_deal_id',
    case
      when latest_event.to_stage is null then 'unknown'
      else private.stage_evidence_kind(latest_event.source, latest_event.event_kind)
    end,
    1,
    'The provider payload names this exact deal and its canonical Contact agrees.',
    jsonb_build_object('providerDealId', deal.deal_id)
  from public.activity_people person_link
  join public.activities activity
    on activity.id = person_link.activity_id
   and activity.workspace_key = p_workspace_key
  join public.dripjobs_sales_deals deal
    on deal.person_id = p_person_id
   and deal.deal_id = coalesce(
     nullif(activity.source_metadata ->> 'dripjobsDealId', ''),
     nullif(activity.source_metadata ->> 'dealId', '')
   )
  left join lateral (
    select event.id, event.event_kind, event.to_stage, event.source
    from public.dripjobs_pipeline_stage_events event
    where event.workspace_key = p_workspace_key
      and event.deal_id = deal.deal_id
      and (event.effective_at, event.id) <= (activity.occurred_at, 9223372036854775807::bigint)
    order by event.effective_at desc, event.id desc
    limit 1
  ) latest_event on true
  where person_link.person_id = p_person_id
    and person_link.relationship = 'counterparty'
    and activity.occurred_at < coalesce(deal.archived_at, 'infinity'::timestamptz)
  on conflict (workspace_key, activity_id) do nothing;
  get diagnostics v_provider = row_count;

  -- A time window is deterministic only when exactly one of this Contact's
  -- deals was in a known stage at that instant. Overlapping deals are omitted.
  with candidates as materialized (
    select
      activity.id as activity_id,
      deal.deal_id,
      latest_event.id as stage_event_id,
      latest_event.to_stage as stage_name,
      latest_event.source,
      latest_event.event_kind,
      count(*) over (partition by activity.id) as candidate_count
    from public.activity_people person_link
    join public.activities activity
      on activity.id = person_link.activity_id
     and activity.workspace_key = p_workspace_key
    join public.dripjobs_sales_deals deal
      on deal.person_id = p_person_id
    join lateral (
      select event.id, event.event_kind, event.to_stage, event.source
      from public.dripjobs_pipeline_stage_events event
      where event.workspace_key = p_workspace_key
        and event.deal_id = deal.deal_id
        and (event.effective_at, event.id) <= (activity.occurred_at, 9223372036854775807::bigint)
      order by event.effective_at desc, event.id desc
      limit 1
    ) latest_event on latest_event.to_stage is not null
    where person_link.person_id = p_person_id
      and person_link.relationship = 'counterparty'
      and activity.occurred_at < coalesce(deal.archived_at, 'infinity'::timestamptz)
  )
  insert into public.deal_activity_links (
    workspace_key,
    activity_id,
    deal_id,
    stage_event_id,
    stage_name,
    attribution_method,
    stage_evidence,
    confidence,
    reason
  )
  select
    p_workspace_key,
    candidate.activity_id,
    candidate.deal_id,
    candidate.stage_event_id,
    candidate.stage_name,
    'unique_stage_window',
    private.stage_evidence_kind(candidate.source, candidate.event_kind),
    case private.stage_evidence_kind(candidate.source, candidate.event_kind)
      when 'exact' then 1
      when 'observed' then 0.850
      when 'inferred' then 0.650
      else 0.400
    end,
    'This was the Contact''s only deal with a known stage window at the activity time.'
  from candidates candidate
  where candidate.candidate_count = 1
  on conflict (workspace_key, activity_id) do nothing;
  get diagnostics v_window = row_count;

  -- Older activity before Fluid's first stage observation remains useful when
  -- the Contact has exactly one deal. It is deliberately kept out of a stage.
  with one_deal as (
    select min(deal.deal_id) as deal_id
    from public.dripjobs_sales_deals deal
    where deal.person_id = p_person_id
    having count(*) = 1
  )
  insert into public.deal_activity_links (
    workspace_key,
    activity_id,
    deal_id,
    stage_event_id,
    stage_name,
    attribution_method,
    stage_evidence,
    confidence,
    reason
  )
  select
    p_workspace_key,
    activity.id,
    deal.deal_id,
    null,
    null,
    'single_deal_contact',
    'unknown',
    0.500,
    'The Contact has one deal, but Fluid does not have a reliable stage boundary for this activity.'
  from one_deal
  join public.dripjobs_sales_deals deal on deal.deal_id = one_deal.deal_id
  join public.activity_people person_link
    on person_link.person_id = p_person_id
   and person_link.relationship = 'counterparty'
  join public.activities activity
    on activity.id = person_link.activity_id
   and activity.workspace_key = p_workspace_key
  where activity.occurred_at >= coalesce(
      deal.estimated_created_at - case deal.created_at_method
        when 'sales_list_deal_age_h' then interval '1 hour'
        when 'sales_list_deal_age_d' then interval '1 day'
        when 'sales_list_deal_age_mo' then interval '1 month'
        when 'sales_list_deal_age_y' then interval '1 year'
        else interval '30 days'
      end,
      deal.first_seen_at - interval '90 days'
    )
    and activity.occurred_at < coalesce(deal.archived_at, 'infinity'::timestamptz)
  on conflict (workspace_key, activity_id) do nothing;
  get diagnostics v_single_deal = row_count;

  return jsonb_build_object(
    'personId', p_person_id,
    'deleted', v_deleted,
    'provider', v_provider,
    'stageWindow', v_window,
    'singleDeal', v_single_deal
  );
end;
$$;

revoke all on function private.reconcile_person_deal_activity_links(text, uuid)
  from public, anon, authenticated;
grant execute on function private.reconcile_person_deal_activity_links(text, uuid)
  to service_role;

create or replace function private.reconcile_deal_links_after_activity_person()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_key text;
begin
  if tg_op in ('DELETE', 'UPDATE') and old.relationship = 'counterparty' then
    select activity.workspace_key into v_workspace_key
    from public.activities activity
    where activity.id = old.activity_id;
    perform private.reconcile_person_deal_activity_links(v_workspace_key, old.person_id);
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.relationship = 'counterparty' then
    select activity.workspace_key into v_workspace_key
    from public.activities activity
    where activity.id = new.activity_id;
    perform private.reconcile_person_deal_activity_links(v_workspace_key, new.person_id);
  end if;
  return coalesce(new, old);
end;
$$;

create trigger activity_people_reconcile_deal_links
after insert or update or delete on public.activity_people
for each row execute function private.reconcile_deal_links_after_activity_person();

create or replace function private.reconcile_deal_links_after_activity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  linked_person record;
begin
  for linked_person in
    select distinct link.person_id
    from public.activity_people link
    where link.activity_id = new.id
      and link.relationship = 'counterparty'
  loop
    perform private.reconcile_person_deal_activity_links(new.workspace_key, linked_person.person_id);
  end loop;
  return new;
end;
$$;

create trigger activities_reconcile_deal_links
after update of occurred_at, workspace_key, source_metadata on public.activities
for each row
when (
  old.occurred_at is distinct from new.occurred_at
  or old.workspace_key is distinct from new.workspace_key
  or old.source_metadata is distinct from new.source_metadata
)
execute function private.reconcile_deal_links_after_activity_change();

create or replace function private.reconcile_deal_links_after_stage_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal_id text := coalesce(new.deal_id, old.deal_id);
  v_workspace_key text := coalesce(new.workspace_key, old.workspace_key);
  v_person_id uuid;
begin
  select deal.person_id into v_person_id
  from public.dripjobs_sales_deals deal
  where deal.deal_id = v_deal_id;
  perform private.reconcile_person_deal_activity_links(v_workspace_key, v_person_id);
  return coalesce(new, old);
end;
$$;

create trigger dripjobs_stage_events_reconcile_deal_links
after insert or update or delete on public.dripjobs_pipeline_stage_events
for each row execute function private.reconcile_deal_links_after_stage_event();

create or replace function private.reconcile_deal_links_after_deal_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.person_id is not null
     and old.person_id is distinct from new.person_id then
    perform private.reconcile_person_deal_activity_links('ottawa-painters', old.person_id);
  end if;
  perform private.reconcile_person_deal_activity_links('ottawa-painters', new.person_id);
  return new;
end;
$$;

create trigger dripjobs_deals_reconcile_activity_links
after insert or update of person_id, archived_at, estimated_created_at, created_at_method
on public.dripjobs_sales_deals
for each row execute function private.reconcile_deal_links_after_deal_change();

revoke all on function private.reconcile_deal_links_after_activity_person()
  from public, anon, authenticated;
revoke all on function private.reconcile_deal_links_after_activity_change()
  from public, anon, authenticated;
revoke all on function private.reconcile_deal_links_after_stage_event()
  from public, anon, authenticated;
revoke all on function private.reconcile_deal_links_after_deal_change()
  from public, anon, authenticated;

-- Run the deterministic initial attribution without fabricating stage history.
do $$
declare
  candidate record;
begin
  for candidate in
    select distinct deal.person_id
    from public.dripjobs_sales_deals deal
    where deal.person_id is not null
  loop
    perform private.reconcile_person_deal_activity_links('ottawa-painters', candidate.person_id);
  end loop;
end;
$$;

create or replace function public.record_dripjobs_deal_milestone(
  p_workspace_key text,
  p_external_key text,
  p_deal_id text,
  p_milestone_type text,
  p_occurred_at timestamptz,
  p_source text,
  p_evidence_kind text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_event public.deal_milestone_events;
begin
  if not exists (
    select 1
    from public.dripjobs_sales_deals deal
    where deal.deal_id = p_deal_id
  ) then
    raise exception 'Unknown DripJobs deal id';
  end if;

  insert into public.deal_milestone_events (
    workspace_key,
    external_key,
    deal_id,
    milestone_type,
    occurred_at,
    source,
    evidence_kind,
    metadata
  ) values (
    p_workspace_key,
    p_external_key,
    p_deal_id,
    p_milestone_type,
    p_occurred_at,
    p_source,
    p_evidence_kind,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (workspace_key, external_key) do update set
    deal_id = excluded.deal_id,
    milestone_type = excluded.milestone_type,
    occurred_at = excluded.occurred_at,
    source = excluded.source,
    evidence_kind = excluded.evidence_kind,
    metadata = excluded.metadata,
    updated_at = now()
  returning * into v_event;

  return jsonb_build_object(
    'id', v_event.id,
    'dealId', v_event.deal_id,
    'milestoneType', v_event.milestone_type,
    'occurredAt', v_event.occurred_at,
    'evidenceKind', v_event.evidence_kind
  );
end;
$$;

revoke all on function public.record_dripjobs_deal_milestone(
  text, text, text, text, timestamptz, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.record_dripjobs_deal_milestone(
  text, text, text, text, timestamptz, text, text, jsonb
) to service_role;

create or replace function public.list_dripjobs_pipeline_history(
  p_workspace_key text,
  p_deal_id text,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with all_events as (
    select
      event.*,
      lead(event.effective_at) over (
        order by event.effective_at, event.id
      ) as next_effective_at,
      lead(event.event_kind) over (
        order by event.effective_at, event.id
      ) as next_event_kind,
      lead(event.to_stage) over (
        order by event.effective_at, event.id
      ) as next_to_stage
    from public.dripjobs_pipeline_stage_events event
    where event.workspace_key = p_workspace_key
      and event.deal_id = p_deal_id
  ),
  selected_events as (
    select event.*
    from all_events event
    where event.id in (
      select recent.id
      from all_events recent
      order by recent.effective_at desc, recent.id desc
      limit least(greatest(coalesce(p_limit, 100), 1), 500)
    )
  ),
  activity_touchpoints as (
    select
      link.stage_event_id,
      'activity'::text as touchpoint_kind,
      ('activity:' || activity.id)::text as touchpoint_id,
      activity.id as activity_id,
      null::bigint as milestone_id,
      activity.occurred_at,
      activity.source,
      activity.event_type,
      case
        when activity.event_type = 'call.completed' then 'call'
        when activity.event_type like 'email.%' then 'email'
        when activity.event_type like 'message.%' then 'sms'
        else 'other'
      end as channel,
      activity.direction,
      activity.subject,
      activity.preview,
      activity.call_status,
      activity.duration_seconds,
      lower(coalesce(activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes') as is_automated,
      transcript.status as transcript_status,
      left(transcript.transcript_text, 500) as transcript_excerpt,
      link.attribution_method,
      link.stage_evidence as evidence_kind
    from public.deal_activity_links link
    join public.activities activity on activity.id = link.activity_id
    left join public.activity_call_transcripts transcript
      on transcript.activity_id = activity.id
     and transcript.workspace_key = p_workspace_key
    where link.workspace_key = p_workspace_key
      and link.deal_id = p_deal_id
  ),
  milestone_touchpoints as (
    select
      case when latest_event.to_stage is not null then latest_event.id end as stage_event_id,
      'milestone'::text as touchpoint_kind,
      ('milestone:' || milestone.id)::text as touchpoint_id,
      null::bigint as activity_id,
      milestone.id as milestone_id,
      milestone.occurred_at,
      milestone.source,
      milestone.milestone_type as event_type,
      'milestone'::text as channel,
      null::text as direction,
      case milestone.milestone_type
        when 'appointment_scheduled' then 'Appointment scheduled'
        when 'appointment_completed' then 'Appointment completed'
        when 'appointment_cancelled' then 'Appointment cancelled'
        when 'proposal_sent' then 'Proposal sent'
        when 'proposal_viewed' then 'Proposal viewed'
        when 'proposal_accepted' then 'Proposal accepted'
        when 'proposal_rejected' then 'Proposal rejected'
      end as subject,
      coalesce(milestone.metadata ->> 'summary', '') as preview,
      null::text as call_status,
      null::integer as duration_seconds,
      false as is_automated,
      null::text as transcript_status,
      null::text as transcript_excerpt,
      'provider_deal_id'::text as attribution_method,
      milestone.evidence_kind
    from public.deal_milestone_events milestone
    left join lateral (
      select event.id, event.to_stage
      from all_events event
      where (event.effective_at, event.id) <= (
        milestone.occurred_at,
        9223372036854775807::bigint
      )
      order by event.effective_at desc, event.id desc
      limit 1
    ) latest_event on true
    where milestone.workspace_key = p_workspace_key
      and milestone.deal_id = p_deal_id
  ),
  touchpoints as (
    select * from activity_touchpoints
    union all
    select * from milestone_touchpoints
  ),
  ranked_touchpoints as (
    select
      touchpoint.*,
      row_number() over (
        order by touchpoint.occurred_at desc, touchpoint.touchpoint_id desc
      ) as display_rank
    from touchpoints touchpoint
  ),
  touchpoint_json as (
    select
      touchpoint.*,
      jsonb_build_object(
        'id', touchpoint.touchpoint_id,
        'kind', touchpoint.touchpoint_kind,
        'activityId', touchpoint.activity_id,
        'milestoneId', touchpoint.milestone_id,
        'source', touchpoint.source,
        'eventType', touchpoint.event_type,
        'channel', touchpoint.channel,
        'direction', touchpoint.direction,
        'occurredAt', touchpoint.occurred_at,
        'subject', touchpoint.subject,
        'preview', touchpoint.preview,
        'callStatus', touchpoint.call_status,
        'durationSeconds', touchpoint.duration_seconds,
        'isAutomated', touchpoint.is_automated,
        'transcriptStatus', touchpoint.transcript_status,
        'transcriptExcerpt', touchpoint.transcript_excerpt,
        'attributionMethod', touchpoint.attribution_method,
        'evidenceKind', touchpoint.evidence_kind
      ) as item
    from ranked_touchpoints touchpoint
    where touchpoint.display_rank <= 1000
  ),
  touchpoint_lists as (
    select
      touchpoint.stage_event_id,
      jsonb_agg(touchpoint.item order by touchpoint.occurred_at, touchpoint.touchpoint_id) as items
    from touchpoint_json touchpoint
    group by touchpoint.stage_event_id
  ),
  touchpoint_metrics as (
    select
      touchpoint.stage_event_id,
      jsonb_build_object(
        'total', count(*),
        'outboundCallAttempts', count(*) filter (
          where touchpoint.event_type = 'call.completed'
            and touchpoint.direction = 'outbound'
        ),
        'connectedCalls', count(*) filter (
          where touchpoint.event_type = 'call.completed'
            and (
              coalesce(touchpoint.duration_seconds, 0) > 0
              or lower(coalesce(touchpoint.call_status, '')) in ('answered', 'connected')
            )
        ),
        'missedInboundCalls', count(*) filter (
          where touchpoint.event_type = 'call.completed'
            and touchpoint.direction = 'inbound'
            and lower(coalesce(touchpoint.call_status, '')) in (
              'missed', 'no-answer', 'no_answer', 'cancelled', 'canceled', 'failed'
            )
        ),
        'inboundSms', count(*) filter (
          where touchpoint.channel = 'sms' and touchpoint.direction = 'inbound'
        ),
        'outboundSms', count(*) filter (
          where touchpoint.channel = 'sms' and touchpoint.direction = 'outbound'
        ),
        'inboundEmails', count(*) filter (
          where touchpoint.channel = 'email' and touchpoint.direction = 'inbound'
        ),
        'outboundEmails', count(*) filter (
          where touchpoint.channel = 'email' and touchpoint.direction = 'outbound'
        ),
        'milestones', count(*) filter (where touchpoint.touchpoint_kind = 'milestone')
      ) as metrics
    from touchpoints touchpoint
    group by touchpoint.stage_event_id
  ),
  zero_metrics as (
    select jsonb_build_object(
      'total', 0,
      'outboundCallAttempts', 0,
      'connectedCalls', 0,
      'missedInboundCalls', 0,
      'inboundSms', 0,
      'outboundSms', 0,
      'inboundEmails', 0,
      'outboundEmails', 0,
      'milestones', 0
    ) as metrics
  ),
  target_deal as (
    select deal.*
    from public.dripjobs_sales_deals deal
    where deal.deal_id = p_deal_id
  )
  select jsonb_build_object(
    'dealId', p_deal_id,
    'currentStage', (select deal.deal_stage from target_deal deal),
    'stageEnteredAt', (select deal.stage_entered_at from target_deal deal),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', event.id,
        'eventKind', event.event_kind,
        'fromStage', event.from_stage,
        'toStage', event.to_stage,
        'effectiveAt', event.effective_at,
        'observedAt', event.observed_at,
        'source', event.source,
        'evidenceKind', private.stage_evidence_kind(event.source, event.event_kind),
        'durationSeconds', case
          when event.to_stage is null then null
          else extract(epoch from (
            coalesce(event.next_effective_at, now()) - event.effective_at
          ))::bigint
        end,
        'baseline', event.event_kind = 'baseline'
      ) order by event.effective_at, event.id)
      from selected_events event
    ), '[]'::jsonb),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'stageEventId', event.id,
        'stage', event.to_stage,
        'enteredAt', event.effective_at,
        'exitedAt', event.next_effective_at,
        'durationSeconds', extract(epoch from (
          coalesce(event.next_effective_at, now()) - event.effective_at
        ))::bigint,
        'evidenceKind', private.stage_evidence_kind(event.source, event.event_kind),
        'outcome', jsonb_build_object(
          'kind', case
            when event.next_event_kind is null then 'current'
            when event.next_event_kind = 'archived' then 'archived'
            else 'stage_changed'
          end,
          'toStage', event.next_to_stage,
          'at', event.next_effective_at
        ),
        'metrics', coalesce(metrics.metrics, zero.metrics),
        'touchpoints', coalesce(list.items, '[]'::jsonb)
      ) order by event.effective_at, event.id)
      from selected_events event
      cross join zero_metrics zero
      left join touchpoint_metrics metrics on metrics.stage_event_id = event.id
      left join touchpoint_lists list on list.stage_event_id = event.id
      where event.to_stage is not null
    ), '[]'::jsonb),
    'unknownStage', jsonb_build_object(
      'label', 'Before tracking / stage unknown',
      'metrics', coalesce((
        select metrics.metrics
        from touchpoint_metrics metrics
        where metrics.stage_event_id is null
      ), (select zero.metrics from zero_metrics zero)),
      'touchpoints', coalesce((
        select list.items
        from touchpoint_lists list
        where list.stage_event_id is null
      ), '[]'::jsonb)
    ),
    'attribution', jsonb_build_object(
      'attributedActivityCount', (
        select count(*)
        from public.deal_activity_links link
        where link.workspace_key = p_workspace_key
          and link.deal_id = p_deal_id
      ),
      'manualActivityCount', (
        select count(*)
        from public.deal_activity_links link
        where link.workspace_key = p_workspace_key
          and link.deal_id = p_deal_id
          and link.attribution_method = 'manual'
      ),
      'unassignedActivityCount', (
        select count(distinct activity.id)
        from target_deal deal
        join public.activity_people person_link
          on person_link.person_id = deal.person_id
         and person_link.relationship = 'counterparty'
        join public.activities activity
          on activity.id = person_link.activity_id
         and activity.workspace_key = p_workspace_key
        where not exists (
          select 1
          from public.deal_activity_links assigned
          where assigned.workspace_key = p_workspace_key
            and assigned.activity_id = activity.id
        )
      )
    ),
    'touchpointsTruncated', (select count(*) > 1000 from touchpoints),
    'returnedTouchpointCount', least((select count(*) from touchpoints), 1000)
  );
$$;

revoke all on function public.list_dripjobs_pipeline_history(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_dripjobs_pipeline_history(text, text, integer)
  to service_role;

comment on function public.list_dripjobs_pipeline_history(text, text, integer) is
  'Returns stage windows, evidence labels, attributed communications, milestones, outcomes, transcript availability, and per-stage touchpoint metrics for one deal.';
