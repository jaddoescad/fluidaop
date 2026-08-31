import {
  FluidTopicLabel,
  GmailLabelApiError,
  GmailLabelMapping,
  GmailLabelProjectionResult,
  GmailSupplementalLabelPlan,
} from './gmailLabelSync.js';

export interface GmailLabelSyncClaim {
  job: {
    id: number;
    leaseToken: string;
    generation: number;
    attempts: number;
    claimedAt: string;
  } | null;
  message?: {
    activityId: number;
    accountEmail: string;
    externalId: string;
  };
  desiredLabel?: FluidTopicLabel;
  topicLabels?: FluidTopicLabel[];
  mappings?: GmailLabelMapping[];
  roleLabels?: string[];
  managedRoleLabels?: string[];
}

export interface GmailLabelCompletion extends GmailLabelProjectionResult {
  jobId: number;
  leaseToken: string;
  generation: number;
}

export interface GmailLabelFailure {
  jobId: number;
  leaseToken: string;
  generation: number;
  error: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
}

export interface GmailLabelWorkerDependencies {
  maxJobs: number;
  shouldContinue?(): boolean;
  claim(): Promise<GmailLabelSyncClaim>;
  project(
    messageId: string,
    desired: FluidTopicLabel,
    topics: FluidTopicLabel[],
    mappings: GmailLabelMapping[],
    supplemental: GmailSupplementalLabelPlan,
  ): Promise<GmailLabelProjectionResult>;
  complete(completion: GmailLabelCompletion): Promise<void>;
  fail(failure: GmailLabelFailure): Promise<void>;
}

function safeWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 1000) || 'Gmail label projection failed';
}

function validClaim(claim: GmailLabelSyncClaim): claim is GmailLabelSyncClaim & {
  job: NonNullable<GmailLabelSyncClaim['job']>;
  message: NonNullable<GmailLabelSyncClaim['message']>;
  desiredLabel: FluidTopicLabel;
  topicLabels: FluidTopicLabel[];
  mappings: GmailLabelMapping[];
} {
  return Boolean(
    claim.job && claim.message && claim.desiredLabel &&
    Array.isArray(claim.topicLabels) && Array.isArray(claim.mappings),
  );
}

export async function runGmailLabelSyncBatch(
  dependencies: GmailLabelWorkerDependencies,
): Promise<{ claimed: number; completed: number; failed: number }> {
  const result = { claimed: 0, completed: 0, failed: 0 };
  for (let index = 0; index < dependencies.maxJobs; index += 1) {
    if (dependencies.shouldContinue && !dependencies.shouldContinue()) break;
    const claim = await dependencies.claim();
    if (claim.job === null) break;
    if (!validClaim(claim)) throw new Error('Gmail label sync returned an invalid claimed job');
    result.claimed += 1;

    let projection: GmailLabelProjectionResult;
    try {
      projection = await dependencies.project(
        claim.message.externalId,
        claim.desiredLabel,
        claim.topicLabels,
        claim.mappings,
        {
          desiredNames: claim.roleLabels ?? [],
          managedNames: claim.managedRoleLabels ?? [],
        },
      );
    } catch (error) {
      const gmailError = error instanceof GmailLabelApiError ? error : null;
      await dependencies.fail({
        jobId: claim.job.id,
        leaseToken: claim.job.leaseToken,
        generation: claim.job.generation,
        error: safeWorkerError(error),
        retryable: gmailError?.retryable ?? false,
        retryAfterSeconds: gmailError?.retryAfterSeconds ?? null,
      });
      result.failed += 1;
      if (gmailError?.retryable) break;
      continue;
    }

    // Completion records the result under the active lease. If that database
    // call fails, leave the job leased and surface the error so the lease can
    // expire and the idempotent Gmail projection can be retried. Calling
    // `fail` here would incorrectly turn a successful Gmail mutation into a
    // terminal projection failure.
    await dependencies.complete({
      jobId: claim.job.id,
      leaseToken: claim.job.leaseToken,
      generation: claim.job.generation,
      ...projection,
    });
    result.completed += 1;
  }
  return result;
}
