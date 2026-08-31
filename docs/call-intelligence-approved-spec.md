# Call Intelligence — approved follow-on

Call Intelligence remains approved but is intentionally deferred until the Hermes Automation Activity and Signal-Run Protocol is deployed and verified.

The follow-on automation will:

- use Hermes exclusively, with `automationKey` `call-intelligence` and `signal` subject support;
- process only calls completed after its deployment cutoff when Quo recordings are available;
- transcribe chronological recording segments with OpenAI diarized transcription, preserving timestamped Speaker A/B turns;
- store the transcript before summary reasoning so retries do not retranscribe;
- produce concise factual summaries and discussed next steps using the approved Hermes model profile;
- atomically link each business result, queue terminal state, Signal, `agent_run`, and exact Hermes execution;
- appear in global Activity for every scheduled invocation and in the Signal's Agent activity for each queue/run lifecycle event;
- leave Quo as the call/message/recording source while removing reliance on Quo-generated transcripts and summaries.

Historical calls are not backfilled. Empty recordings settle as unavailable, expired URLs return to recording recovery, and transient failures retry with bounded exponential backoff.
