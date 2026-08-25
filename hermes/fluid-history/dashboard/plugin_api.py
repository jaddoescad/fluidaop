"""Scoped, read-only Hermes automation API for Fluid.

Mounted by Hermes at ``/api/plugins/fluid-history``. Responses intentionally
contain roster and run metadata only: no prompts, scripts, skill bodies, email
content, invoice content, or session messages leave Hermes.
"""
from __future__ import annotations

import hmac
import importlib.util
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool

from hermes_cli.dashboard_auth.base import (
    DashboardAuthProvider,
    LoginStart,
    Session,
    TokenPrincipal,
)
from hermes_cli.dashboard_auth.registry import get_provider, register_provider
from hermes_cli.dashboard_auth.token_auth import register_token_route

try:
    from .agent_contracts import verified_contract
except (ImportError, ValueError):  # Hermes loads plugin APIs outside a package context.
    contract_module_path = Path(__file__).with_name("agent_contracts.py")
    contract_spec = importlib.util.spec_from_file_location(
        "fluid_history_agent_contracts",
        contract_module_path,
    )
    if contract_spec is None or contract_spec.loader is None:
        raise ImportError("Could not load Fluid agent contract module")
    contract_module = importlib.util.module_from_spec(contract_spec)
    contract_spec.loader.exec_module(contract_module)
    verified_contract = contract_module.verified_contract


router = APIRouter()
ROUTE_PATHS = (
    "/api/plugins/fluid-history/agents",
    "/api/plugins/fluid-history/runs",
    "/api/plugins/fluid-history/skills",
)
REQUIRED_SCOPE = "fluid:history"
MIN_SECRET_CHARS = 43

AGENT_JOB_NAME_PARTS = {
    "email-categorizer": ("fluid email categorizer",),
    "contractor-invoices": ("contractor invoice sync",),
    "dripjobs-operations": ("daily dripjobs",),
    "meta-ads-reporter": ("daily meta ads",),
}


def _fluid_secret() -> str:
    secret = os.environ.get("HERMES_FLUID_HISTORY_SECRET", "").strip()
    if secret:
        return secret
    try:
        from hermes_cli.config import get_env_value

        return str(get_env_value("HERMES_FLUID_HISTORY_SECRET") or "").strip()
    except (ImportError, OSError, TypeError, ValueError):
        return ""


class FluidHistoryTokenProvider(DashboardAuthProvider):
    name = "fluid-history"
    display_name = "Fluid history service"
    supports_token = True
    supports_session = False

    def verify_token(self, *, token: str) -> Optional[TokenPrincipal]:
        secret = _fluid_secret()
        if len(secret) < MIN_SECRET_CHARS or not hmac.compare_digest(secret, token):
            return None
        return TokenPrincipal(
            principal="fluid-ottawa-painters",
            provider=self.name,
            scopes=(REQUIRED_SCOPE,),
        )

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        raise NotImplementedError("Fluid history is a non-interactive service credential")

    def complete_login(
        self,
        *,
        code: str,
        state: str,
        code_verifier: str,
        redirect_uri: str,
    ) -> Session:
        raise NotImplementedError("Fluid history is a non-interactive service credential")

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        return None

    def refresh_session(self, *, refresh_token: str) -> Session:
        raise NotImplementedError("Fluid history is a non-interactive service credential")

    def revoke_session(self, *, refresh_token: str) -> None:
        return None


def _install_auth() -> None:
    for path in ROUTE_PATHS:
        register_token_route(path)
    if get_provider(FluidHistoryTokenProvider.name) is None:
        register_provider(FluidHistoryTokenProvider())


_install_auth()


