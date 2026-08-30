-- Remove the three action definitions that were never enabled and have no
-- instances or recommendations referencing them. draft-email-to-customer is
-- deliberately left in place: it is enabled and still referenced by live rows.
delete from public.action_definitions
where workspace_key = 'ottawa-painters'
  and key in ('draft-sms-reply', 'create-follow-up-reminder', 'create-internal-task');
