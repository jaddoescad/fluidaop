import { assertEquals } from "jsr:@std/assert@1";
import { CLASSIFIER_DISPLAY_NAME, cleanCompletion } from "./index.ts";

const leaseToken = "8c914d9a-20d5-4a3d-a352-5e27591be006";
const runtime = {
  runtimeProfile: "default",
  runtimeJobId: "hermes-job-123",
  runtimeExecutionId: "execution-456",
  runtimeSessionId: "session-123",
};

Deno.test("uses the canonical purpose-first classifier title", () => {
  assertEquals(
    CLASSIFIER_DISPLAY_NAME,
    "Potential Lead Classifier — inbound email, text, call → Potential Leads",
  );
});

Deno.test("accepts a bounded lead classification", () => {
  const result = cleanCompletion({
    jobId: 17,
    leaseToken,
    verdict: "lead",
    confidence: 0.91,
    name: " Pat Prospect ",
    email: "Pat@Example.com",
    phone: "+1 (613) 555-0123",
    summary: "Wants an exterior quote",
    reason: "Direct request for painting work",
    model: "classifier-model",
    promptVersion: "fluid-potential-lead-classifier-v1",
    evidence: { signal: "direct-request" },
    ...runtime,
  });
  assertEquals(result.error, null);
  assertEquals(result.value?.email, "pat@example.com");
  assertEquals(result.value?.name, "Pat Prospect");
  assertEquals(result.value?.verdict, "lead");
});

Deno.test("accepts not_lead without contact fields", () => {
  const result = cleanCompletion({
    jobId: 18,
    leaseToken,
    verdict: "not_lead",
    confidence: 0.99,
    reason: "Automated promotion",
    promptVersion: "fluid-potential-lead-classifier-v1",
    ...runtime,
  });
  assertEquals(result.error, null);
  assertEquals(result.value?.name, null);
  assertEquals(result.value?.evidence, {});
});

Deno.test("rejects malformed or oversized decisions", () => {
  assertEquals(
    cleanCompletion({
      jobId: 1,
      leaseToken,
      verdict: "maybe",
      confidence: 0.5,
      reason: "unclear",
      promptVersion: "v1",
      ...runtime,
    }).error,
    "verdict must be lead or not_lead",
  );
  assertEquals(
    cleanCompletion({
      jobId: 1,
      leaseToken,
      verdict: "lead",
      confidence: 1.1,
      reason: "request",
      promptVersion: "v1",
      ...runtime,
    }).error,
    "confidence must be between 0 and 1",
  );
  assertEquals(
    cleanCompletion({
      jobId: 1,
      leaseToken,
      verdict: "lead",
      confidence: 0.8,
      email: "not-an-email",
      reason: "request",
      promptVersion: "v1",
      ...runtime,
    }).error,
    "email is not an email address",
  );
  assertEquals(
    cleanCompletion({
      jobId: 1,
      leaseToken,
      verdict: "lead",
      confidence: 0.8,
      reason: "request",
      promptVersion: "v1",
      evidence: { value: "x".repeat(1_000_001) },
      ...runtime,
    }).error,
    "Invalid classifier evidence or metadata",
  );
});

Deno.test("requires runtime-captured Hermes correlation", () => {
  assertEquals(
    cleanCompletion({
      jobId: 1,
      leaseToken,
      verdict: "not_lead",
      confidence: 0.9,
      reason: "Not a lead",
      promptVersion: "v1",
    }).error,
    "Invalid classifier evidence or metadata",
  );
});
