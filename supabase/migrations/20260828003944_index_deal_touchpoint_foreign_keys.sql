create index deal_activity_links_activity_fk_idx
  on public.deal_activity_links (activity_id);

create index deal_activity_links_deal_fk_idx
  on public.deal_activity_links (deal_id);

create index deal_milestone_events_deal_fk_idx
  on public.deal_milestone_events (deal_id);
