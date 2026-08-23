import { useEffect, useMemo, useReducer } from 'react';
import { initialState, Msg, reducer } from './engine';
import { AutoRule, State } from './types';

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
}

export function useFluid(): { s: State; act: Act } {
  const [s, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    dispatch({ type: 'boot', now: Date.now() });
    const iv = window.setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 1000);
    return () => window.clearInterval(iv);
  }, []);

  const act = useMemo<Act>(() => {
    const d = (m: Msg) => dispatch(m);
    return {
      focus: (personId) => d({ type: 'focus', personId }),
      done: (id) => d({ type: 'completeAction', id }),
      snooze: (id) => d({ type: 'snoozeAction', id }),
      remDone: (id) => d({ type: 'completeReminder', id }),
      remSnooze: (id) => d({ type: 'snoozeReminder', id }),
      acceptTag: (personId, tag) => d({ type: 'acceptTag', personId, tag }),
      runNba: (personId, nbaId) => d({ type: 'executeNba', personId, nbaId }),
      togglePause: () => d({ type: 'togglePause' }),
      toggleAuto: (rule) => d({ type: 'toggleAuto', rule }),
      toggleSeq: (seqId) => d({ type: 'toggleSeq', seqId }),
      createReminder: (signalId, note, dueInMs) => d({ type: 'createReminder', signalId, note, dueInMs }),
      createAction: (signalId, title) => d({ type: 'createAction', signalId, title }),
      enrollSeq: (signalId, seqId) => d({ type: 'enrollSeq', signalId, seqId }),
      undoAction: (id) => d({ type: 'undoAction', id }),
      undoReminder: (id) => d({ type: 'undoReminder', id }),
      retryRun: (id) => d({ type: 'retryRun', id }),
      takeRec: (id) => d({ type: 'takeRec', id }),
      triggerReminder: (id) => d({ type: 'triggerReminder', id }),
      cancelReminder: (id) => d({ type: 'cancelReminder', id }),
      stopSeq: (instId) => d({ type: 'stopSeq', instId }),
    };
  }, []);

  return { s, act };
}
