"""Hermes automation API for Fluid.

Mounted by Hermes at ``/api/plugins/fluid-history``. Fluid is a wrapper over
this Hermes deployment, so reads return the *complete* cron job and run records
rather than a hand-picked subset: whatever Hermes knows about a job, Fluid can
render. Values whose key looks like a credential are masked on the way out (see
``_SECRET_KEY_PARTS``), because prompts and job env can carry API keys.

Writes stay narrow on purpose: pause, resume, and delete for an exact cron job
id whose profile the caller already named correctly, plus removing a single
skill directory. Both require the manage scope, and the skill delete resolves
through symlinks and verifies containment before touching the filesystem — the
Nous-session-only /api/files endpoint is unreachable from Fluid, so this is the
only programmatic path.
"""
from __future__ import annotations

import hmac
import hashlib
import importlib.util
import base64
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
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
    _default_skill_roots = contract_module._default_skill_roots
    _find_skill_file = contract_module._find_skill_file
else:  # pragma: no cover - only taken when the package import above succeeds.
    from .agent_contracts import _default_skill_roots, _find_skill_file


router = APIRouter()
ROUTE_PATHS = (
    "/api/plugins/fluid-history/agents",
    "/api/plugins/fluid-history/activity",
    "/api/plugins/fluid-history/runs",
    "/api/plugins/fluid-history/skills",
    "/api/plugins/fluid-history/actions",
    "/api/plugins/fluid-history/jobs",
    "/api/plugins/fluid-history/profiles",
    "/api/plugins/fluid-history/sessions",
    "/api/plugins/fluid-history/introspect",
)
REQUIRED_SCOPE = "fluid:history"
MANAGE_SCOPE = "fluid:manage"
MIN_SECRET_CHARS = 43

AUTOMATION_KEY = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


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
            scopes=(REQUIRED_SCOPE, MANAGE_SCOPE),
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
    text = " ".join(str(value).split())
    text = re.sub(r"https?://\S+", "[url redacted]", text, flags=re.IGNORECASE)
    text = re.sub(
        r"(?i)\b(secret|token|password|api[_-]?key|authorization)\b\s*[:=]\s*\S+",
        r"\1=[redacted]",
        text,
    )
    return text[:300]


MAX_PROMPT_CHARS = 20_000
MAX_JSON_DEPTH = 8
REDACTED = "«redacted»"

# Substring match against the key so secret-shaped names are caught without
# needing an exhaustive list.
_SECRET_KEY_PARTS = (
    "secret", "token", "password", "passwd", "credential",
    "api_key", "apikey", "private_key", "authorization", "auth_header",
)


def _is_secret_key(key: Any) -> bool:
    text = str(key).casefold()
    return any(part in text for part in _SECRET_KEY_PARTS)


def _jsonable(value: Any, depth: int = 0) -> Any:
    """Coerce an arbitrary Hermes record into something FastAPI can encode.

    Hermes job dicts are plain data today, but they are not part of a contract
    we control, so anything exotic degrades to its string form rather than
    500-ing the whole roster.
    """
    if depth >= MAX_JSON_DEPTH:
        return REDACTED if isinstance(value, (dict, list, tuple, set)) else _jsonable(value, MAX_JSON_DEPTH - 1)
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {
            str(key): (REDACTED if _is_secret_key(key) else _jsonable(item, depth + 1))
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(item, depth + 1) for item in value]
    if isinstance(value, datetime):
        return _iso(value)
    return str(value)


def _full_job_payload(job: Dict[str, Any]) -> Dict[str, Any]:
    """Every field Hermes reports for a cron job, secrets masked."""
    record = _jsonable(job)
    if isinstance(record, dict):
        prompt = record.get("prompt")
        if isinstance(prompt, str) and len(prompt) > MAX_PROMPT_CHARS:
            record["prompt"] = prompt[:MAX_PROMPT_CHARS]
            record["promptTruncated"] = True
    return record


