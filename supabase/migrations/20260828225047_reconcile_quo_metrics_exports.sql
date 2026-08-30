-- Preserve Quo Analytics/Metric exports as first-class evidence and reconcile
-- them one-to-one with the canonical activity stream. These exports contain
-- fields (missed/answered, voicemail, ownership and delivery status) that the
-- older calls/messages exports did not retain.

alter table public.quo_import_runs
  drop constraint quo_import_runs_kind_check;

alter table public.quo_import_runs
  add constraint quo_import_runs_kind_check
  check (import_kind in ('contacts', 'messages', 'calls', 'metrics'));

create table public.quo_metric_activity_evidence (
  workspace_key text not null,
  event_key text not null,
  row_fingerprint text not null,
  source_file text not null,
  source_file_sha256 text not null,
  source_row_number integer not null,
  activity_id bigint references public.activities(id) on delete set null,
  occurred_at timestamptz not null,
  updated_at timestamptz,
  answered_at timestamptz,
  deleted_at timestamptz,
  quo_type text not null,
  direction text not null,
  status text not null,
  status_details text,
  duration_seconds integer,
  account_phone text not null,
  actor_phone text not null,
  from_phone text not null,
  to_phones text[] not null,
  phone_number_label text,
  belongs_to text,
  created_by text,
  answered_by text,
  user_id text,
  imported_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (workspace_key, event_key),
  constraint quo_metric_activity_evidence_workspace_check
    check (workspace_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint quo_metric_activity_evidence_event_key_check
    check (event_key ~ '^[a-f0-9]{64}$'),
  constraint quo_metric_activity_evidence_row_fingerprint_check
    check (row_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint quo_metric_activity_evidence_file_sha_check
    check (source_file_sha256 ~ '^[a-f0-9]{64}$'),
  constraint quo_metric_activity_evidence_source_row_check
    check (source_row_number > 1),
  constraint quo_metric_activity_evidence_type_check
    check (quo_type in ('message', 'call', 'voicemail')),
  constraint quo_metric_activity_evidence_direction_check
    check (direction in ('inbound', 'outbound')),
  constraint quo_metric_activity_evidence_duration_check
    check (duration_seconds is null or duration_seconds >= 0),
  constraint quo_metric_activity_evidence_from_phone_check
    check (from_phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint quo_metric_activity_evidence_account_phone_check
    check (account_phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint quo_metric_activity_evidence_actor_phone_check
    check (actor_phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint quo_metric_activity_evidence_to_phones_check
    check (cardinality(to_phones) > 0)
);

comment on table public.quo_metric_activity_evidence is
  'Server-only normalized Quo Metrics export rows linked one-to-one to canonical activities.';
comment on column public.quo_metric_activity_evidence.event_key is
  'File-independent identity composed from type, direction, second, participants, and duplicate occurrence.';
comment on column public.quo_metric_activity_evidence.row_fingerprint is
  'Hash of the complete source row, retained to detect provider-side changes.';

create index quo_metric_activity_evidence_activity_idx
  on public.quo_metric_activity_evidence (activity_id)
  where activity_id is not null;

create index quo_metric_activity_evidence_occurred_idx
  on public.quo_metric_activity_evidence (workspace_key, occurred_at desc, event_key);

create index quo_metric_activity_evidence_status_idx
  on public.quo_metric_activity_evidence (workspace_key, quo_type, direction, status, occurred_at desc);

alter table public.quo_metric_activity_evidence enable row level security;
revoke all on table public.quo_metric_activity_evidence from public, anon, authenticated;
grant select, insert, update, delete on table public.quo_metric_activity_evidence to service_role;

create or replace function public.ingest_quo_metric_activity_rows(
  p_workspace_key text,
  p_source_file text,
  p_source_file_sha256 text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row jsonb;
  v_event_key text;
  v_row_fingerprint text;
  v_source_row integer;
  v_type text;
  v_direction text;
  v_status text;
  v_status_details text;
  v_occurred_at timestamptz;
  v_updated_at timestamptz;
  v_answered_at timestamptz;
  v_deleted_at timestamptz;
  v_duration integer;
  v_from_phone text;
  v_to_phones text[];
  v_account_phone text;
  v_actor_phone text;
  v_event_type text;
  v_call_status text;
  v_activity_id bigint;
  v_metric_metadata jsonb;
  v_processed integer := 0;
  v_matched integer := 0;
  v_inserted integer := 0;
begin
  if p_workspace_key is null or p_workspace_key !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'invalid workspace key';
  end if;
  if p_source_file is null or btrim(p_source_file) = '' or char_length(p_source_file) > 240 then
    raise exception 'invalid source file';
  end if;
  if p_source_file_sha256 is null or p_source_file_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid source file hash';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 200 then
    raise exception 'metrics batch must contain between 1 and 200 rows';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_event_key := lower(coalesce(v_row ->> 'eventKey', ''));
    v_row_fingerprint := lower(coalesce(v_row ->> 'rowFingerprint', ''));
    v_source_row := nullif(v_row ->> 'sourceRowNumber', '')::integer;
    v_type := lower(coalesce(v_row ->> 'type', ''));
    v_direction := lower(coalesce(v_row ->> 'direction', ''));
    v_status := lower(coalesce(v_row ->> 'status', ''));
    v_status_details := nullif(btrim(v_row ->> 'statusDetails'), '');
    v_occurred_at := nullif(v_row ->> 'occurredAt', '')::timestamptz;
    v_updated_at := nullif(v_row ->> 'updatedAt', '')::timestamptz;
    v_answered_at := nullif(v_row ->> 'answeredAt', '')::timestamptz;
    v_deleted_at := nullif(v_row ->> 'deletedAt', '')::timestamptz;
    v_duration := nullif(v_row ->> 'durationSeconds', '')::integer;
    v_from_phone := nullif(v_row ->> 'fromPhone', '');
    select coalesce(array_agg(value), '{}'::text[]) into v_to_phones
    from jsonb_array_elements_text(coalesce(v_row -> 'toPhones', '[]'::jsonb)) as value;
    v_account_phone := nullif(v_row ->> 'accountPhone', '');
    v_actor_phone := nullif(v_row ->> 'actorPhone', '');

    if v_event_key !~ '^[a-f0-9]{64}$'
       or v_row_fingerprint !~ '^[a-f0-9]{64}$'
       or v_source_row is null or v_source_row <= 1
       or v_type not in ('message', 'call', 'voicemail')
       or v_direction not in ('inbound', 'outbound')
       or v_status = '' or char_length(v_status) > 100
       or v_occurred_at is null
       or v_from_phone is null or v_from_phone !~ '^\+[1-9][0-9]{6,14}$'
       or v_account_phone is null or v_account_phone !~ '^\+[1-9][0-9]{6,14}$'
       or v_actor_phone is null or v_actor_phone !~ '^\+[1-9][0-9]{6,14}$'
       or cardinality(v_to_phones) < 1
       or exists (
         select 1 from unnest(v_to_phones) phone
         where phone !~ '^\+[1-9][0-9]{6,14}$'
       )
       or v_duration is not null and v_duration < 0 then
      raise exception 'invalid Quo metric row %', coalesce(v_source_row::text, '?');
    end if;

    v_event_type := case
      when v_type = 'message' and v_direction = 'inbound' then 'message.received'
      when v_type = 'message' then 'message.sent'
      else 'call.completed'
    end;
    v_call_status := case
      when v_type = 'voicemail' then 'voicemail'
      when v_type <> 'call' then null
      when v_status in ('no-answer', 'no_answer', 'unanswered', 'missed') then 'missed'
      when v_status in ('cancelled', 'canceled', 'failed', 'busy', 'declined') then 'failed'
      when v_status = 'answered' then 'answered'
      when v_status = 'ringing' then 'ringing'
      else v_status
    end;

    if not exists (
      select 1
      from public.quo_phone_scopes scope
      where scope.active and scope.phone_number_e164 = v_account_phone
    ) then
      raise exception 'metric row % is outside the selected Quo phone scope', v_source_row;
    end if;

    v_metric_metadata := jsonb_strip_nulls(jsonb_build_object(
      'eventKey', v_event_key,
      'rowFingerprint', v_row_fingerprint,
      'sourceFile', left(p_source_file, 240),
      'sourceFileSha256', p_source_file_sha256,
      'sourceRowNumber', v_source_row,
      'type', v_type,
      'status', v_status,
      'statusDetails', v_status_details,
      'durationSeconds', v_duration,
      'answeredAt', v_answered_at,
      'updatedAt', v_updated_at,
      'deletedAt', v_deleted_at,
      'phoneNumberLabel', nullif(btrim(v_row ->> 'phoneNumberLabel'), ''),
      'belongsTo', nullif(btrim(v_row ->> 'belongsTo'), ''),
      'createdBy', nullif(btrim(v_row ->> 'createdBy'), ''),
      'answeredBy', nullif(btrim(v_row ->> 'answeredBy'), ''),
      'userId', nullif(btrim(v_row ->> 'userId'), '')
    ));

    insert into public.quo_metric_activity_evidence (
      workspace_key, event_key, row_fingerprint, source_file,
      source_file_sha256, source_row_number, occurred_at, updated_at,
      answered_at, deleted_at, quo_type, direction, status, status_details,
      duration_seconds, account_phone, actor_phone, from_phone, to_phones,
      phone_number_label, belongs_to,
      created_by, answered_by, user_id, metadata
    ) values (
      p_workspace_key, v_event_key, v_row_fingerprint, left(p_source_file, 240),
      p_source_file_sha256, v_source_row, v_occurred_at, v_updated_at,
      v_answered_at, v_deleted_at, v_type, v_direction, v_status, v_status_details,
      v_duration, v_account_phone, v_actor_phone, v_from_phone, v_to_phones,
      nullif(btrim(v_row ->> 'phoneNumberLabel'), ''),
      nullif(btrim(v_row ->> 'belongsTo'), ''),
      nullif(btrim(v_row ->> 'createdBy'), ''),
      nullif(btrim(v_row ->> 'answeredBy'), ''),
      nullif(btrim(v_row ->> 'userId'), ''), v_metric_metadata
    )
    on conflict (workspace_key, event_key) do update set
      row_fingerprint = excluded.row_fingerprint,
      source_file = excluded.source_file,
      source_file_sha256 = excluded.source_file_sha256,
      source_row_number = excluded.source_row_number,
      occurred_at = excluded.occurred_at,
      updated_at = excluded.updated_at,
      answered_at = excluded.answered_at,
      deleted_at = excluded.deleted_at,
      quo_type = excluded.quo_type,
      direction = excluded.direction,
      status = excluded.status,
      status_details = excluded.status_details,
      duration_seconds = excluded.duration_seconds,
      account_phone = excluded.account_phone,
      actor_phone = excluded.actor_phone,
      from_phone = excluded.from_phone,
      to_phones = excluded.to_phones,
      phone_number_label = excluded.phone_number_label,
      belongs_to = excluded.belongs_to,
      created_by = excluded.created_by,
      answered_by = excluded.answered_by,
      user_id = excluded.user_id,
      imported_at = now(),
      metadata = excluded.metadata;

    select evidence.activity_id into v_activity_id
    from public.quo_metric_activity_evidence evidence
    where evidence.workspace_key = p_workspace_key
      and evidence.event_key = v_event_key;

    if v_activity_id is null then
      select activity.id into v_activity_id
      from public.activities activity
      where activity.workspace_key = p_workspace_key
        and activity.source = 'quo'
        and activity.account_phone = v_account_phone
        and activity.event_type = v_event_type
        and activity.direction = v_direction
        and date_trunc('second', activity.occurred_at) = date_trunc('second', v_occurred_at)
        and (
          activity.actor_phone = v_actor_phone
          or (
            activity.from_phone = v_from_phone
            and activity.to_phones @> v_to_phones
            and v_to_phones @> activity.to_phones
          )
        )
        and not exists (
          select 1
          from public.quo_metric_activity_evidence claimed
          where claimed.workspace_key = p_workspace_key
            and claimed.activity_id = activity.id
            and claimed.event_key <> v_event_key
        )
      order by
        (activity.external_id = 'quo-metrics:' || v_event_key) desc,
        abs(extract(epoch from activity.occurred_at - v_occurred_at)),
        activity.id
      limit 1;
    end if;

    if v_activity_id is null then
      insert into public.activities (
        workspace_key, source, account_email, account_phone, external_id,
        external_thread_id, event_type, direction, actor_name, actor_email,
        actor_phone, from_email, from_phone, to_emails, to_phones, cc_emails,
        subject, preview, body_text, occurred_at, has_attachments,
        attachment_count, call_status, duration_seconds, source_labels,
        source_metadata, updated_at
      ) values (
        p_workspace_key, 'quo', null, v_account_phone,
        'quo-metrics:' || v_event_key,
        'quo:' || v_account_phone || ':' || regexp_replace(v_actor_phone, '[^0-9]', '', 'g'),
        v_event_type, v_direction, null, null, v_actor_phone, null,
        v_from_phone, '{}'::text[], v_to_phones, '{}'::text[],
        case
          when v_type = 'message' then 'Text message'
          when v_type = 'voicemail' then 'Voicemail received'
          when v_direction = 'inbound' then 'Incoming call'
          else 'Outgoing call'
        end,
        case
          when v_type = 'message' then 'Message content unavailable from Quo Metrics export'
          when v_type = 'voicemail' then 'Voicemail received'
          else replace(v_call_status, '_', ' ')
        end,
        null, v_occurred_at, false, 0, v_call_status,
        case when v_type = 'voicemail' then null else v_duration end,
        array['quo-metrics'],
        jsonb_build_object('quoMetrics', v_metric_metadata)
          || case when v_type = 'message'
            then jsonb_build_object('deliveryStatus', v_status)
            else jsonb_build_object('quoType', v_type, 'rawCallStatus', v_status)
          end,
        coalesce(v_updated_at, now())
      )
      returning id into v_activity_id;
      v_inserted := v_inserted + 1;
    else
      update public.activities activity set
        call_status = case when v_type = 'message' then activity.call_status else v_call_status end,
        duration_seconds = case
          when v_type = 'message' then activity.duration_seconds
          when v_type = 'voicemail' then null
          else coalesce(v_duration, activity.duration_seconds)
        end,
        source_labels = array(
          select distinct label
          from unnest(activity.source_labels || array['quo-metrics']) as label
          order by label
        ),
        source_metadata = activity.source_metadata
          || jsonb_build_object('quoMetrics', v_metric_metadata)
          || case when v_type = 'message'
            then jsonb_build_object('deliveryStatus', v_status)
            else jsonb_build_object('quoType', v_type, 'rawCallStatus', v_status)
          end,
        updated_at = greatest(activity.updated_at, coalesce(v_updated_at, activity.updated_at))
      where activity.id = v_activity_id;
      v_matched := v_matched + 1;
    end if;

    update public.quo_metric_activity_evidence evidence
    set activity_id = v_activity_id, imported_at = now()
    where evidence.workspace_key = p_workspace_key
      and evidence.event_key = v_event_key;

    v_processed := v_processed + 1;
  end loop;

  return jsonb_build_object(
    'processed', v_processed,
    'matched', v_matched,
    'inserted', v_inserted
  );
end;
$$;

revoke all on function public.ingest_quo_metric_activity_rows(text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_quo_metric_activity_rows(text, text, text, jsonb)
  to service_role;

create or replace function public.summarize_quo_metric_activity_evidence(
  p_workspace_key text,
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'total', count(*),
    'messages', count(*) filter (where evidence.quo_type = 'message'),
    'inboundMessages', count(*) filter (
      where evidence.quo_type = 'message' and evidence.direction = 'inbound'
    ),
    'outboundMessages', count(*) filter (
      where evidence.quo_type = 'message' and evidence.direction = 'outbound'
    ),
    'calls', count(*) filter (where evidence.quo_type = 'call'),
    'inboundCalls', count(*) filter (
      where evidence.quo_type = 'call' and evidence.direction = 'inbound'
    ),
    'outboundCalls', count(*) filter (
      where evidence.quo_type = 'call' and evidence.direction = 'outbound'
    ),
    'answeredCalls', count(*) filter (
      where evidence.quo_type = 'call' and evidence.status = 'answered'
    ),
    'missedCalls', count(*) filter (
      where evidence.quo_type = 'call' and evidence.status in ('missed', 'unanswered', 'no-answer', 'no_answer')
    ),
    'ringingCalls', count(*) filter (
      where evidence.quo_type = 'call' and evidence.status = 'ringing'
    ),
    'voicemails', count(*) filter (where evidence.quo_type = 'voicemail'),
    'durationSeconds', coalesce(sum(evidence.duration_seconds), 0),
    'matchedActivities', count(*) filter (where evidence.activity_id is not null),
    'unmatchedActivities', count(*) filter (where evidence.activity_id is null)
  )
  from public.quo_metric_activity_evidence evidence
  where evidence.workspace_key = p_workspace_key
    and evidence.occurred_at >= p_start
    and evidence.occurred_at < p_end;
$$;

revoke all on function public.summarize_quo_metric_activity_evidence(text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.summarize_quo_metric_activity_evidence(text, timestamptz, timestamptz)
  to service_role;
