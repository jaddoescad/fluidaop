create index action_instances_source_activity_fk_idx
  on public.action_instances (source_activity_id);

create index action_instances_person_fk_idx
  on public.action_instances (person_id)
  where person_id is not null;
