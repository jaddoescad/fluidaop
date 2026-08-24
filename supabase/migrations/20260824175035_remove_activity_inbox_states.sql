drop view public.gmail_activity_threads;

update public.activities
set source_labels = array_remove(source_labels, 'UNREAD')
where source_labels @> array['UNREAD']::text[];

drop index if exists public.activities_needs_attention_idx;

alter table public.activities
  drop column if exists is_unread,
  drop column if exists needs_attention;

create view public.gmail_activity_threads
with (security_invoker = true)
as
select
  ranked.id as latest_message_id,
  ranked.source,
  ranked.account_email,
  ranked.thread_id,
  ranked.external_id as latest_external_id,
  ranked.direction as latest_direction,
  ranked.actor_name,
  ranked.actor_email,
  ranked.from_email,
  ranked.to_emails,
  ranked.cc_emails,
  ranked.subject,
  ranked.preview,
  ranked.occurred_at as latest_occurred_at,
  ranked.started_at,
  ranked.message_count,
  ranked.thread_has_attachments as has_attachments,
  ranked.thread_attachment_count as attachment_count,
  ranked.contact_id,
  ranked.source_labels
from (
  select
    activity.id,
    activity.source,
    activity.account_email,
    activity.external_id,
    activity.external_thread_id,
    activity.direction,
    activity.actor_name,
    activity.actor_email,
    activity.from_email,
    activity.to_emails,
    activity.cc_emails,
    activity.subject,
    activity.preview,
    activity.occurred_at,
    activity.has_attachments,
    activity.attachment_count,
    activity.contact_id,
    activity.source_labels,
    coalesce(activity.external_thread_id, activity.external_id) as thread_id,
    min(activity.occurred_at) over thread_window as started_at,
    count(*) over thread_window as message_count,
    bool_or(activity.has_attachments) over thread_window as thread_has_attachments,
    sum(activity.attachment_count) over thread_window as thread_attachment_count,
    row_number() over (
      partition by activity.account_email, coalesce(activity.external_thread_id, activity.external_id)
      order by activity.occurred_at desc, activity.id desc
    ) as position_in_thread
  from public.activities as activity
  where activity.source = 'gmail'
  window thread_window as (
    partition by activity.account_email, coalesce(activity.external_thread_id, activity.external_id)
  )
) as ranked
where ranked.position_in_thread = 1;

comment on view public.gmail_activity_threads is
  'One latest-message summary per Gmail conversation. Server-only; message chains remain in activities.';

revoke all on table public.gmail_activity_threads from public, anon, authenticated, service_role;
grant select on table public.gmail_activity_threads to service_role;
