# Potential Lead Classifier — inbound email, text, call → Potential Leads

This is a new, independent Hermes agent.

Nothing in this directory deploys automatically. Follow the cross-layer order below before provisioning the new Hermes job.

The worker's Gmail attachment inspection uses the existing read-only `/opt/data/bin/ottawa-gmail-read`, `/opt/data/bin/lib/ottawa-gmail-read.mjs`, and `/opt/data/bin/lib/ottawa-customer-rag.mjs` host files.

## Safe deployment order

1. Apply the corrective database migration that creates the dedicated classifier queue and functions. Classifier jobs may accumulate safely before its worker exists.
2. Deploy only the dedicated `fluid-potential-lead-classifier` Edge Function.
3. Provision this dedicated Hermes worker, skill, policy, verified presentation contract, and scheduled job.
4. Enable the classifier schedule and deterministic reconcile cron after verification.

These steps are instructions only; this repository task does not deploy them.

## Host files

| Repository file | Hermes host path |
|---|---|
| `fluid-potential-lead-classifier.mjs` | `/opt/data/bin/fluid-potential-lead-classifier.mjs` |
| `../automation-creator/runtime-correlation.mjs` | `/opt/data/automation-creator/runtime-correlation.mjs` |
| `fluid-potential-lead-classifier-precheck.sh` | `/opt/data/bin/fluid-potential-lead-classifier-precheck.sh` |
| `fluid-potential-lead-classifier-reconcile.sh` | `/opt/data/bin/fluid-potential-lead-classifier-reconcile.sh` |
| `SKILL.md` | `/opt/data/skills/ottawa-painters/fluid-potential-lead-classifier/SKILL.md` |
| `install-ottawa-potential-lead-classifier-policy.sh` | a temporary admin-controlled path; run once, then remove it |

## Configuration

Set the same strong secret in both places:

- Edge Function secret: `FLUID_POTENTIAL_LEAD_CLASSIFIER_SECRET`
- Hermes environment: `FLUID_POTENTIAL_LEAD_CLASSIFIER_SECRET`

Optional Hermes overrides are `FLUID_POTENTIAL_LEAD_CLASSIFIER_URL`, `FLUID_POTENTIAL_LEAD_CLASSIFIER_STATE_DIR`, and `FLUID_POTENTIAL_LEAD_CLASSIFIER_MODEL`.

## Provisioning

1. Upload the runtime files above, preserving the worker-to-correlation-helper relative path.
2. Make both shell scripts and the worker executable.
3. Run the policy installer once as the account that owns `/opt/data/agent-hooks/ottawa-tool-policy.py`.
4. Create a distinct Hermes scheduled job named **Potential Lead Classifier — inbound email, text, call → Potential Leads**. Attach only the `fluid-potential-lead-classifier` skill and use `/opt/data/bin/fluid-potential-lead-classifier-precheck.sh` as its one-minute pre-check.
5. Create a Hermes script job named **Potential Lead Classifier queue repair — nightly** using `fluid-potential-lead-classifier-reconcile.sh` at `41 2 * * *`. Do not add a host crontab.
6. Create and verify the definition-bound Fluid presentation contract after Hermes assigns each job ID:

   ```bash
   /opt/hermes/.venv/bin/python3 /opt/data/bin/fluid-automation-contract.py create \
     --job-id JOB_ID \
     --automation-key potential-lead-classifier \
     --subject signal \
     --display-name "Potential Lead Classifier — inbound email, text, call → Potential Leads" \
     --summary "Reviews unknown inbound email, text, and calls and sends eligible painting prospects to Potential Leads for human review." \
     --step "Classify each eligible inbound signal as a potential painting lead or not." \
     --step "Store eligible leads in Potential Leads for a person to review."
   /opt/hermes/.venv/bin/python3 /opt/data/bin/fluid-automation-contract.py verify --job-id JOB_ID

   /opt/hermes/.venv/bin/python3 /opt/data/bin/fluid-automation-contract.py create \
     --job-id REPAIR_JOB_ID \
     --automation-key potential-lead-classifier-repair \
     --display-name "Potential Lead Classifier queue repair — nightly" \
     --summary "Repairs expired Potential Lead queue leases and restores eligible work." \
     --step "Reconcile the bounded Potential Lead queue once."
   ```

   Verification must report `verified: true`. If the prompt, skill, or pre-check changes later, regenerate this contract instead of adding fallback UI copy.

## Verification

Run these without printing the secret:

```bash
node --check /opt/data/bin/fluid-potential-lead-classifier.mjs
node --input-type=module -e "import('/opt/data/bin/fluid-potential-lead-classifier.mjs').then(m => console.log(m.PROMPT_VERSION))"
node /opt/data/bin/fluid-potential-lead-classifier.mjs status
```

The prompt version must be `fluid-potential-lead-classifier-v2`, and status must report `agentKey: potential-lead-classifier`.

Trigger the new scheduled job once from Hermes. Confirm that its run and queue appear under the Potential Lead Classifier agent. Do not deploy from this repository automatically.

The worker fails closed unless it can read the profile-local
`$HERMES_HOME/cron/executions.db`. It captures the one active durable execution
for its cron session; it never infers an execution from timestamps.