def _iso(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat()
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _epoch(value: Any) -> Optional[float]:
    normalized = _iso(value)
    if normalized is None:
        return None
    return datetime.fromisoformat(normalized).timestamp()


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _safe_error(value: Any) -> Optional[str]:
    if not value:
        return None
    return " ".join(str(value).split())[:300]


def _agent_payload(job: Dict[str, Any]) -> Dict[str, Any]:
    latest = job.get("latest_execution")
    if not isinstance(latest, dict):
        latest = {}
    contract, contract_status = verified_contract(job)
    return {
        "id": str(job.get("id") or ""),
        "name": str(job.get("name") or job.get("id") or "Unnamed automation"),
        "profile": str(job.get("profile") or job.get("profile_name") or "default"),
        "schedule": str(job.get("schedule_display") or "Schedule unavailable"),
        "enabled": bool(job.get("enabled", True)),
        "state": str(job.get("state") or ("scheduled" if job.get("enabled", True) else "paused")),
        "nextRunAt": _iso(job.get("next_run_at")),
        "lastRunAt": _iso(latest.get("started_at") or latest.get("claimed_at")),
        "lastRunStatus": str(latest.get("status") or "") or None,
        "lastError": _safe_error(latest.get("error") or job.get("last_error")),
        "mode": "script" if bool(job.get("no_agent")) else "agent",
        "contract": contract,
        "contractStatus": contract_status,
    }


def _agents_payload() -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    agents = [
        _agent_payload(job)
        for job in ws._list_cron_jobs_sync("all")
        if str(job.get("id") or "")
    ]
    agents.sort(key=lambda agent: (not agent["enabled"], agent["name"].casefold()))
    return {"agents": agents, "fetchedAt": datetime.now(timezone.utc).isoformat()}


def _skills_payload() -> Dict[str, Any]:
    from hermes_cli import web_server as ws
    from hermes_cli.skills_config import get_disabled_skills
    from tools.skill_usage import (
        _read_bundled_manifest_names,
        _read_hub_installed_names,
        activity_count,
        load_usage,
    )
    from tools.skills_tool import _find_all_skills

    combined: Dict[str, Dict[str, Any]] = {}
    for profile_record in ws._cron_profile_dicts():
        profile = str(profile_record.get("name") or "")
        if not profile:
            continue
        with ws._profile_scope(profile):
            config = ws.load_config()
            disabled = get_disabled_skills(config)
            usage = load_usage()
            bundled_names = _read_bundled_manifest_names()
            hub_names = _read_hub_installed_names()
            for skill in _find_all_skills(skip_disabled=True):
                name = str(skill.get("name") or "").strip()
                if not name:
                    continue
                provenance = (
                    "hub" if name in hub_names
                    else "bundled" if name in bundled_names
                    else "custom"
                )
                entry = combined.setdefault(name, {
                    "id": name,
                    "name": name,
                    "description": str(skill.get("description") or "Hermes skill"),
                    "source": provenance,
                    "version": str(skill.get("version") or "") or None,
                    "enabled": False,
                    "profiles": [],
                    "usage": 0,
                    "usedBy": [],
                })
                entry["enabled"] = entry["enabled"] or name not in disabled
                entry["profiles"].append(profile)
                entry["usage"] += activity_count(usage.get(name, {}))

    for job in ws._list_cron_jobs_sync("all"):
        job_name = str(job.get("name") or job.get("id") or "Unnamed automation")
        for skill_name in job.get("skills") or []:
            entry = combined.get(str(skill_name))
            if entry is not None and job_name not in entry["usedBy"]:
                entry["usedBy"].append(job_name)

    skills = list(combined.values())
    for skill in skills:
        skill["profiles"].sort()
        skill["usedBy"].sort(key=str.casefold)
    skills.sort(key=lambda skill: (skill["id"] != "agent-creator", skill["name"].casefold()))
    return {"skills": skills, "fetchedAt": datetime.now(timezone.utc).isoformat()}


def _session_payload(session: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "sessionId": str(session.get("id") or "") or None,
        "model": str(session.get("model") or "") or None,
        "messageCount": _int_or_none(session.get("message_count")),
        "toolCallCount": _int_or_none(session.get("tool_call_count")),
    }


def _profile_executions(profile: str, job_id: str, limit: int) -> List[Dict[str, Any]]:
    from cron.executions import list_executions
    from hermes_cli import web_server as ws
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    _profile_name, home = ws._cron_profile_home(profile)
    token = set_hermes_home_override(str(home))
    try:
        return list_executions(job_id=job_id, limit=limit)
    finally:
        reset_hermes_home_override(token)


def _closest_session(
    execution: Dict[str, Any],
    sessions: List[Dict[str, Any]],
    used: set[int],
) -> Optional[Dict[str, Any]]:
    target = _epoch(execution.get("started_at") or execution.get("claimed_at"))
    if target is None:
        return None
    candidates = []
    for index, session in enumerate(sessions):
        if index in used:
            continue
        started = _epoch(session.get("started_at"))
        if started is None:
            continue
        delta = abs(started - target)
        if delta <= 240:
            candidates.append((delta, index, session))
    if not candidates:
        return None
    _delta, index, session = min(candidates, key=lambda item: item[0])
    used.add(index)
    return session


def _job_runs(job: Dict[str, Any], limit: int) -> List[Dict[str, Any]]:
    from hermes_cli import web_server as ws

    job_id = str(job.get("id") or "")
    job_name = str(job.get("name") or job_id)
    profile = str(job.get("profile") or job.get("profile_name") or "default")
    session_result = ws._list_cron_job_runs_sync(job_id, profile, limit)
    sessions = list(session_result.get("runs") or [])
    executions = _profile_executions(profile, job_id, limit)
    used_sessions: set[int] = set()
    rows: List[Dict[str, Any]] = []

    for execution in executions:
        session = _closest_session(execution, sessions, used_sessions)
        session_fields = _session_payload(session) if session is not None else {
            "sessionId": None,
            "model": None,
            "messageCount": None,
            "toolCallCount": None,
        }
        rows.append({
            "id": str(execution.get("id") or f"{job_id}:{execution.get('claimed_at', '')}"),
            "jobId": job_id,
            "jobName": job_name,
            "profile": profile,
            "status": str(execution.get("status") or "unknown"),
            "source": str(execution.get("source") or "cron"),
            "startedAt": _iso(execution.get("started_at") or execution.get("claimed_at")),
            "finishedAt": _iso(execution.get("finished_at")),
            "error": _safe_error(execution.get("error")),
            **session_fields,
        })

    for index, session in enumerate(sessions):
        if index in used_sessions:
            continue
        active = bool(session.get("is_active")) and session.get("ended_at") is None
        rows.append({
            "id": f"session:{session.get('id', index)}",
            "jobId": job_id,
            "jobName": job_name,
            "profile": profile,
            "status": "running" if active else "recorded",
            "source": "cron-session",
            "startedAt": _iso(session.get("started_at")),
            "finishedAt": _iso(session.get("ended_at")),
            "error": None,
            **_session_payload(session),
        })
    return rows


def _history_payload(agent_id: Optional[str], job_id: Optional[str], limit: int) -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    all_jobs = ws._list_cron_jobs_sync("all")
    if job_id is not None:
        jobs = [job for job in all_jobs if str(job.get("id") or "") == job_id]
        response_agent_id = job_id
    else:
        assert agent_id is not None
        name_parts = AGENT_JOB_NAME_PARTS[agent_id]
        jobs = [
            job for job in all_jobs
            if any(part in str(job.get("name") or "").casefold() for part in name_parts)
        ]
        response_agent_id = agent_id
    runs: List[Dict[str, Any]] = []
    for job in jobs:
        runs.extend(_job_runs(job, limit))
    runs.sort(key=lambda run: _epoch(run.get("startedAt")) or 0, reverse=True)
    return {
        "agentId": response_agent_id,
        "jobs": [
            {
                "id": str(job.get("id") or ""),
                "name": str(job.get("name") or job.get("id") or "Unnamed job"),
                "profile": str(job.get("profile") or job.get("profile_name") or "default"),
            }
            for job in jobs
        ],
        "runs": runs[:limit],
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/agents")
async def agents(request: Request) -> Dict[str, Any]:
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ())) if principal is not None else ()
    if REQUIRED_SCOPE not in scopes:
        raise HTTPException(status_code=403, detail="Missing fluid:history scope")
    return await run_in_threadpool(_agents_payload)


@router.get("/skills")
async def skills(request: Request) -> Dict[str, Any]:
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ())) if principal is not None else ()
    if REQUIRED_SCOPE not in scopes:
        raise HTTPException(status_code=403, detail="Missing fluid:history scope")
    return await run_in_threadpool(_skills_payload)


@router.get("/runs")
async def runs(
    request: Request,
    agent: Optional[str] = Query(None),
    job: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=50),
) -> Dict[str, Any]:
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ())) if principal is not None else ()
    if REQUIRED_SCOPE not in scopes:
        raise HTTPException(status_code=403, detail="Missing fluid:history scope")
    if (agent is None) == (job is None):
        raise HTTPException(status_code=400, detail="Provide exactly one of agent or job")
    if agent is not None and agent not in AGENT_JOB_NAME_PARTS:
        raise HTTPException(status_code=404, detail="Unknown Fluid agent")
    if job is not None and (not job or len(job) > 128 or not all(char.isalnum() or char in "-_" for char in job)):
        raise HTTPException(status_code=400, detail="Invalid Hermes job id")
    return await run_in_threadpool(_history_payload, agent, job, limit)
