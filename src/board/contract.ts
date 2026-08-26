import { AutoRule } from '../types';

export interface Act {
  focus: (id: string | null) => void;
  done: (id: string) => void;
  snooze: (id: string) => void;
  remDone: (id: string) => void;
  remSnooze: (id: string) => void;
  acceptTag: (personId: string, tag: string) => void;
  runNba: (personId: string, nbaId: string) => void;
  togglePause: () => void;
  toggleAuto: (rule: AutoRule) => void;
  toggleSeq: (seqId: string) => void;
  createReminder: (signalId: string, note: string, dueInMs: number) => void;
  createAction: (signalId: string, title: string) => void;
  enrollSeq: (signalId: string, seqId: string) => void;
  undoAction: (id: string) => void;
  undoReminder: (id: string) => void;
  retryRun: (id: string) => void;
  takeRec: (id: string) => void;
  triggerReminder: (id: string) => void;
  cancelReminder: (id: string) => void;
  stopSeq: (instId: string) => void;
  settleSignal: (id: string) => Promise<void>;
  acceptRecommendation: (signalId: string, recommendationId: string) => Promise<string>;
  updateActionDraft: (actionId: string, revision: number, draftBody: string) => Promise<void>;
  simulateActionSend: (actionId: string, revision: number) => Promise<void>;
  retryAction: (actionId: string) => Promise<void>;
  dismissAction: (actionId: string) => Promise<void>;
}
