-- Potential Leads: the touch-day strip.
--
-- The same squares the pipeline cards carry, so a candidate reads the way a
-- deal does: one cell a day since they first reached us, lit by who spoke
-- that day (3 they wrote, 2 we reached out, 1 automated). A candidate has no
-- deal links; their conversation is every Gmail/Quo activity whose
-- counterparty identity is the candidate's email or phone — identity
-- resolution links the counterparty as 'actor' on inbound and outbound rows
-- alike, so one join finds both sides.

create or replace function private.lead_candidate_touches(
  p_workspace_key text,
  p_candidate_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  with candidate as (
    select
      lead.id,
      lead.workspace_key,
      activity.occurred_at as first_contact_at,
      private.fluid_normalize_email(lead.contact_email) as email_value,
      private.fluid_normalize_phone(lead.contact_phone) as phone_value
    from public.lead_candidates lead
    join public.activities activity on activity.id = lead.activity_id
    where lead.workspace_key = p_workspace_key
      and lead.id = p_candidate_id
  ),
  boundary as (
    select least(pg_catalog.now(), candidate.first_contact_at) as phase_started_at
    from candidate
  ),
  their_identity as (
    select identity.id
    from candidate
    join public.identities identity
      on identity.workspace_key = candidate.workspace_key
     and (
       (identity.kind = 'email' and candidate.email_value is not null
         and identity.normalized_value = candidate.email_value)
       or (identity.kind = 'phone' and candidate.phone_value is not null
         and identity.normalized_value = candidate.phone_value)
     )
  ),
  touch as (
    select distinct
      activity.id as activity_id,
      activity.direction,
      activity.occurred_at,
      lower(coalesce(activity.source_metadata ->> 'automated', 'false')) in ('true', '1', 'yes')
        as is_automated
    from their_identity
    join public.activity_identities link
      on link.identity_id = their_identity.id
     and link.relationship = 'actor'
    join public.activities activity on activity.id = link.activity_id
    cross join boundary
    where activity.workspace_key = p_workspace_key
      and activity.source in ('gmail', 'quo')
      and activity.occurred_at >= boundary.phase_started_at
  ),
  bounds as (
    select
      (pg_catalog.now() at time zone 'America/Toronto')::date as today,
      (boundary.phase_started_at at time zone 'America/Toronto')::date as entered_on
    from boundary
  ),
  strip_day as (
    select generated::date as on_date
    from bounds
    cross join generate_series(
      greatest(bounds.entered_on, bounds.today - 15)::timestamp,
      bounds.today::timestamp,
      interval '1 day'
    ) as generated
  ),
  day_level as (
    select
      strip_day.on_date,
      case
        when count(touch.activity_id) filter (
          where touch.direction = 'inbound' and not touch.is_automated
        ) > 0 then 3
        when count(touch.activity_id) filter (
          where touch.direction = 'outbound' and not touch.is_automated
        ) > 0 then 2
        when count(touch.activity_id) filter (where touch.is_automated) > 0 then 1
        else 0
      end as level
    from strip_day
    left join touch
      on (touch.occurred_at at time zone 'America/Toronto')::date = strip_day.on_date
    group by strip_day.on_date
  )
  select jsonb_build_object(
    'outbound', count(touch.activity_id) filter (
      where touch.direction = 'outbound' and not touch.is_automated
    ),
    'inbound', count(touch.activity_id) filter (
      where touch.direction = 'inbound' and not touch.is_automated
    ),
    'automated', count(touch.activity_id) filter (where touch.is_automated),
    'lastAt', max(touch.occurred_at) filter (where not touch.is_automated),
    'lastDirection', (
      array_agg(touch.direction order by touch.occurred_at desc, touch.activity_id desc)
        filter (where not touch.is_automated)
    )[1],
    'phase', 'first_contact',
    'phaseLabel', 'First contact',
    'phaseStartedAt', (select boundary.phase_started_at from boundary),
    'evidenceKind', 'exact',
    'days', (
      select coalesce(jsonb_agg(day_level.level order by day_level.on_date), '[]'::jsonb)
      from day_level
    ),
    'daysBefore', (
      select coalesce(greatest(0, (bounds.today - bounds.entered_on) - 15), 0)
      from bounds
    )
  )
  from touch;
$$;

revoke all on function private.lead_candidate_touches(text, bigint)
  from public, anon, authenticated;
grant execute on function private.lead_candidate_touches(text, bigint)
  to service_role;

comment on function private.lead_candidate_touches(text, bigint) is
  'Touch counts and day strip for one Potential Lead, from their first contact to today, over every Gmail/Quo activity with their email or phone as counterparty.';

create or replace function public.list_lead_candidates(
  p_workspace_key text default 'ottawa-painters',
  p_limit integer default 100
)
returns jsonb
language sql
stable
set search_path = 'pg_catalog', 'public'
as $$
  with visible as (
    select
      candidate.*,
      activity.subject as signal_subject,
      activity.preview as signal_preview,
      activity.occurred_at as signal_at,
      activity.direction as signal_direction,
      activity.source as signal_source,
      activity.event_type as signal_event_type,
      activity.actor_name as signal_actor_name,
      activity.call_status as signal_call_status,
      activity.duration_seconds as signal_duration_seconds,
      case when call_summary.status = 'available' and jsonb_typeof(call_summary.summary) = 'array'
        then call_summary.summary else null end as signal_call_summary,
      transcript.status as signal_transcript_status
    from public.lead_candidates candidate
    join public.activities activity on activity.id = candidate.activity_id
    left join public.activity_call_summaries call_summary
      on call_summary.activity_id = candidate.activity_id
     and call_summary.workspace_key = candidate.workspace_key
    left join public.activity_call_transcripts transcript
      on transcript.activity_id = candidate.activity_id
    where candidate.workspace_key = p_workspace_key
      and not exists (
        select 1
        from public.activity_people link
        join public.people person on person.id = link.person_id
        where link.activity_id = candidate.activity_id
          and link.relationship = 'counterparty'
          and person.status = 'active'
      )
      and not exists (
        select 1
        from public.activity_identities link
        join public.person_identity_claims claim
          on claim.identity_id = link.identity_id and claim.active
        join public.people person
          on person.id = claim.person_id and person.status = 'active'
        where link.activity_id = candidate.activity_id
          and link.relationship = 'actor'
      )
      and not exists (
        select 1
        from public.identities identity
        join public.person_identity_claims claim
          on claim.identity_id = identity.id and claim.active
        join public.people person
          on person.id = claim.person_id and person.status = 'active'
        where identity.workspace_key = candidate.workspace_key
          and (
            (identity.kind = 'email' and identity.normalized_value = private.fluid_normalize_email(candidate.contact_email))
            or (identity.kind = 'phone' and identity.normalized_value = private.fluid_normalize_phone(candidate.contact_phone))
          )
      )
    order by (candidate.disposition = 'undecided') desc,
      coalesce(candidate.decided_at, candidate.created_at) desc,
      candidate.id desc
    limit least(greatest(p_limit, 1), 500)
  )
  select jsonb_build_object(
    'undecidedCount', (
      select count(*)::int
      from public.lead_candidates candidate
      where candidate.workspace_key = p_workspace_key
        and candidate.disposition = 'undecided'
        and not exists (
          select 1
          from public.activity_people link
          join public.people person on person.id = link.person_id
          where link.activity_id = candidate.activity_id
            and link.relationship = 'counterparty'
            and person.status = 'active'
        )
        and not exists (
          select 1
          from public.activity_identities link
          join public.person_identity_claims claim
            on claim.identity_id = link.identity_id and claim.active
          join public.people person
            on person.id = claim.person_id and person.status = 'active'
          where link.activity_id = candidate.activity_id
            and link.relationship = 'actor'
        )
        and not exists (
          select 1
          from public.identities identity
          join public.person_identity_claims claim
            on claim.identity_id = identity.id and claim.active
          join public.people person
            on person.id = claim.person_id and person.status = 'active'
          where identity.workspace_key = candidate.workspace_key
            and (
              (identity.kind = 'email' and identity.normalized_value = private.fluid_normalize_email(candidate.contact_email))
              or (identity.kind = 'phone' and identity.normalized_value = private.fluid_normalize_phone(candidate.contact_phone))
            )
        )
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id,
        'activityId', item.activity_id,
        'personId', item.person_id,
        'name', item.contact_name,
        'email', item.contact_email,
        'phone', item.contact_phone,
        'channel', item.channel,
        'summary', item.summary,
        'reason', item.reason,
        'confidence', item.confidence,
        'disposition', item.disposition,
        'decidedBy', item.decided_by,
        'decidedAt', item.decided_at,
        'createdAt', item.created_at,
        'touches', private.lead_candidate_touches(item.workspace_key, item.id),
        'signal', jsonb_build_object(
          'subject', item.signal_subject,
          'preview', item.signal_preview,
          'occurredAt', item.signal_at,
          'direction', item.signal_direction,
          'source', item.signal_source,
          'eventType', item.signal_event_type,
          'actorName', item.signal_actor_name,
          'callStatus', item.signal_call_status,
          'durationSeconds', item.signal_duration_seconds,
          'callSummary', item.signal_call_summary,
          'transcriptStatus', item.signal_transcript_status
        )
      ) order by (item.disposition = 'undecided') desc,
        coalesce(item.decided_at, item.created_at) desc,
        item.id desc)
      from visible item
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.list_lead_candidates(text, integer)
from public, anon, authenticated;
grant execute on function public.list_lead_candidates(text, integer)
to service_role;
