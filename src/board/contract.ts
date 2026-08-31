import { LeadCandidateDisposition } from '../types';

/** Commands backed by the live Board API. */
export interface Act {
  focus: (id: string | null) => void;
  acceptRecommendation: (signalId: string, recommendationId: string) => Promise<string>;
  updateActionDraft: (actionId: string, revision: number, draftBody: string) => Promise<void>;
  simulateActionSend: (actionId: string, revision: number) => Promise<void>;
  retryAction: (actionId: string) => Promise<void>;
  dismissAction: (actionId: string) => Promise<void>;
  /** Idempotent: opening a Signal twice records one read. */
  markSignalRead: (signalId: string) => Promise<void>;
  decideLeadCandidate: (candidateId: number, disposition: LeadCandidateDisposition) => Promise<void>;
}
