create index case_evidence_activity_fk_idx
  on public.case_evidence (activity_id)
  where activity_id is not null;

create index case_evidence_slack_message_fk_idx
  on public.case_evidence (slack_message_id)
  where slack_message_id is not null;

create index external_references_contact_fk_idx
  on public.external_references (contact_id)
  where contact_id is not null;

create index external_references_job_fk_idx
  on public.external_references (job_id)
  where job_id is not null;

create index external_references_lead_fk_idx
  on public.external_references (lead_id)
  where lead_id is not null;

create index operational_cases_contact_fk_idx
  on public.operational_cases (contact_id)
  where contact_id is not null;

create index operational_cases_job_fk_idx
  on public.operational_cases (job_id);

create index operational_cases_person_fk_idx
  on public.operational_cases (person_id)
  where person_id is not null;

create index slack_channels_job_fk_idx
  on public.slack_channels (job_id)
  where job_id is not null;

create index slack_events_workspace_team_fk_idx
  on public.slack_events (workspace_key, team_id);

create index slack_sync_state_workspace_team_fk_idx
  on public.slack_sync_state (workspace_key, team_id);
