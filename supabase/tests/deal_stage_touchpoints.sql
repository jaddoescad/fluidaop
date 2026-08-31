begin;

do $$
declare
  person_id constant uuid := 'ffffffff-ffff-4fff-8fff-fffffffffff1';
  deal_a constant text := 'f1111111111111111111111111111111';
  deal_b constant text := 'f2222222222222222222222222222222';
  document_id uuid := gen_random_uuid();
  cold_event_id bigint;
  warm_event_id bigint;
  call_id bigint;
  email_id bigint;
  early_id bigint;
  history jsonb;
begin
  insert into public.documents (
    id, kind, original_filename, captured_at, metadata
  ) values (
    document_id,
    'test-fixture',
    'deal-stage-touchpoints.json',
    '2026-01-01 00:00:00+00',
    jsonb_build_object('source', 'sql-contract-test')
  );

  insert into public.people (id, workspace_key, display_name)
  values (person_id, 'ottawa-painters', 'Touchpoint Test Contact');

  insert into public.dripjobs_sales_deals (
    deal_id,
    source_document_id,
    source_view,
    sales_status,
    customer_name,
    normalized_channel,
    deal_name,
    deal_stage,
    captured_at,
    source_sha256,
    combined_source_sha256,
    source_row_number,
    first_seen_at,
    last_seen_at,
    stage_entered_at,
    stage_observed_at,
    last_active_snapshot_at,
    estimated_created_at,
    created_at_method,
    created_at_confidence,
    person_id,
    person_match_method,
    person_linked_at
  ) values (
    deal_a,
    document_id,
    'active',
    'Open',
    'Touchpoint Test Contact',
    'unknown',
    'Touchpoint Test Deal A',
    'Warm Leads',
    '2026-01-05 00:00:00+00',
    repeat('a', 64),
    repeat('b', 64),
    999001,
    '2026-01-01 00:00:00+00',
    '2026-01-05 00:00:00+00',
    '2026-01-03 00:00:00+00',
    '2026-01-03 00:00:00+00',
    '2026-01-05 00:00:00+00',
    '2025-12-30 00:00:00+00',
    'sales_list_deal_age_d',
    0.650,
    person_id,
    'manual',
    now()
  );

  insert into public.dripjobs_pipeline_stage_events (
    workspace_key, deal_id, event_key, event_kind, from_stage, to_stage,
    effective_at, observed_at, source
  ) values (
    'ottawa-painters', deal_a, 'test-touchpoints-a-cold', 'stage_changed',
    'Unqualified', 'Cold Leads',
    '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', 'api'
  ) returning id into cold_event_id;

  insert into public.dripjobs_pipeline_stage_events (
    workspace_key, deal_id, event_key, event_kind, from_stage, to_stage,
    effective_at, observed_at, source
  ) values (
    'ottawa-painters', deal_a, 'test-touchpoints-a-warm', 'stage_changed', 'Cold Leads', 'Warm Leads',
    '2026-01-03 00:00:00+00', '2026-01-03 00:00:00+00', 'api'
  ) returning id into warm_event_id;

  insert into public.activities (
    workspace_key, source, account_phone, external_id, event_type, direction,
    subject, preview, occurred_at, call_status, duration_seconds
  ) values (
    'ottawa-painters', 'quo', '+16135550991', 'touchpoint-test-call', 'call.completed', 'outbound',
    'Outbound call', 'Reached the customer', '2026-01-02 12:00:00+00', 'completed', 120
  ) returning id into call_id;

  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    subject, preview, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'touchpoints@fluid.invalid', 'touchpoint-test-email', 'email.received', 'inbound',
    'Re: Estimate', 'Can we move ahead?', '2026-01-04 12:00:00+00'
  ) returning id into email_id;

  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    subject, preview, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'touchpoints@fluid.invalid', 'touchpoint-test-early', 'email.sent', 'outbound',
    'Introduction', 'Initial outreach', '2025-12-31 12:00:00+00'
  ) returning id into early_id;

  insert into public.activity_people (
    activity_id, person_id, relationship, matched_by, confidence
  ) values
    (call_id, person_id, 'counterparty', 'manual', 1),
    (email_id, person_id, 'counterparty', 'manual', 1),
    (early_id, person_id, 'counterparty', 'manual', 1);

  insert into public.activity_call_transcripts (
    activity_id, workspace_key, provider, provider_call_id, provider_transcript_id,
    status, dialogue, transcript_text, transcript_created_at, fetched_at
  ) values (
    call_id, 'ottawa-painters', 'quo', 'touchpoint-test-call', 'touchpoint-test-transcript',
    'available', '[{"identifier":"Customer","content":"Sounds good"}]'::jsonb,
    'Customer: Sounds good', '2026-01-02 12:03:00+00', now()
  );

  perform public.record_dripjobs_deal_milestone(
    'ottawa-painters',
    'touchpoint-test-proposal',
    deal_a,
    'proposal_sent',
    '2026-01-04 13:00:00+00',
    'api',
    'exact',
    '{"summary":"Proposal 1001"}'::jsonb
  );

  history := public.list_dripjobs_pipeline_history('ottawa-painters', deal_a, 100);

  if jsonb_array_length(history -> 'stages') <> 2 then
    raise exception 'Expected two stage windows: %', history;
  end if;

  if history #>> '{stages,0,stage}' <> 'Cold Leads'
     or history #>> '{stages,0,evidenceKind}' <> 'exact'
     or (history #>> '{stages,0,metrics,outboundCallAttempts}')::integer <> 1
     or (history #>> '{stages,0,metrics,connectedCalls}')::integer <> 1
     or history #>> '{stages,0,outcome,toStage}' <> 'Warm Leads' then
    raise exception 'Cold-stage call attribution or outcome is wrong: %', history -> 'stages' -> 0;
  end if;

  if history #>> '{stages,0,touchpoints,0,transcriptStatus}' <> 'available' then
    raise exception 'Available call transcript was not surfaced: %', history -> 'stages' -> 0;
  end if;

  if (history #>> '{stages,1,metrics,inboundEmails}')::integer <> 1
     or (history #>> '{stages,1,metrics,milestones}')::integer <> 1 then
    raise exception 'Warm-stage email or milestone count is wrong: %', history -> 'stages' -> 1;
  end if;

  if (history #>> '{unknownStage,metrics,total}')::integer <> 1
     or not exists (
       select 1
       from public.deal_activity_links link
       where link.workspace_key = 'ottawa-painters'
         and link.activity_id = early_id
         and link.deal_id = deal_a
         and link.stage_event_id is null
         and link.stage_evidence = 'unknown'
     ) then
    raise exception 'Pre-tracking activity was not preserved in the unknown-stage bucket: %', history -> 'unknownStage';
  end if;

  -- A concurrent deal makes person-only time attribution ambiguous. Fluid
  -- must remove the automatic link rather than count the call twice.
  insert into public.dripjobs_sales_deals (
    deal_id,
    source_document_id,
    source_view,
    sales_status,
    customer_name,
    normalized_channel,
    deal_name,
    deal_stage,
    captured_at,
    source_sha256,
    combined_source_sha256,
    source_row_number,
    first_seen_at,
    last_seen_at,
    stage_entered_at,
    stage_observed_at,
    last_active_snapshot_at,
    estimated_created_at,
    created_at_method,
    created_at_confidence,
    person_id,
    person_match_method,
    person_linked_at
  ) values (
    deal_b,
    document_id,
    'active',
    'Open',
    'Touchpoint Test Contact',
    'unknown',
    'Touchpoint Test Deal B',
    'Cold Leads',
    '2026-01-05 00:00:00+00',
    repeat('c', 64),
    repeat('d', 64),
    999002,
    '2026-01-01 00:00:00+00',
    '2026-01-05 00:00:00+00',
    '2026-01-01 00:00:00+00',
    '2026-01-01 00:00:00+00',
    '2026-01-05 00:00:00+00',
    '2025-12-30 00:00:00+00',
    'sales_list_deal_age_d',
    0.650,
    person_id,
    'manual',
    now()
  );

  insert into public.dripjobs_pipeline_stage_events (
    workspace_key, deal_id, event_key, event_kind, from_stage, to_stage,
    effective_at, observed_at, source
  ) values (
    'ottawa-painters', deal_b, 'test-touchpoints-b-cold', 'stage_changed',
    'Unqualified', 'Cold Leads',
    '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', 'api'
  );

  if exists (
    select 1
    from public.deal_activity_links link
    where link.workspace_key = 'ottawa-painters'
      and link.activity_id = call_id
  ) then
    raise exception 'Ambiguous concurrent-deal call was assigned automatically';
  end if;

  -- Explicit provider evidence wins even while the deal windows overlap.
  update public.activities
  set source_metadata = jsonb_build_object('dripjobsDealId', deal_a)
  where id = call_id;

  if not exists (
    select 1
    from public.deal_activity_links link
    where link.workspace_key = 'ottawa-painters'
      and link.activity_id = call_id
      and link.deal_id = deal_a
      and link.stage_event_id = cold_event_id
      and link.attribution_method = 'provider_deal_id'
      and link.stage_evidence = 'exact'
  ) then
    raise exception 'Explicit provider deal evidence did not resolve the ambiguous call';
  end if;
end;
$$;

rollback;