def _definition_payload(job: Dict[str, Any], contract: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The operator-authored definition Fluid renders on the agent detail page.

    Everything here is already hashed into the presentation contract, so it is
    the same material Fluid claims the agent runs on — just readable.
    """
    prompt = str(job.get("prompt") or "")
    return {
        "prompt": prompt[:MAX_PROMPT_CHARS] or None,
        "promptTruncated": len(prompt) > MAX_PROMPT_CHARS,
        "skills": sorted({
            text for value in (job.get("skills") or [])
            if (text := " ".join(str(value or "").split()))
        }),
        "script": " ".join(str(job.get("script") or "").split()) or None,
        "workdir": " ".join(str(job.get("workdir") or "").split()) or None,
        "model": " ".join(str(job.get("model") or "").split()) or None,
        "timeoutSeconds": _int_or_none(job.get("timeout") or job.get("timeout_seconds")),
        "definitionHash": str(contract.get("definitionHash") or "") or None if contract else None,
    }


def _agent_payload(job: Dict[str, Any], duplicate_keys: Optional[set[str]] = None) -> Dict[str, Any]:
    latest = job.get("latest_execution")
    if not isinstance(latest, dict):
        latest = {}
    contract, contract_status = verified_contract(job)
    if (
        contract is not None
        and duplicate_keys is not None
        and str(contract.get("automationKey") or "") in duplicate_keys
    ):
        contract = None
        contract_status = "duplicate-automation-key"
    return {
        "definition": _definition_payload(job, contract),
        # The complete record, for anything the curated fields below omit.
        "raw": _full_job_payload(job),
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

    jobs = [job for job in ws._list_cron_jobs_sync("all") if str(job.get("id") or "")]
    key_counts: Dict[str, int] = {}
    for job in jobs:
        contract, status = verified_contract(job)
        if contract is not None and status == "verified":
            key = str(contract.get("automationKey") or "")
            key_counts[key] = key_counts.get(key, 0) + 1
    duplicate_keys = {key for key, count in key_counts.items() if count > 1}
    agents = [
        _agent_payload(job, duplicate_keys)
        for job in jobs
    ]
    agents.sort(key=lambda agent: (not agent["enabled"], agent["name"].casefold()))
    return {"agents": agents, "fetchedAt": datetime.now(timezone.utc).isoformat()}


class AgentAction(BaseModel):
    action: str
    jobId: str
    profile: str = "default"


def _validate_job_ref(job_id: str, profile: str) -> tuple[str, str]:
    if not job_id or len(job_id) > 128 or not all(char.isalnum() or char in "-_" for char in job_id):
        raise HTTPException(status_code=400, detail="Invalid Hermes job id")
    if not profile or len(profile) > 64 or not all(char.isalnum() or char in "-_" for char in profile):
        raise HTTPException(status_code=400, detail="Invalid Hermes profile")
    return job_id, profile


def _apply_agent_action(body: AgentAction) -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    job_id, profile = _validate_job_ref(body.jobId, body.profile)
    matching = [
        job for job in ws._list_cron_jobs_sync("all")
        if str(job.get("id") or "") == job_id
    ]
    if len(matching) != 1:
        raise HTTPException(status_code=404, detail="Hermes job not found")
    actual_profile = str(matching[0].get("profile") or matching[0].get("profile_name") or "default")
    if not hmac.compare_digest(actual_profile, profile):
        raise HTTPException(status_code=409, detail="Hermes job profile changed; refresh and retry")

    if body.action == "pause":
        result = ws._pause_cron_job_sync(job_id, profile)
    elif body.action == "resume":
        result = ws._resume_cron_job_sync(job_id, profile)
    elif body.action == "delete":
        result = ws._delete_cron_job_sync(job_id, profile)
    else:
        raise HTTPException(status_code=400, detail="Action must be pause, resume, or delete")
    return {
        "ok": True,
        "action": body.action,
        "jobId": job_id,
        "profile": profile,
        "result": result,
        "changedAt": datetime.now(timezone.utc).isoformat(),
    }


MAX_SKILL_CHARS = 40_000


def _skill_instructions(name: str, skill: Dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    """The SKILL.md body, so Fluid can show what a skill actually tells an agent."""
    raw_path = skill.get("path") or skill.get("file") or skill.get("source_path")
    candidate = Path(str(raw_path)) if raw_path else None
    if candidate is not None and candidate.is_dir():
        candidate = candidate / "SKILL.md"
    if candidate is None or not candidate.is_file():
        candidate = _find_skill_file(name, _all_skill_roots())
    if candidate is None:
        return None, None
    try:
        text = candidate.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None, str(candidate)
    return text[:MAX_SKILL_CHARS], str(candidate)


SKILL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _all_skill_roots() -> List[Path]:
    """Default roots plus each cron profile's own skills directory.

    Skills are discovered per profile, so a skill can live under a profile home
    that the contract module's default roots never look at. Deleting from the
    defaults alone leaves those copies behind, still listed and unusable.
    """
    roots = list(_default_skill_roots())
    try:
        from hermes_cli import web_server as ws

        for record in ws._cron_profile_dicts():
            profile = str(record.get("name") or "")
            if not profile:
                continue
            try:
                _name, home = ws._cron_profile_home(profile)
            except Exception:  # noqa: BLE001 - a bad profile must not break the roster
                continue
            roots.append(Path(str(home)) / "skills")
    except Exception:  # noqa: BLE001 - fall back to the defaults
        pass
    seen: Dict[str, Path] = {}
    for root in roots:
        seen.setdefault(str(root), root)
    return list(seen.values())


def _resolve_skill_dir(name: str) -> Path:
    """Locate a skill's own directory, refusing anything outside a skill root.

    Every check here exists because this function feeds an rmtree: the name is
    pattern-matched, the path is resolved through symlinks, containment is
    verified against the configured roots, and a root itself is never a target.
    """
    if SKILL_NAME.fullmatch(name) is None:
        raise HTTPException(status_code=400, detail="Invalid skill name")

    search_roots = _all_skill_roots()
    skill_file = _find_skill_file(name, search_roots)
    if skill_file is None:
        raise HTTPException(status_code=404, detail="Skill not found")

    try:
        target = skill_file.resolve(strict=True).parent
        roots = [root.resolve() for root in search_roots if root.is_dir()]
    except OSError as error:
        raise HTTPException(status_code=500, detail="Could not resolve skill path") from error

    if target.name != name:
        raise HTTPException(status_code=409, detail="Skill directory name does not match the skill")
    if not (target / "SKILL.md").is_file():
        raise HTTPException(status_code=409, detail="Refusing to remove a directory with no SKILL.md")
    if any(target == root for root in roots):
        raise HTTPException(status_code=409, detail="Refusing to remove a skill root")
    if not any(root in target.parents for root in roots):
        raise HTTPException(status_code=403, detail="Skill lives outside the configured skill roots")
    return target


def _attached_jobs(name: str) -> List[str]:
    from hermes_cli import web_server as ws

    return [
        str(job.get("name") or job.get("id") or "unnamed job")
        for job in ws._list_cron_jobs_sync("all")
        if any(_compact(value) == name for value in (job.get("skills") or []))
    ]


def _compact(value: Any) -> str:
    return " ".join(str(value or "").split())


def _delete_skill(name: str, force: bool) -> Dict[str, Any]:
    target = _resolve_skill_dir(name)
    attached = _attached_jobs(name)
    if attached and not force:
        raise HTTPException(
            status_code=409,
            detail=f"Skill is attached to {', '.join(attached)}. Pass force=true to remove it anyway.",
        )
    try:
        removed = sorted(str(path.relative_to(target)) for path in target.rglob("*") if path.is_file())
        shutil.rmtree(target)
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Could not remove skill: {error}") from error
    return {
        "ok": True,
        "skill": name,
        "path": str(target),
        "filesRemoved": removed,
        "wasAttachedTo": attached,
        "removedAt": datetime.now(timezone.utc).isoformat(),
    }


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
                instructions, instructions_path = _skill_instructions(name, skill)
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
                    "instructions": instructions,
                    "instructionsPath": instructions_path,
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
    skills.sort(key=lambda skill: (skill["id"] != "automation-creator", skill["name"].casefold()))
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


def _exact_session(job_id: str, profile: str, session_id: str) -> Optional[Dict[str, Any]]:
    """Read only the explicitly correlated Hermes session.

    The durable execution ledger does not currently store a session foreign
    key. Fluid therefore refuses timestamp-nearest joins. The app supplies an
    exact session captured by the worker runtime when one exists.
    """
    from hermes_cli import web_server as ws

    result = ws._list_cron_job_runs_sync(job_id, profile, 1000)
    matches = [
        session for session in (result.get("runs") or [])
        if str(session.get("id") or "") == session_id
    ]
    return matches[0] if len(matches) == 1 else None


def _job_runs(job: Dict[str, Any], limit: int) -> List[Dict[str, Any]]:
    job_id = str(job.get("id") or "")
    job_name = str(job.get("name") or job_id)
    profile = str(job.get("profile") or job.get("profile_name") or "default")
    contract, contract_status = verified_contract(job)
    automation_key = str(contract.get("automationKey") or "") if contract is not None else None
    executions = _profile_executions(profile, job_id, limit)
    rows: List[Dict[str, Any]] = []

    for execution in executions:
        session_fields = {
            "sessionId": None,
            "model": str(job.get("model") or "") or None,
            "messageCount": None,
            "toolCallCount": None,
        }
        fallback_identity = hashlib.sha256(
            f"{profile}\0{job_id}\0{execution.get('claimed_at', '')}".encode("utf-8")
        ).hexdigest()[:32]
        rows.append({
            "id": str(execution.get("id") or f"legacy-{fallback_identity}"),
            "jobId": job_id,
            "jobName": job_name,
            "automationKey": automation_key,
            "automationName": contract.get("displayName") if contract is not None else None,
            "automationMode": "script" if bool(job.get("no_agent")) else "agent",
            "contractStatus": contract_status,
            "profile": profile,
            "status": str(execution.get("status") or "unknown"),
            "source": str(execution.get("source") or "cron"),
            "attempt": _int_or_none(execution.get("attempt") or execution.get("attempts")),
            "startedAt": _iso(execution.get("started_at") or execution.get("claimed_at")),
            "finishedAt": _iso(execution.get("finished_at")),
            "error": _safe_error(execution.get("error")),
            **session_fields,
        })
    return rows


def _history_payload(automation_key: Optional[str], job_id: Optional[str], limit: int) -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    all_jobs = ws._list_cron_jobs_sync("all")
    if job_id is not None:
        jobs = [job for job in all_jobs if str(job.get("id") or "") == job_id]
        response_agent_id = job_id
    else:
        assert automation_key is not None
        jobs = []
        for job in all_jobs:
            contract, status = verified_contract(job)
            if (
                contract is not None
                and status == "verified"
                and contract.get("automationKey") == automation_key
            ):
                jobs.append(job)
        if len(jobs) > 1:
            raise HTTPException(status_code=409, detail="Duplicate automation key")
        response_agent_id = automation_key
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


def _registered_jobs() -> List[Dict[str, Any]]:
    from hermes_cli import web_server as ws

    jobs: List[Dict[str, Any]] = []
    keys: Dict[str, int] = {}
    invalid: List[str] = []
    for job in ws._list_cron_jobs_sync("all"):
        contract, status = verified_contract(job)
        if contract is None or status != "verified":
            invalid.append(
                f"{str(job.get('id') or 'unknown')} ({status})"
            )
            continue
        key = str(contract.get("automationKey") or "")
        keys[key] = keys.get(key, 0) + 1
        jobs.append(job)
    duplicates = sorted(key for key, count in keys.items() if count > 1)
    if duplicates:
        raise HTTPException(
            status_code=409,
            detail=f"Duplicate verified automation keys: {', '.join(duplicates)}",
        )
    if invalid:
        raise HTTPException(
            status_code=409,
            detail=(
                "Hermes jobs need verified Fluid automation contracts: "
                + ", ".join(sorted(invalid))
            ),
        )
    return jobs


def _activity_cursor(row: Dict[str, Any]) -> str:
    raw = json.dumps({
        "at": row.get("startedAt"),
        "id": row.get("id"),
    }, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_activity_cursor(value: Optional[str]) -> Optional[tuple[float, str]]:
    if value is None:
        return None
    try:
        padding = "=" * ((4 - len(value) % 4) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(value + padding).decode("utf-8"))
        at = _epoch(decoded.get("at")) if isinstance(decoded, dict) else None
        row_id = str(decoded.get("id") or "") if isinstance(decoded, dict) else ""
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return (at, row_id) if at is not None and row_id else None


def _activity_payload(
    limit: int,
    cursor: Optional[str],
    mode: Optional[str],
    status: Optional[str],
    automation_key: Optional[str],
    job_id: Optional[str],
    execution_id: Optional[str],
    session_id: Optional[str],
) -> Dict[str, Any]:
    cursor_value = _decode_activity_cursor(cursor)
    if cursor is not None and cursor_value is None:
        raise HTTPException(status_code=400, detail="Invalid Activity cursor")
    jobs = _registered_jobs()
    if job_id is not None:
        jobs = [job for job in jobs if str(job.get("id") or "") == job_id]
    if automation_key is not None:
        jobs = [
            job for job in jobs
            if (verified_contract(job)[0] or {}).get("automationKey") == automation_key
        ]

    rows: List[Dict[str, Any]] = []
    fetch_limit = 1000
    for job in jobs:
        rows.extend(_job_runs(job, fetch_limit))
    if mode is not None:
        rows = [row for row in rows if row.get("automationMode") == mode]
    if status is not None:
        rows = [row for row in rows if row.get("status") == status]
    if execution_id is not None:
        rows = [row for row in rows if str(row.get("id") or "") == execution_id]
    if session_id is not None:
        if execution_id is None:
            raise HTTPException(
                status_code=400,
                detail="A session reference requires an exact execution reference",
            )
        for row in rows:
            exact = _exact_session(
                str(row.get("jobId") or ""),
                str(row.get("profile") or "default"),
                session_id,
            )
            row.update(_session_payload(exact) if exact is not None else {
                "sessionId": session_id,
                "messageCount": None,
                "toolCallCount": None,
            })

    rows.sort(
        key=lambda row: (_epoch(row.get("startedAt")) or 0, str(row.get("id") or "")),
        reverse=True,
    )
    if cursor_value is not None:
        rows = [
            row for row in rows
            if (_epoch(row.get("startedAt")) or 0, str(row.get("id") or "")) < cursor_value
        ]
    page = rows[:limit]
    return {
        "executions": page,
        "nextCursor": _activity_cursor(page[-1]) if len(rows) > limit and page else None,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


def _jobs_payload(job_id: Optional[str]) -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    jobs = [
        _full_job_payload(job)
        for job in ws._list_cron_jobs_sync("all")
        if job_id is None or str(job.get("id") or "") == job_id
    ]
    if job_id is not None and not jobs:
        raise HTTPException(status_code=404, detail="Hermes job not found")
    return {"jobs": jobs, "fetchedAt": datetime.now(timezone.utc).isoformat()}


def _profiles_payload() -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    return {
        "profiles": [_jsonable(record) for record in ws._cron_profile_dicts()],
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


# Hermes does not promise a stable session-transcript helper, so try the known
# spellings in order and report what was attempted when none exist. /introspect
# lists what this particular deployment actually has.
_TRANSCRIPT_ACCESSORS = (
    "_get_session_messages_sync",
    "_list_session_messages_sync",
    "_session_messages_sync",
    "_get_session_sync",
)


def _transcript_payload(session_id: str, profile: str, limit: int) -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    for name in _TRANSCRIPT_ACCESSORS:
        accessor = getattr(ws, name, None)
        if accessor is None:
            continue
        with ws._profile_scope(profile):
            result = accessor(session_id)
        messages = result.get("messages") if isinstance(result, dict) else result
        return {
            "sessionId": session_id,
            "profile": profile,
            "source": f"web_server.{name}",
            "messages": _jsonable(messages)[:limit] if isinstance(messages, list) else _jsonable(messages),
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }
    raise HTTPException(
        status_code=501,
        detail=(
            "No session transcript helper on this Hermes build. Tried: "
            + ", ".join(_TRANSCRIPT_ACCESSORS)
            + ". Call /introspect to see what is available."
        ),
    )


def _introspect_payload() -> Dict[str, Any]:
    """What this Hermes build exposes, so the wrapper can be written to fit it."""
    from hermes_cli import web_server as ws

    jobs = ws._list_cron_jobs_sync("all")
    sample_keys = sorted({key for job in jobs for key in job})
    return {
        "webServerHelpers": sorted(
            name for name in dir(ws)
            if any(part in name for part in ("cron", "session", "profile", "job", "run"))
        ),
        "jobKeys": sample_keys,
        "jobCount": len(jobs),
        "transcriptAccessorsTried": list(_TRANSCRIPT_ACCESSORS),
        "transcriptAccessorsPresent": [
            name for name in _TRANSCRIPT_ACCESSORS if getattr(ws, name, None) is not None
        ],
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


def _require_scope(request: Request, scope: str) -> None:
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ())) if principal is not None else ()
    if scope not in scopes:
        raise HTTPException(status_code=403, detail=f"Missing {scope} scope")


@router.get("/jobs")
async def jobs(
    request: Request,
    job: Optional[str] = Query(None),
) -> Dict[str, Any]:
    _require_scope(request, REQUIRED_SCOPE)
    if job is not None and (
        not job or len(job) > 128 or not all(char.isalnum() or char in "-_" for char in job)
    ):
        raise HTTPException(status_code=400, detail="Invalid Hermes job id")
    return await run_in_threadpool(_jobs_payload, job)


@router.get("/profiles")
async def profiles(request: Request) -> Dict[str, Any]:
    _require_scope(request, REQUIRED_SCOPE)
    return await run_in_threadpool(_profiles_payload)


@router.get("/sessions")
async def sessions(
    request: Request,
    session: str = Query(..., min_length=1, max_length=128),
    profile: str = Query("default", min_length=1, max_length=64),
    limit: int = Query(200, ge=1, le=1000),
) -> Dict[str, Any]:
    _require_scope(request, REQUIRED_SCOPE)
    if not all(char.isalnum() or char in "-_" for char in session):
        raise HTTPException(status_code=400, detail="Invalid Hermes session id")
    if not all(char.isalnum() or char in "-_" for char in profile):
        raise HTTPException(status_code=400, detail="Invalid Hermes profile")
    return await run_in_threadpool(_transcript_payload, session, profile, limit)


@router.get("/introspect")
async def introspect(request: Request) -> Dict[str, Any]:
    _require_scope(request, REQUIRED_SCOPE)
    return await run_in_threadpool(_introspect_payload)


@router.get("/agents")
async def agents(request: Request) -> Dict[str, Any]:
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ())) if principal is not None else ()
    if REQUIRED_SCOPE not in scopes:
        raise HTTPException(status_code=403, detail="Missing fluid:history scope")
    return await run_in_threadpool(_agents_payload)


@router.get("/activity")
async def activity(
    request: Request,
    limit: int = Query(30, ge=1, le=200),
    cursor: Optional[str] = Query(None, max_length=1024),
    mode: Optional[str] = Query(None),
    status: Optional[str] = Query(None, max_length=32),
    automation: Optional[str] = Query(None, max_length=80),
    job: Optional[str] = Query(None, max_length=128),
    execution: Optional[str] = Query(None, max_length=256),
    session: Optional[str] = Query(None, max_length=128),
) -> Dict[str, Any]:
    _require_scope(request, REQUIRED_SCOPE)
    if mode is not None and mode not in ("agent", "script"):
        raise HTTPException(status_code=400, detail="Invalid automation mode")
    if automation is not None and AUTOMATION_KEY.fullmatch(automation) is None:
        raise HTTPException(status_code=400, detail="Invalid automation key")
    for value, label, maximum in (
        (job, "job", 128), (execution, "execution", 256), (session, "session", 128)
    ):
        if value is not None and (len(value) > maximum or not all(char.isalnum() or char in "-_.:" for char in value)):
            raise HTTPException(status_code=400, detail=f"Invalid Hermes {label} reference")
    return await run_in_threadpool(
        _activity_payload, limit, cursor, mode, status, automation, job, execution, session
    )


@router.get("/skills")
async def skills(request: Request) -> Dict[str, Any]:
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ())) if principal is not None else ()
    if REQUIRED_SCOPE not in scopes:
        raise HTTPException(status_code=403, detail="Missing fluid:history scope")
    return await run_in_threadpool(_skills_payload)


@router.delete("/skills")
async def delete_skill(
    request: Request,
    name: str = Query(..., min_length=1, max_length=128),
    force: bool = Query(False),
) -> Dict[str, Any]:
    """Remove one skill directory. Manage scope only; see _resolve_skill_dir."""
    _require_scope(request, MANAGE_SCOPE)
    return await run_in_threadpool(_delete_skill, name, force)


@router.get("/runs")
async def runs(
    request: Request,
    agent: Optional[str] = Query(None),
    job: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=200),
) -> Dict[str, Any]:
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ())) if principal is not None else ()
    if REQUIRED_SCOPE not in scopes:
        raise HTTPException(status_code=403, detail="Missing fluid:history scope")
    if (agent is None) == (job is None):
        raise HTTPException(status_code=400, detail="Provide exactly one of agent or job")
    if agent is not None and (len(agent) > 80 or AUTOMATION_KEY.fullmatch(agent) is None):
        raise HTTPException(status_code=400, detail="Invalid automation key")
    if job is not None and (not job or len(job) > 128 or not all(char.isalnum() or char in "-_" for char in job)):
        raise HTTPException(status_code=400, detail="Invalid Hermes job id")
    payload = await run_in_threadpool(_history_payload, agent, job, limit)
    if agent is not None and not payload["jobs"]:
        raise HTTPException(status_code=404, detail="Unknown or unverified Fluid automation")
    return payload


@router.post("/actions")
async def actions(request: Request, body: AgentAction) -> Dict[str, Any]:
    principal = getattr(request.state, "token_principal", None)
    scopes = tuple(getattr(principal, "scopes", ())) if principal is not None else ()
    if MANAGE_SCOPE not in scopes:
        raise HTTPException(status_code=403, detail="Missing fluid:manage scope")
    return await run_in_threadpool(_apply_agent_action, body)
