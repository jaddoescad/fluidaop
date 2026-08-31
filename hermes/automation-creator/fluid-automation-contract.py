#!/usr/bin/env python3
"""Create and verify Fluid presentation contracts for live Hermes jobs."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, List


def _load_contract_module():
    candidates = [
        Path("/opt/data/plugins/fluid-history/dashboard/agent_contracts.py"),
        Path(__file__).resolve().parents[1] / "fluid-history" / "dashboard" / "agent_contracts.py",
    ]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        import importlib.util

        spec = importlib.util.spec_from_file_location("fluid_agent_contracts", candidate)
        if spec is None or spec.loader is None:
            continue
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    raise RuntimeError("Fluid automation contract module is not installed")


def _jobs() -> List[Dict[str, Any]]:
    from hermes_cli import web_server as ws

    return list(ws._list_cron_jobs_sync("all"))


def _job(job_id: str) -> Dict[str, Any]:
    for job in _jobs():
        if str(job.get("id") or "") == job_id:
            return job
    raise ValueError("Hermes job not found")


def _safe_output(value: Dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="Create or replace a verified contract")
    create.add_argument("--job-id", required=True)
    create.add_argument("--automation-key", required=True)
    create.add_argument("--subject", action="append", default=[])
    create.add_argument("--display-name", required=True)
    create.add_argument("--summary", required=True)
    create.add_argument("--step", action="append", default=[])
    create.add_argument("--icon")

    verify = subparsers.add_parser("verify", help="Verify the stored contract")
    verify.add_argument("--job-id", required=True)

    args = parser.parse_args()
    contracts = _load_contract_module()
    job = _job(args.job_id)

    if args.command == "create":
        contract = contracts.build_contract(
            job,
            automation_key=args.automation_key,
            subject_types=args.subject,
            display_name=args.display_name,
            summary=args.summary,
            steps=args.step,
            icon=args.icon,
        )
        contracts.write_contract(contract)
        _safe_output({
            "jobId": args.job_id,
            "automationKey": contract["automationKey"],
            "subjectTypes": contract["subjectTypes"],
            "status": "created",
            "definitionHash": contract["definitionHash"],
            "stepCount": len(contract["steps"]),
        })
        return 0

    contract, status = contracts.verified_contract(job)
    _safe_output({
        "jobId": args.job_id,
        "automationKey": contract.get("automationKey") if contract is not None else None,
        "subjectTypes": contract.get("subjectTypes") if contract is not None else [],
        "status": status,
        "verified": contract is not None,
        "stepCount": len(contract["steps"]) if contract is not None else 0,
    })
    return 0 if contract is not None else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        _safe_output({"status": "error", "error": " ".join(str(error).split())[:240]})
        raise SystemExit(1)
