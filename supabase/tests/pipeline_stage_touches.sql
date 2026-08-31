-- A pipeline card counts only the outreach made inside the stage the deal is
-- sitting in now. Work done while the deal was a cold lead must not follow it
-- into Proposal(s) Sent, and automated sends must not pass for human touches.

begin;

do $$
declare
  person_id constant uuid := 'ffffffff-ffff-4fff-8fff-fffffffffff2';
  deal_id constant text := 'f3333333333333333333333333333333';
  cold_call_id bigint;
  proposal_email_id bigint;
  customer_reply_id bigint;
  drip_email_id bigint;
  today_email_id bigint;
  touches jsonb;
  result jsonb;
  deal_item jsonb;
begin
  -- Migration baselines are timestamped at replay time and would otherwise
  -- outrank this fixture's intentionally fixed historical snapshots.
  delete from public.dripjobs_pipeline_sync_runs
  where workspace_key = 'ottawa-painters';

  insert into public.people (id, workspace_key, display_name, primary_email, primary_phone)
  values (
    person_id,
    'ottawa-painters',
    'Stage Touch Test Contact',
    'stage.touches@fluid.invalid',
    '+16135550992'
  );

  insert into public.person_identifiers (
    person_id, kind, value, normalized_value,
    source_system, source_record_type, source_record_id,
    is_primary, active
  ) values
    (
      person_id, 'email', 'stage.touches@fluid.invalid', 'stage.touches@fluid.invalid',
      'pipeline-test', 'contact', 'stage-touch-email', true, true
    ),
    (
      person_id, 'phone', '+1 (613) 555-0992', '6135550992',
      'pipeline-test', 'contact', 'stage-touch-phone', true, true
    );

  perform private.ensure_person_identifier_identities('ottawa-painters');
  perform private.reconcile_lead_identity_graph();

  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(jsonb_build_object(
      'dealId', deal_id,
      'salesStatus', 'Open',
      'customerName', 'Stage Touch Test Contact',
      'email', 'stage.touches@fluid.invalid',
      'phone', '613-555-0992',
      'dealName', 'Stage Touch Test Deal',
      'dealStage', 'Cold Leads',
      'dealAmountCents', 40000
    )),
    '[]'::jsonb,
    '2026-01-01T10:05:00Z',
    'test:stage-touches-cold',
    'ottawa-painters'
  );
  if result ->> 'status' <> 'succeeded' then
    raise exception 'Cold-stage reconciliation failed: %', result;
  end if;

  insert into public.activities (
    workspace_key, source, account_phone, external_id, event_type, direction,
    subject, preview, occurred_at, call_status, duration_seconds
  ) values (
    'ottawa-painters', 'quo', '+16135550992', 'stage-touch-cold-call', 'call.completed', 'outbound',
    'Outbound call', 'Chased the new lead', '2026-01-02 12:00:00+00', 'completed', 90
  ) returning id into cold_call_id;

  insert into public.activity_people (activity_id, person_id, relationship, matched_by, confidence)
  values (cold_call_id, person_id, 'counterparty', 'manual', 1);

  touches := private.deal_current_stage_touches('ottawa-painters', deal_id);
  if (touches ->> 'outbound')::integer <> 1
     or (touches ->> 'lastDirection') <> 'outbound' then
    raise exception 'Cold-stage outreach was not counted: %', touches;
  end if;

  -- The deal moves on. Everything above belongs to the stage it just left.
  result := public.reconcile_dripjobs_pipeline(
    jsonb_build_array(jsonb_build_object(
      'dealId', deal_id,
      'salesStatus', 'Open',
      'customerName', 'Stage Touch Test Contact',
      'email', 'stage.touches@fluid.invalid',
      'phone', '613-555-0992',
      'dealName', 'Stage Touch Test Deal',
      'dealStage', 'Proposal(s) Sent',
      'dealAmountCents', 40000
    )),
    '[]'::jsonb,
    '2026-01-10T10:05:00Z',
    'test:stage-touches-proposal',
    'ottawa-painters'
  );
  if result ->> 'status' <> 'succeeded' then
    raise exception 'Proposal-stage reconciliation failed: %', result;
  end if;

  touches := private.deal_current_stage_touches('ottawa-painters', deal_id);
  if (touches ->> 'outbound')::integer <> 0
     or touches ->> 'lastAt' is not null then
    raise exception 'Cold-stage outreach followed the deal into its new stage: %', touches;
  end if;

  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    subject, preview, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'stage.touches@fluid.invalid', 'stage-touch-proposal-email', 'email.sent', 'outbound',
    'Your proposal', 'Sending the proposal over', '2026-01-11 12:00:00+00'
  ) returning id into proposal_email_id;

  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    subject, preview, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'stage.touches@fluid.invalid', 'stage-touch-reply', 'email.received', 'inbound',
    'Re: Your proposal', 'Reviewing it this week', '2026-01-12 12:00:00+00'
  ) returning id into customer_reply_id;

  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    subject, preview, occurred_at, source_metadata
  ) values (
    'ottawa-painters', 'gmail', 'stage.touches@fluid.invalid', 'stage-touch-drip', 'email.sent', 'outbound',
    'Still thinking it over?', 'Nurture sequence step 3', '2026-01-13 12:00:00+00',
    jsonb_build_object('automated', 'true')
  ) returning id into drip_email_id;

  insert into public.activity_people (activity_id, person_id, relationship, matched_by, confidence)
  values
    (proposal_email_id, person_id, 'counterparty', 'manual', 1),
    (customer_reply_id, person_id, 'counterparty', 'manual', 1),
    (drip_email_id, person_id, 'counterparty', 'manual', 1);

  touches := private.deal_current_stage_touches('ottawa-painters', deal_id);
  if (touches ->> 'outbound')::integer <> 1
     or (touches ->> 'inbound')::integer <> 1
     or (touches ->> 'automated')::integer <> 1 then
    raise exception 'Proposal-stage touch counts are wrong: %', touches;
  end if;

  -- The newest touch is the customer's reply; the later drip send is automated
  -- and must not make an unanswered deal look recently worked.
  if (touches ->> 'lastDirection') <> 'inbound'
     or (touches ->> 'lastAt')::timestamptz <> '2026-01-12 12:00:00+00'::timestamptz then
    raise exception 'Automated send was treated as the last touch: %', touches;
  end if;

  result := public.list_current_dripjobs_pipeline('ottawa-painters');
  select item into deal_item
  from jsonb_array_elements(result -> 'items') item
  where item ->> 'id' = deal_id;

  if deal_item is null then
    raise exception 'The current pipeline listing dropped the test deal';
  end if;
  if (deal_item #>> '{stageTouches,outbound}')::integer <> 1
     or (deal_item #>> '{stageTouches,inbound}')::integer <> 1
     or (deal_item #>> '{stageTouches,lastDirection}') <> 'inbound' then
    raise exception 'The board listing did not carry current-stage touches: %', deal_item;
  end if;

  -- The strip is anchored to the day the deal entered this stage and grows a
  -- cell a day up to today, capped at what a board column holds.
  if jsonb_array_length(touches -> 'days')
     <> least(16, ((now() at time zone 'America/Toronto')::date
                   - ('2026-01-10T10:05:00Z'::timestamptz at time zone 'America/Toronto')::date) + 1) then
    raise exception 'The day strip is not anchored to stage entry: %', touches -> 'days';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(touches -> 'days') level
    where level.value::integer not between 0 and 3
  ) then
    raise exception 'The day strip carried a level the card cannot draw: %', touches -> 'days';
  end if;

  -- This deal has been parked since January, so the strip long since hit its
  -- cap and has to admit how many stage days it could not draw.
  if (touches ->> 'daysBefore')::integer <> greatest(
       0,
       ((now() at time zone 'America/Toronto')::date
         - ('2026-01-10T10:05:00Z'::timestamptz at time zone 'America/Toronto')::date) - 15
     ) then
    raise exception 'The dropped stage days were not counted: %', touches ->> 'daysBefore';
  end if;

  -- Today is the last cell. Dating a touch now must light it, whatever the
  -- rest of the deal's history looks like.
  insert into public.activities (
    workspace_key, source, account_email, external_id, event_type, direction,
    subject, preview, occurred_at
  ) values (
    'ottawa-painters', 'gmail', 'stage.touches@fluid.invalid', 'stage-touch-today', 'email.sent', 'outbound',
    'Following up', 'Checking in on the proposal', now()
  ) returning id into today_email_id;

  insert into public.activity_people (activity_id, person_id, relationship, matched_by, confidence)
  values (today_email_id, person_id, 'counterparty', 'manual', 1);

  touches := private.deal_current_stage_touches('ottawa-painters', deal_id);
  if (touches -> 'days' ->> (jsonb_array_length(touches -> 'days') - 1))::integer <> 2 then
    raise exception 'Today''s outreach did not land on the last day cell: %', touches -> 'days';
  end if;
end;
$$;

rollback;
