import {
  createAdminClient,
  jsonResponse as response,
  validSecret,
} from "../_shared/runtime.ts";

const AGENT_KEY = "potential-lead-classifier";
export const CLASSIFIER_DISPLAY_NAME =
  "Potential Lead Classifier — inbound email, text, call → Potential Leads";
const WORKSPACE_KEY = "ottawa-painters";
const MAX_BODY_BYTES = 1_250_000;
const MAX_EVIDENCE_BYTES = 1_000_000;

type JsonRecord = Record<string, unknown>;

export type CompletionPayload = {
  jobId: number;
  leaseToken: string;
  verdict: "lead" | "not_lead";
  confidence: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  summary: string | null;
  reason: string;
  model: string;
  promptVersion: string;
  runtimeProfile: string;
  runtimeJobId: string;
  runtimeExecutionId: string;
  runtimeSessionId: string;
  evidence: JsonRecord;
};

function object(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(
  value: unknown,
  maximum: number,
  required = false,
): string | null {
  if (typeof value !== "string") return required ? null : "";
  const cleaned = value.trim();
  if ((required && cleaned.length === 0) || cleaned.length > maximum) {
    return null;
  }
  return cleaned;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function authorized(req: Request): boolean {
  const supplied = req.headers.get("x-fluid-agent-secret")?.trim() ?? "";
  return validSecret(supplied, [
    Deno.env.get("FLUID_POTENTIAL_LEAD_CLASSIFIER_SECRET"),
  ]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (object(error) && typeof error.message === "string") return error.message;
  return "Unexpected function error";
}

async function bodyOf(req: Request): Promise<JsonRecord | null> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return object(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function cleanCompletion(
  body: JsonRecord,
): { value: CompletionPayload | null; error: string | null } {
  const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
  const verdict = text(body.verdict, 20, true);
  const confidence =
    typeof body.confidence === "number" && Number.isFinite(body.confidence)
      ? body.confidence
      : Number.NaN;
  const name = text(body.name, 300);
  const email = text(body.email, 320);
  const phone = text(body.phone, 40);
  const summary = text(body.summary, 2000);
  const reason = text(body.reason, 2000, true);
  const model = text(body.model, 200);
  const promptVersion = text(body.promptVersion, 100, true);
  const runtimeProfile = text(body.runtimeProfile, 64, true);
  const runtimeJobId = text(body.runtimeJobId, 128, true);
  const runtimeExecutionId = text(body.runtimeExecutionId, 256, true);
  const runtimeSessionId = text(body.runtimeSessionId, 128, true);
  const evidence = body.evidence === undefined
    ? {}
    : object(body.evidence)
    ? body.evidence
    : null;

  if (jobId === null || !uuid(body.leaseToken)) {
    return { value: null, error: "Invalid job lease" };
  }
  if (verdict !== "lead" && verdict !== "not_lead") {
    return { value: null, error: "verdict must be lead or not_lead" };
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { value: null, error: "confidence must be between 0 and 1" };
  }
  if (name === null || email === null || phone === null || summary === null) {
    return { value: null, error: "Classifier text fields are too long" };
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { value: null, error: "email is not an email address" };
  }
  if (phone && !/^\+?[0-9(][0-9 ().-]{5,}$/.test(phone)) {
    return { value: null, error: "phone is not a phone number" };
  }
  if (
    reason === null || model === null || promptVersion === null ||
    runtimeProfile === null || runtimeJobId === null || runtimeExecutionId === null ||
    runtimeSessionId === null ||
    !/^[A-Za-z0-9_-]+$/.test(runtimeProfile) ||
    !/^[A-Za-z0-9_.:-]+$/.test(runtimeJobId) ||
    !/^[A-Za-z0-9_.:-]+$/.test(runtimeExecutionId) ||
    !/^[A-Za-z0-9._:-]+$/.test(runtimeSessionId) ||
    evidence === null ||
    jsonSize(evidence) > MAX_EVIDENCE_BYTES
  ) {
    return { value: null, error: "Invalid classifier evidence or metadata" };
  }

  return {
    value: {
      jobId,
      leaseToken: body.leaseToken,
      verdict,
      confidence,
      name: name || null,
      email: email ? email.toLowerCase() : null,
      phone: phone || null,
      summary: summary || null,
      reason,
      model: model || "",
      promptVersion,
      runtimeProfile,
      runtimeJobId,
      runtimeExecutionId,
      runtimeSessionId,
      evidence,
    },
    error: null,
  };
}

export async function handleRequest(req: Request): Promise<Response> {
  if (!authorized(req)) return response({ error: "Unauthorized" }, 401);

  try {
    const client = createAdminClient();
    const action = new URL(req.url).searchParams.get("action") ?? "status";

    if (req.method === "GET" && action === "status") {
      const statuses = ["pending", "leased", "succeeded", "failed"] as const;
      const [counts, recent, settings] = await Promise.all([
        Promise.all(statuses.map(async (status) => {
          const { count, error } = await client.from("agent_jobs")
            .select("id", { count: "exact", head: true })
            .eq("agent_key", AGENT_KEY).eq("status", status);
          if (error) throw error;
          return [status, count ?? 0] as const;
        })),
        client.from("agent_runs")
          .select(
            "id,status,model,prompt_version,error,finished_at,activity_id,input_revision",
          )
          .eq("agent_key", AGENT_KEY).order("finished_at", { ascending: false })
          .limit(10),
        client.from("lead_candidate_settings")
          .select("workspace_key,enabled,started_at,updated_at")
          .eq("workspace_key", WORKSPACE_KEY).single(),
      ]);
      if (recent.error) throw recent.error;
      if (settings.error) throw settings.error;
      return response({
        agentKey: AGENT_KEY,
        displayName: CLASSIFIER_DISPLAY_NAME,
        counts: Object.fromEntries(counts),
        recentRuns: recent.data ?? [],
        settings: settings.data,
        checkedAt: new Date().toISOString(),
      });
    }

    if (req.method !== "POST") return response({ error: "Not found" }, 404);
    const body = await bodyOf(req);
    if (!body) {
      return response(
        { error: "A valid JSON body under 1.25 MB is required" },
        400,
      );
    }

    if (action === "claim") {
      const worker = text(body.worker, 100, true);
      const limit = integer(body.limit ?? 1, 1, 10);
      const leaseSeconds = integer(body.leaseSeconds ?? 900, 60, 3600);
      if (!worker || limit === null || leaseSeconds === null) {
        return response({ error: "Invalid claim request" }, 400);
      }
      const jobs: unknown[] = [];
      for (let index = 0; index < limit; index += 1) {
        const { data, error } = await client.rpc(
          "claim_potential_lead_classifier_job",
          {
            p_worker: worker,
            p_lease_seconds: leaseSeconds,
          },
        );
        if (error) throw error;
        if (!object(data) || data.job === null) break;
        jobs.push(data);
      }
      return response({ agentKey: AGENT_KEY, jobs });
    }

    if (action === "inspect") {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      if (jobId === null || !uuid(body.leaseToken)) {
        return response({ error: "Invalid job lease" }, 400);
      }
      const { data, error } = await client.rpc(
        "inspect_potential_lead_classifier_job",
        {
          p_job_id: jobId,
          p_lease_token: body.leaseToken,
        },
      );
      if (error) throw error;
      return response({ agentKey: AGENT_KEY, item: data });
    }

    if (action === "complete") {
      const completion = cleanCompletion(body);
      if (!completion.value) return response({ error: completion.error }, 400);
      const value = completion.value;
      const { data, error } = await client.rpc(
        "complete_potential_lead_classifier_job",
        {
          p_job_id: value.jobId,
          p_lease_token: value.leaseToken,
          p_verdict: value.verdict,
          p_confidence: value.confidence,
          p_contact_name: value.name,
          p_contact_email: value.email,
          p_contact_phone: value.phone,
          p_summary: value.summary,
          p_reason: value.reason,
          p_model: value.model,
          p_prompt_version: value.promptVersion,
          p_runtime_profile: value.runtimeProfile,
          p_runtime_job_id: value.runtimeJobId,
          p_runtime_execution_id: value.runtimeExecutionId,
          p_runtime_session_id: value.runtimeSessionId,
          p_evidence: value.evidence,
        },
      );
      if (error) throw error;
      return response({ result: data });
    }

    if (action === "fail") {
      const jobId = integer(body.jobId, 1, Number.MAX_SAFE_INTEGER);
      const failure = text(body.error, 2000, true);
      const model = text(body.model, 200);
      const promptVersion = text(body.promptVersion, 100, true);
      const runtimeProfile = text(body.runtimeProfile, 64, true);
      const runtimeJobId = text(body.runtimeJobId, 128, true);
      const runtimeExecutionId = text(body.runtimeExecutionId, 256, true);
      const runtimeSessionId = text(body.runtimeSessionId, 128, true);
      if (
        jobId === null || !uuid(body.leaseToken) || !failure ||
        model === null ||
        !promptVersion || !runtimeProfile || !runtimeJobId || !runtimeExecutionId ||
        !runtimeSessionId ||
        !/^[A-Za-z0-9_-]+$/.test(runtimeProfile) ||
        !/^[A-Za-z0-9_.:-]+$/.test(runtimeJobId) ||
        !/^[A-Za-z0-9_.:-]+$/.test(runtimeExecutionId) ||
        !/^[A-Za-z0-9._:-]+$/.test(runtimeSessionId)
      ) {
        return response({ error: "Invalid failure payload" }, 400);
      }
      const { data, error } = await client.rpc(
        "fail_potential_lead_classifier_job",
        {
          p_job_id: jobId,
          p_lease_token: body.leaseToken,
          p_error: failure,
          p_model: model || "",
          p_prompt_version: promptVersion,
          p_runtime_profile: runtimeProfile,
          p_runtime_job_id: runtimeJobId,
          p_runtime_execution_id: runtimeExecutionId,
          p_runtime_session_id: runtimeSessionId,
        },
      );
      if (error) throw error;
      return response({ result: data });
    }

    if (action === "reconcile") {
      const limit = integer(body.limit ?? 500, 1, 5000);
      if (limit === null) {
        return response({ error: "Invalid reconciliation limit" }, 400);
      }
      const { data, error } = await client.rpc(
        "reconcile_potential_lead_classifier",
        {
          p_workspace_key: WORKSPACE_KEY,
          p_limit: limit,
        },
      );
      if (error) throw error;
      return response({ result: data });
    }

    return response({ error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    return response({ error: errorMessage(error) }, 500);
  }
}

if (import.meta.main) Deno.serve((req: Request) => handleRequest(req));
