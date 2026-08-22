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
    };
  }, []);

  return { s, act };
}
