-- Remove the retired Signal Recommender runtime completely. The independent
-- Potential Lead Classifier has its own queue, revision clock, triggers, and
-- runtime. Historical recommendations, runs, and terminal jobs remain readable.

-- Stop every producer before deleting queued work so concurrent Activity or
-- Case updates cannot recreate a job during this migration.
drop trigger if exists activities_bump_signal_recommender_revision
on public.activities;
drop trigger if exists activities_enqueue_signal_recommender
on public.activities;
drop trigger if exists operational_cases_enqueue_signal_recommender
on public.operational_cases;
drop trigger if exists activities_settle_signal_recommendations_after_outbound
on public.activities;

-- Preserve historical queue/run/result records. Only unfinished work is
-- settled, so Signal history can state that the capability was retired.
update public.agent_jobs
set status = 'retired',
    finished_at = coalesce(finished_at, clock_timestamp()),
    last_error = 'Retired: Signal Recommender was removed.',
    lease_owner = null,
    lease_token = null,
    leased_until = null,
    updated_at = clock_timestamp()
where agent_key = 'signal-recommender'
  and status in ('pending', 'leased');

drop function if exists public.reconcile_signal_recommender(text, integer);
drop function if exists public.claim_signal_recommender_job(text, integer);
drop function if exists public.complete_signal_recommender_job(
  bigint, uuid, text, text, jsonb
);
drop function if exists public.fail_signal_recommender_job(
  bigint, uuid, text, text, text
);
drop function if exists private.bump_signal_recommender_revision();
drop function if exists private.enqueue_signal_recommender(bigint, text);
drop function if exists private.enqueue_signal_recommender_after_activity();
drop function if exists private.enqueue_signal_recommender_after_case_revision();
drop function if exists private.settle_signal_recommendations_after_outbound();
drop function if exists private.settle_handled_signal_recommendations(bigint);

drop table if exists public.signal_recommender_settings;
