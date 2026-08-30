import { assertEquals } from 'jsr:@std/assert@1';
import { recordingInput, summaryInput, transcriptInput } from './index.ts';

Deno.test('normalizes a completed Quo transcript webhook', () => {
  const transcript = transcriptInput({
    id: 'EV_transcript',
    type: 'call.transcript.completed',
    data: { object: {
      id: 'CT_transcript',
      callId: 'AC_call',
      dialogue: [{ identifier: '+16135550123', content: 'Please send the quote.', start: 1, end: 3 }],
    } },
  });
  assertEquals(transcript?.callId, 'AC_call');
  assertEquals(transcript?.dialogue[0]?.content, 'Please send the quote.');
});

Deno.test('keeps only HTTPS recording media from a completed Quo webhook', () => {
  const recording = recordingInput({
    id: 'EV_recording',
    type: 'call.recording.completed',
    data: { object: {
      id: 'AC_call',
      completedAt: '2026-08-28T12:00:00.000Z',
      media: [
        { id: 'CR_one', url: 'https://media.quo.com/recording.mp3', type: 'audio/mpeg', duration: 42 },
        { id: 'CR_bad', url: 'http://example.com/insecure.mp3' },
      ],
    } },
  });
  assertEquals(recording?.callId, 'AC_call');
  assertEquals(recording?.recordings.length, 1);
  assertEquals(recording?.recordings[0]?.id, 'CR_one');
});

Deno.test('normalizes Quo summary and next-step variants', () => {
  const summary = summaryInput({
    id: 'EV_summary',
    type: 'call.summary.completed',
    data: { object: {
      callId: 'AC_call',
      summary: ['Customer requested an exterior estimate.'],
      nextSteps: [{ content: 'Send an estimate by Friday.' }],
      jobs: [{ id: 'job-one', status: 'completed' }],
    } },
  });
  assertEquals(summary?.callId, 'AC_call');
  assertEquals(summary?.summary, ['Customer requested an exterior estimate.']);
  assertEquals(summary?.nextSteps, ['Send an estimate by Friday.']);
});
