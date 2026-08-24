"""Scoped, read-only Hermes history API for Fluid.

Mounted by Hermes at ``/api/plugins/fluid-history``. The response intentionally
contains run metadata only: no cron prompts, email bodies, invoice content, or
session messages leave Hermes.
"""
from __future__ import annotations

import hmac
import os
from datetime import datetime, timezone
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


router = APIRouter()
ROUTE_PATH = "/api/plugins/fluid-history/runs"
REQUIRED_SCOPE = "fluid:history"
MIN_SECRET_CHARS = 43

AGENT_JOB_NAME_PARTS = {
    "email-categorizer": ("fluid email categorizer",),
    "contractor-invoices": ("contractor invoice sync",),
    "dripjobs-operations": ("daily dripjobs",),
    "meta-ads-reporter": ("daily meta ads",),
}


class FluidHistoryTokenProvider(DashboardAuthProvider):
    name = "fluid-history"
    display_name = "Fluid history service"
    supports_token = True
    supports_session = False

    def __init__(self, secret: str) -> None:
        self._secret = secret

    def verify_token(self, *, token: str) -> Optional[TokenPrincipal]:
        if not hmac.compare_digest(self._secret, token):
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
    register_token_route(ROUTE_PATH)
    secret = os.environ.get("HERMES_FLUID_HISTORY_SECRET", "").strip()
    if len(secret) < MIN_SECRET_CHARS:
        return
    if get_provider(FluidHistoryTokenProvider.name) is None:
        register_provider(FluidHistoryTokenProvider(secret))


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


def _history_payload(agent_id: str, limit: int) -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    name_parts = AGENT_JOB_NAME_PARTS[agent_id]
    jobs = [
        job for job in ws._list_cron_jobs_sync("all")
        if any(part in str(job.get("name") or "").casefold() for part in name_parts)
    ]
    runs: List[Dict[str, Any]] = []
    for job in jobs:
        runs.extend(_job_runs(job, limit))
    runs.sort(key=lambda run: _epoch(run.get("startedAt")) or 0, reverse=True)
    return {
        "agentId": agent_id,
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


@router.get("/runs")
async def runs(
    request: Request,
    agent: str = Query(...),
    limit: int = Query(20, ge=1, le=50),
) -> Dict[str, Any]:
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ())) if principal is not None else ()
    if REQUIRED_SCOPE not in scopes:
        raise HTTPException(status_code=403, detail="Missing fluid:history scope")
    if agent not in AGENT_JOB_NAME_PARTS:
        raise HTTPException(status_code=404, detail="Unknown Fluid agent")
    return await run_in_threadpool(_history_payload, agent, limit)
