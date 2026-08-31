begin;

do $$
declare
  deal_a constant text := 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  deal_b constant text := 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  deal_c constant text := 'cccccccccccccccccccccccccccccccc';
  active_a jsonb;
  active_b jsonb;
  result jsonb;
begin
  active_a := jsonb_build_object(
    'dealId', deal_a,
    'salesStatus', 'Open',
    'customerName', 'Pipeline Test A',
    'dealName', 'Test Deal A',
    'dealStage', 'Cold Leads',
    'dealAmountCents', 10000
  );
  active_b := jsonb_build_object(
    'dealId', deal_b,
    'salesStatus', 'Open',
    'customerName', 'Pipeline Test B',
    'dealName', 'Test Deal B',
    'dealStage', 'Warm Leads',
    'dealAmountCents', 20000
  );

  result := public.record_dripjobs_pipeline_stage_event(
    'ottawa-painters', 'test:event-before-snapshot', deal_c, 'Estimate Scheduled',
    '2025-12-31T15:00:00Z', '2025-12-31T15:00:02Z', 'Cold Leads', '{}'::jsonb
  );
  if result->>'status' <> 'retained_pending_snapshot' then
    raise exception 'event-before-snapshot was not retained: %', result;
  end if;
  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(jsonb_build_object(
      'dealId', deal_c,
      'salesStatus', 'Open',
      'customerName', 'Pipeline Test C',
      'dealName', 'Test Deal C',
      'dealStage', 'Estimate Scheduled',
      'dealAmountCents', 30000
    )),
    '[]'::jsonb,
    '2026-01-01T09:00:00Z',
    'test:event-before-snapshot',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded'
     or (select stage_entered_at from public.dripjobs_sales_deals where deal_id = deal_c)
        <> '2025-12-31T15:00:00Z'::timestamptz
     or (select count(*) from public.dripjobs_pipeline_stage_events where deal_id = deal_c) <> 1 then
    raise exception 'snapshot did not apply retained event timing without a duplicate baseline: %', result;
  end if;

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(active_a, active_b),
    '[]'::jsonb,
    '2026-01-01T10:05:00Z',
    'test:baseline',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded' then
    raise exception 'baseline reconciliation failed: %', result;
  end if;
  if (select count(*) from public.dripjobs_pipeline_stage_events
      where deal_id in (deal_a, deal_b)) <> 0
     or exists (
       select 1
       from public.dripjobs_sales_deals
       where deal_id in (deal_a, deal_b)
         and (stage_entered_at is not null or stage_observed_at is not null)
     ) then
    raise exception 'first snapshot invented stage history for a new deal';
  end if;

  result := public.record_dripjobs_pipeline_stage_event(
    'ottawa-painters', 'test:event:1', deal_a, 'Estimate Scheduled',
    '2026-01-02T12:00:00Z', '2026-01-02T12:00:05Z', 'Cold Leads', '{}'::jsonb
  );
  if result->>'status' <> 'applied' then
    raise exception 'forward stage event was not applied: %', result;
  end if;

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(active_a || jsonb_build_object('dealStage', 'Estimate Scheduled'), active_b),
    '[]'::jsonb,
    '2026-01-02T13:00:00Z',
    'test:audit-after-zapier',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded' or (result->>'changedStages')::integer <> 0
     or (select count(*) from public.dripjobs_pipeline_stage_events
         where deal_id = deal_a and to_stage = 'Estimate Scheduled') <> 1 then
    raise exception 'daily audit duplicated an already-applied Zapier transition: %', result;
  end if;

  result := public.record_dripjobs_pipeline_stage_event(
    'ottawa-painters', 'test:event:1', deal_a, 'Estimate Scheduled',
    '2026-01-02T12:00:00Z', '2026-01-02T12:00:06Z', 'Cold Leads', '{}'::jsonb
  );
  if result->>'status' <> 'duplicate' then
    raise exception 'duplicate event was not idempotent: %', result;
  end if;

  result := public.record_dripjobs_pipeline_stage_event(
    'ottawa-painters', 'test:event:2', deal_a, 'Cold Leads',
    '2026-01-03T12:00:00Z', '2026-01-03T12:00:02Z', 'Estimate Scheduled', '{}'::jsonb
  );
  if result->>'status' <> 'applied' then
    raise exception 'backward/repeated stage visit was not applied: %', result;
  end if;
  if (select count(*) from public.dripjobs_pipeline_stage_events
      where deal_id = deal_a and to_stage = 'Cold Leads') <> 1
     or not exists (
       select 1
       from public.dripjobs_pipeline_stage_events event
       where event.deal_id = deal_a
         and event.event_kind = 'stage_changed'
         and event.from_stage = 'Cold Leads'
         and event.to_stage = 'Estimate Scheduled'
     )
     or not exists (
       select 1
       from public.dripjobs_pipeline_stage_events event
       where event.deal_id = deal_a
         and event.event_kind = 'stage_changed'
         and event.from_stage = 'Estimate Scheduled'
         and event.to_stage = 'Cold Leads'
     ) then
    raise exception 'real Cold-to-Estimate-to-Cold round trip was not retained';
  end if;

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(active_a || jsonb_build_object('dealStage', 'Proposal(s) Sent'), active_b),
    '[]'::jsonb,
    '2026-01-04T10:05:00Z',
    'test:repair',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded' or (result->>'changedStages')::integer <> 1 then
    raise exception 'daily missed-event repair failed: %', result;
  end if;

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(active_b),
    jsonb_build_array(active_a || jsonb_build_object('dealStage', 'Proposal(s) Sent')),
    '2026-01-05T10:05:00Z',
    'test:archive',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded' or (result->>'archivedDeals')::integer <> 1 then
    raise exception 'explicit archive failed: %', result;
  end if;

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(active_a || jsonb_build_object('dealStage', 'Proposal(s) Sent'), active_b),
    '[]'::jsonb,
    '2026-01-06T10:05:00Z',
    'test:reactivate',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded' or (result->>'reactivatedDeals')::integer <> 1 then
    raise exception 'reactivation failed: %', result;
  end if;
  if (select stage_entered_at from public.dripjobs_sales_deals where deal_id = deal_a)
      <> '2026-01-06T10:05:00Z'::timestamptz then
    raise exception 'reactivation did not begin a new current-stage visit';
  end if;

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(active_a || jsonb_build_object('dealStage', 'Custom DripJobs Stage')),
    '[]'::jsonb,
    '2026-01-07T10:05:00Z',
    'test:unmapped-and-absence',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded' then
    raise exception 'unmapped-stage reconciliation failed: %', result;
  end if;
  if (select deal_stage from public.dripjobs_sales_deals where deal_id = deal_a)
      <> 'Custom DripJobs Stage' then
    raise exception 'unknown DripJobs stage was dropped';
  end if;
  if (select archived_at from public.dripjobs_sales_deals where deal_id = deal_b) is not null then
    raise exception 'simple absence was incorrectly treated as archival';
  end if;

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(active_a || jsonb_build_object('dealAmountCents', 1e100::numeric)),
    '[]'::jsonb,
    '2026-01-08T10:05:00Z',
    'test:retry',
    'ottawa-painters'
  );
  if result->>'status' <> 'failed' then
    raise exception 'expected the bounded ledger to retain a failed attempt: %', result;
  end if;
  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(active_a),
    '[]'::jsonb,
    '2026-01-08T10:05:00Z',
    'test:retry',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded' then
    raise exception 'failed run could not be safely retried: %', result;
  end if;
  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(active_a),
    '[]'::jsonb,
    '2026-01-08T10:05:00Z',
    'test:retry',
    'ottawa-painters'
  );
  if result->>'status' <> 'duplicate' then
    raise exception 'successful run key was not idempotent: %', result;
  end if;
