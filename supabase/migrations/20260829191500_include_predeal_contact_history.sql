-- A deal boundary controls attribution and stage metrics; it must never hide
-- the customer's earlier conversation. Return pre-deal contact history as a
-- separate read-only section so it is visible without assigning it to the new
-- deal or changing that deal's conversion/touchpoint numbers.

create or replace function private.contact_history_before_deal(
  p_workspace_key text,
  p_deal_id text,
  p_limit integer default 1000
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with target_deal as (
    select
      deal.person_id,
      coalesce(deal.estimated_created_at, deal.first_seen_at) as deal_created_at
    from public.dripjobs_sales_deals deal
    join public.people person
      on person.id = deal.person_id
     and person.workspace_key = p_workspace_key
    where deal.deal_id = p_deal_id
  ),
  prior_activity as (
    select distinct on (activity.id)
      activity.id as activity_id,
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
      lower(coalesce(activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes')
        as is_automated,
      transcript.status as transcript_status,
      left(transcript.transcript_text, 500) as transcript_excerpt
    from target_deal deal
    join public.activity_people person_link
      on person_link.person_id = deal.person_id
     and person_link.relationship = 'counterparty'
    join public.activities activity
      on activity.id = person_link.activity_id
     and activity.workspace_key = p_workspace_key
    left join public.activity_call_transcripts transcript
      on transcript.activity_id = activity.id
     and transcript.workspace_key = p_workspace_key
    where activity.occurred_at < deal.deal_created_at
    order by activity.id
  ),
  ranked as (
    select
      activity.*,
      row_number() over (
        order by activity.occurred_at desc, activity.activity_id desc
      ) as display_rank
    from prior_activity activity
  ),
  selected as (
    select *
    from ranked
    where display_rank <= least(greatest(coalesce(p_limit, 1000), 1), 1000)
  ),
  touchpoints as (
    select jsonb_build_object(
      'id', 'activity:' || activity.activity_id,
      'kind', 'activity',
      'activityId', activity.activity_id,
      'milestoneId', null,
      'source', activity.source,
      'eventType', activity.event_type,
      'channel', activity.channel,
      'direction', activity.direction,
      'occurredAt', activity.occurred_at,
      'subject', activity.subject,
      'preview', activity.preview,
      'callStatus', activity.call_status,
      'durationSeconds', activity.duration_seconds,
      'isAutomated', activity.is_automated,
      'transcriptStatus', activity.transcript_status,
      'transcriptExcerpt', activity.transcript_excerpt,
      'attributionMethod', 'contact_history',
      'evidenceKind', 'unknown'
    ) as item,
    activity.occurred_at,
    activity.activity_id
    from selected activity
  ),
  metrics as (
    select jsonb_build_object(
      'total', count(*),
      'outboundCallAttempts', count(*) filter (
        where activity.event_type = 'call.completed' and activity.direction = 'outbound'
      ),
      'connectedCalls', count(*) filter (
        where activity.event_type = 'call.completed'
          and (
            coalesce(activity.duration_seconds, 0) > 0
            or lower(coalesce(activity.call_status, '')) in ('answered', 'connected')
          )
      ),
      'missedInboundCalls', count(*) filter (
        where activity.event_type = 'call.completed'
          and activity.direction = 'inbound'
          and lower(coalesce(activity.call_status, '')) in (
            'missed', 'no-answer', 'no_answer', 'cancelled', 'canceled', 'failed'
          )
      ),
      'inboundSms', count(*) filter (
        where activity.channel = 'sms' and activity.direction = 'inbound'
      ),
      'outboundSms', count(*) filter (
        where activity.channel = 'sms' and activity.direction = 'outbound'
      ),
      'inboundEmails', count(*) filter (
        where activity.channel = 'email' and activity.direction = 'inbound'
      ),
      'outboundEmails', count(*) filter (
        where activity.channel = 'email' and activity.direction = 'outbound'
      ),
      'milestones', 0
    ) as value
    from prior_activity activity
  )
  select jsonb_build_object(
    'label', 'Before this deal',
    'total', (select count(*) from prior_activity),
    'returnedCount', (select count(*) from selected),
    'truncated', (select count(*) > least(greatest(coalesce(p_limit, 1000), 1), 1000) from prior_activity),
    'earliestAt', (select min(activity.occurred_at) from prior_activity activity),
    'latestAt', (select max(activity.occurred_at) from prior_activity activity),
    'metrics', (select metrics.value from metrics),
    'touchpoints', coalesce((
      select jsonb_agg(touchpoint.item order by touchpoint.occurred_at, touchpoint.activity_id)
      from touchpoints touchpoint
    ), '[]'::jsonb)
  );
$$;

revoke all on function private.contact_history_before_deal(text, text, integer)
  from public, anon, authenticated;
grant execute on function private.contact_history_before_deal(text, text, integer)
  to service_role;

create or replace function public.list_dripjobs_deal_journey(
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
  with target_deal as (
    select
      deal.person_id,
      coalesce(deal.estimated_created_at, deal.first_seen_at) as deal_created_at,
      deal.archived_at as deal_ended_at,
      case
        when deal.created_at_method in ('api_created_at', 'dripjobs_created_at', 'webhook_created_at') then 'exact'
        when deal.estimated_created_at is not null then 'inferred'
        else 'observed'
      end as deal_created_evidence_kind,
      case
        when deal.created_at_method in ('api_created_at', 'dripjobs_created_at', 'webhook_created_at') then 'DripJobs created date'
        when deal.created_at_method = 'report_import_created_date' then 'Imported DripJobs lead date'
        when deal.estimated_created_at is not null then 'Estimated from DripJobs deal age'
        else 'First seen by Fluid'
      end as deal_created_label,
      coalesce(deal.created_at_method, 'first_seen_at') as deal_created_method,
      coalesce(
        deal.created_at_confidence,
        case when deal.estimated_created_at is null then 1::numeric else 0.6::numeric end
      ) as deal_created_confidence
    from public.dripjobs_sales_deals deal
    join public.people person
      on person.id = deal.person_id
     and person.workspace_key = p_workspace_key
    where deal.deal_id = p_deal_id
  ),
  scoped_unassigned as (
    select count(distinct activity.id) as activity_count
    from target_deal deal
    join public.activity_people person_link
      on person_link.person_id = deal.person_id
     and person_link.relationship = 'counterparty'
    join public.activities activity
      on activity.id = person_link.activity_id
     and activity.workspace_key = p_workspace_key
    where activity.occurred_at >= deal.deal_created_at
      and activity.occurred_at < coalesce(deal.deal_ended_at, 'infinity'::timestamptz)
      and not exists (
        select 1
        from public.deal_activity_links assigned
        where assigned.workspace_key = p_workspace_key
          and assigned.activity_id = activity.id
          and assigned.deal_id = p_deal_id
      )
  ),
  journey as (
    select public.list_dripjobs_pipeline_history(p_workspace_key, p_deal_id, p_limit)
      || coalesce((
        select jsonb_build_object(
          'dealCreatedAt', deal.deal_created_at,
          'dealCreatedEvidenceKind', deal.deal_created_evidence_kind,
          'dealCreatedLabel', deal.deal_created_label,
          'dealCreatedMethod', deal.deal_created_method,
          'dealCreatedConfidence', deal.deal_created_confidence
        )
        from target_deal deal
      ), '{}'::jsonb)
      || jsonb_build_object(
        'priorHistory', private.contact_history_before_deal(p_workspace_key, p_deal_id, 1000)
      ) as value
  )
  select jsonb_set(
    journey.value,
    '{attribution,unassignedActivityCount}',
    to_jsonb(coalesce((select activity_count from scoped_unassigned), 0)),
    true
  )
  from journey;
$$;

revoke all on function public.list_dripjobs_deal_journey(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.list_dripjobs_deal_journey(text, text, integer)
  to service_role;

comment on function private.contact_history_before_deal(text, text, integer) is
  'Returns customer communications before a selected deal began, without attributing them to that deal.';

comment on function public.list_dripjobs_deal_journey(text, text, integer) is
  'Returns pre-deal customer context plus the selected deal lifecycle, communications, outcomes, and evidence.';
