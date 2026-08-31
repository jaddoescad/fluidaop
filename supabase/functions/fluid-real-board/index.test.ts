import { assertEquals } from "jsr:@std/assert@1";
import { cleanExecutionReferences, handleRequest, safeDiagnostic } from "./index.ts";

Deno.test("automation result lookup requires server authorization", async () => {
  const response = await handleRequest(new Request(
    "https://example.invalid?action=agent-run-results",
    { method: "POST", body: "{}" },
  ));
  assertEquals(response.status, 401);
});

Deno.test("accepts only bounded exact Hermes execution references", () => {
  assertEquals(cleanExecutionReferences([
    { profile: "default", executionId: "execution:123" },
  ]), [{ profile: "default", executionId: "execution:123" }]);
  assertEquals(cleanExecutionReferences([]), null);
  assertEquals(cleanExecutionReferences([
    { profile: "../bad", executionId: "execution:123" },
  ]), null);
  assertEquals(cleanExecutionReferences(Array.from({ length: 101 }, () => ({
    profile: "default",
    executionId: "execution:123",
  }))), null);
});

Deno.test("redacts URLs and credential-shaped diagnostics", () => {
  assertEquals(
    safeDiagnostic("download https://recording.invalid/private token=top-secret failed"),
    "download [url redacted] token=[redacted] failed",
  );
});
