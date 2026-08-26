create index gmail_label_mappings_fluid_label_fk_idx
  on public.gmail_label_mappings (fluid_label_id);

create index gmail_label_sync_jobs_desired_label_fk_idx
  on public.gmail_label_sync_jobs (desired_label_id);
