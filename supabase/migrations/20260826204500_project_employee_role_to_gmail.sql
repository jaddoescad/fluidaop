-- Keep contact-role labels in the existing deterministic Gmail projection.
-- This is intentionally prospective: only newly triaged inbound messages are
-- claimed, so enabling it does not backfill historical mail.
create or replace function public.claim_gmail_label_sync_job(
  p_worker text,
  p_account_email text,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.gmail_label_sync_jobs%rowtype;
  v_activity public.activities%rowtype;
  v_label public.labels%rowtype;
  v_topics jsonb;
  v_mappings jsonb;
  v_role_labels jsonb;
  v_managed_role_labels jsonb;
  v_now timestamptz := now();
begin
  if p_worker is null or char_length(btrim(p_worker)) not between 1 and 100 then
    raise exception 'worker must be between 1 and 100 characters';
  end if;
  if p_account_email is null or p_account_email <> lower(p_account_email)
    or char_length(p_account_email) not between 3 and 320 then
    raise exception 'valid account email is required';
  end if;
  if p_lease_seconds not between 60 and 1800 then
    raise exception 'lease seconds must be between 60 and 1800';
  end if;

  update public.gmail_label_sync_jobs job
  set status = 'pending', available_at = v_now, claimed_at = null,
      lease_owner = null, lease_token = null, leased_until = null,
      updated_at = v_now
  from public.activities activity
  where job.activity_id = activity.id
    and activity.account_email = p_account_email
    and job.status = 'leased' and job.leased_until < v_now;

  select job.* into v_job
  from public.gmail_label_sync_jobs job
  join public.activities activity on activity.id = job.activity_id
  where activity.account_email = p_account_email
    and job.status = 'pending' and job.available_at <= v_now
  order by job.available_at, job.id
  for update of job skip locked
  limit 1;

  if not found then return jsonb_build_object('job', null); end if;

  update public.gmail_label_sync_jobs
  set status = 'leased', attempts = attempts + 1, claimed_at = v_now,
      lease_owner = btrim(p_worker), lease_token = gen_random_uuid(),
      leased_until = v_now + make_interval(secs => p_lease_seconds),
      last_error = null, updated_at = v_now
  where id = v_job.id
  returning * into v_job;

  select * into v_activity from public.activities where id = v_job.activity_id;
  select * into v_label from public.labels where id = v_job.desired_label_id;
  if not found or v_label.kind <> 'topic' then raise exception 'desired topic label is unavailable'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', label.id, 'key', label.key, 'name', label.name
    ) order by label.sort_order, label.id), '[]'::jsonb)
  into v_topics
  from public.labels label
  where label.workspace_key = v_job.workspace_key
    and label.kind = 'topic' and label.enabled;

  select coalesce(jsonb_agg(jsonb_build_object(
      'fluidLabelId', mapping.fluid_label_id,
      'gmailLabelId', mapping.gmail_label_id,
      'gmailLabelName', mapping.gmail_label_name
    ) order by mapping.id), '[]'::jsonb)
  into v_mappings
  from public.gmail_label_mappings mapping
  where mapping.workspace_key = v_job.workspace_key
    and mapping.account_email = v_activity.account_email;

  select coalesce(jsonb_agg(to_jsonb(role.name) order by role.sort_order, role.key), '[]'::jsonb)
  into v_managed_role_labels
  from public.contact_role_definitions role
  where role.workspace_key = v_job.workspace_key
    and role.key = 'employee'
    and role.enabled;

  select coalesce(jsonb_agg(to_jsonb(role.name) order by role.sort_order, role.key), '[]'::jsonb)
  into v_role_labels
  from public.contact_role_definitions role
  where role.workspace_key = v_job.workspace_key
    and role.key = 'employee'
    and role.enabled
    and exists (
      select 1
      from public.activity_people link
      join public.person_roles person_role
        on person_role.person_id = link.person_id
       and person_role.role_key = role.key
       and person_role.active
      where link.activity_id = v_activity.id
        and link.relationship = 'counterparty'
    );

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id, 'leaseToken', v_job.lease_token,
      'generation', v_job.generation, 'attempts', v_job.attempts,
      'claimedAt', v_job.claimed_at
    ),
    'message', jsonb_build_object(
      'activityId', v_activity.id, 'accountEmail', v_activity.account_email,
      'externalId', v_activity.external_id
    ),
    'desiredLabel', jsonb_build_object(
      'id', v_label.id, 'key', v_label.key, 'name', v_label.name
    ),
    'topicLabels', v_topics,
    'mappings', v_mappings,
    'roleLabels', v_role_labels,
    'managedRoleLabels', v_managed_role_labels
  );
end;
$$;

comment on function public.claim_gmail_label_sync_job(text, text, integer) is
  'Claims one prospective Gmail topic projection and includes additive Employee role labels.';