end;
$$;

do $$
declare
  deal_id constant text := 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  full_match_id uuid := gen_random_uuid();
  email_only_id uuid := gen_random_uuid();
  phone_only_id uuid := gen_random_uuid();
  duplicate_full_match_id uuid := gen_random_uuid();
  shared_household_id uuid := gen_random_uuid();
  result jsonb;
  deal_item jsonb;
begin
  insert into public.people (
    id, workspace_key, display_name, primary_email, primary_phone, created_at
  ) values
    (
      full_match_id,
      'ottawa-painters',
      'Pipeline Full Match',
      'pipeline.match@example.invalid',
      '+1 (613) 555-0199',
      '2026-01-01T00:00:00Z'
    ),
    (
      email_only_id,
      'ottawa-painters',
      'Pipeline Email-Only Match',
      'pipeline.match@example.invalid',
      '+1 (613) 555-0101',
      '2026-01-02T00:00:00Z'
    ),
    (
      phone_only_id,
      'ottawa-painters',
      'Pipeline Phone-Only Match',
      'different@example.invalid',
      '+1 (613) 555-0199',
      '2026-01-03T00:00:00Z'
    );

  insert into public.activities (
    source, account_email, external_id, event_type, direction,
    actor_name, actor_email, subject, occurred_at
  ) values (
    'gmail',
    'info@paintersottawa.com',
    'pipeline-strong-contact-match-signal',
    'email.received',
    'inbound',
    'Pipeline Full Match',
    'pipeline.match@example.invalid',
    'Pipeline match regression signal',
    '2026-01-09T09:00:00Z'
  );

  insert into public.person_identifiers (
    person_id, kind, value, normalized_value,
    source_system, source_record_type, source_record_id,
    is_primary, active
  ) values
    (
      full_match_id, 'email', 'pipeline.match@example.invalid', 'pipeline.match@example.invalid',
      'pipeline-test', 'contact', 'full-email', true, true
    ),
    (
      full_match_id, 'phone', '+1 (613) 555-0199', '6135550199',
      'pipeline-test', 'contact', 'full-phone', true, true
    ),
    (
      email_only_id, 'email', 'pipeline.match@example.invalid', 'pipeline.match@example.invalid',
      'pipeline-test', 'contact', 'email-only', true, true
    ),
    (
      phone_only_id, 'phone', '+1 (613) 555-0199', '6135550199',
      'pipeline-test', 'contact', 'phone-only', true, true
    );

  perform private.ensure_person_identifier_identities('ottawa-painters');
  perform private.reconcile_lead_identity_graph();

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(jsonb_build_object(
      'dealId', deal_id,
      'salesStatus', 'Open',
      'customerName', 'Pipeline Full Match',
      'email', 'pipeline.match@example.invalid',
      'phone', '613-555-0199',
      'dealName', 'Strong Contact Match Test',
      'dealStage', 'Warm Leads',
      'dealAmountCents', 40000
    )),
    '[]'::jsonb,
    '2026-01-09T10:05:00Z',
    'test:strong-contact-match',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded' then
    raise exception 'strong contact match reconciliation failed: %', result;
  end if;

  result := public.list_current_dripjobs_pipeline('ottawa-painters');
  select item into deal_item
  from jsonb_array_elements(result->'items') item
  where item->>'id' = deal_id;

  if deal_item->>'personId' <> full_match_id::text
     or (deal_item->>'personMatchCount')::integer <> 1 then
    raise exception 'unique email-and-phone match did not outrank partial matches: %', deal_item;
  end if;
  if deal_item->>'latestSignalAt' is not null then
    raise exception 'ambiguous raw identifier leaked into canonical deal activity: %', deal_item;
  end if;

  insert into public.people (
    id, workspace_key, display_name, primary_email, primary_phone, created_at
  ) values (
    duplicate_full_match_id,
    'ottawa-painters',
    'Pipeline Full Match...',
    'pipeline.match@example.invalid',
    '+1 (613) 555-0199',
    '2026-01-04T00:00:00Z'
  );

  insert into public.person_identifiers (
    person_id, kind, value, normalized_value,
    source_system, source_record_type, source_record_id,
    is_primary, active
  ) values
    (
      duplicate_full_match_id, 'email', 'pipeline.match@example.invalid', 'pipeline.match@example.invalid',
      'pipeline-test', 'contact', 'duplicate-email', true, true
    ),
    (
      duplicate_full_match_id, 'phone', '+1 (613) 555-0199', '6135550199',
      'pipeline-test', 'contact', 'duplicate-phone', true, true
    );

  perform private.ensure_person_identifier_identities('ottawa-painters');
  perform private.reconcile_lead_identity_graph();

  result := public.list_current_dripjobs_pipeline('ottawa-painters');
  select item into deal_item
  from jsonb_array_elements(result->'items') item
  where item->>'id' = deal_id;

  if deal_item->>'personId' <> full_match_id::text
     or (deal_item->>'personMatchCount')::integer <> 1 then
    raise exception 'truncated-name duplicate contacts were not collapsed deterministically: %', deal_item;
  end if;

  insert into public.people (
    id, workspace_key, display_name, primary_email, primary_phone, created_at
  ) values (
    shared_household_id,
    'ottawa-painters',
    'Pipeline Shared Household',
    'pipeline.match@example.invalid',
    '+1 (613) 555-0199',
    '2026-01-05T00:00:00Z'
  );

  insert into public.person_identifiers (
    person_id, kind, value, normalized_value,
    source_system, source_record_type, source_record_id,
    is_primary, active
  ) values
    (
      shared_household_id, 'email', 'pipeline.match@example.invalid', 'pipeline.match@example.invalid',
      'pipeline-test', 'contact', 'shared-email', true, true
    ),
    (
      shared_household_id, 'phone', '+1 (613) 555-0199', '6135550199',
      'pipeline-test', 'contact', 'shared-phone', true, true
    );

  perform private.ensure_person_identifier_identities('ottawa-painters');
  perform private.reconcile_lead_identity_graph();

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(jsonb_build_object(
      'dealId', deal_id,
      'salesStatus', 'Open',
      'customerName', 'Pipeline Neutral Lead',
      'email', 'pipeline.match@example.invalid',
      'phone', '613-555-0199',
      'dealName', 'Strong Contact Match Test',
      'dealStage', 'Warm Leads',
      'dealAmountCents', 40000
    )),
    '[]'::jsonb,
    '2026-01-10T10:05:00Z',
    'test:genuine-contact-conflict',
    'ottawa-painters'
  );
  if result->>'status' <> 'succeeded' then
    raise exception 'genuine contact conflict reconciliation failed: %', result;
  end if;

  result := public.list_current_dripjobs_pipeline('ottawa-painters');
  select item into deal_item
  from jsonb_array_elements(result->'items') item
  where item->>'id' = deal_id;

  if deal_item->>'personId' <> full_match_id::text
     or (deal_item->>'personMatchCount')::integer <> 1 then
    raise exception 'persisted deal Contact changed after later identity ambiguity: %', deal_item;
  end if;

  if exists (
    select 1 from public.dripjobs_sales_deals deal
    where deal.deal_id = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      and (deal.person_id is null or deal.person_match_method is null)
  ) then
    raise exception 'deal lost its required canonical Contact relationship';
  end if;
end;
$$;

rollback;
