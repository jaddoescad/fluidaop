"""Versioned, definition-bound presentation contracts for Hermes cron jobs."""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


SCHEMA_VERSION = 1
MAX_CONTRACT_BYTES = 32_768
MAX_DISPLAY_NAME_CHARS = 80
MAX_SUMMARY_CHARS = 180
MAX_STEPS = 4
MAX_STEP_CHARS = 160
SAFE_ID = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")


def _compact_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _default_skill_roots() -> List[Path]:
    configured = os.environ.get("FLUID_AGENT_SKILL_ROOTS", "").strip()
    roots = [Path(part) for part in configured.split(os.pathsep) if part] if configured else [
        Path("/opt/data/skills"),
        Path("/opt/hermes/skills"),
    ]
    return roots


def _find_skill_file(skill_name: str, roots: Iterable[Path]) -> Optional[Path]:
    if SAFE_ID.fullmatch(skill_name) is None:
        return None
    matches: List[Path] = []
    for root in roots:
        if not root.is_dir():
            continue
        direct = root / skill_name / "SKILL.md"
        if direct.is_file():
            matches.append(direct)
        matches.extend(path for path in root.glob(f"**/{skill_name}/SKILL.md") if path.is_file())
    if not matches:
        return None
    return sorted(set(matches), key=lambda path: (len(path.parts), str(path)))[0]


def _resolve_script_file(job: Dict[str, Any]) -> Optional[Path]:
    raw = _compact_text(job.get("script"))
    if not raw:
        return None
    script = Path(raw)
    if script.is_absolute():
        return script
    workdir = Path(_compact_text(job.get("workdir")) or "/opt/data")
    candidates = (
        workdir / script,
        Path("/opt/data") / script,
        Path("/opt/data/scripts") / script,
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return candidates[0]


def definition_snapshot(
    job: Dict[str, Any],
    *,
    skill_roots: Optional[Iterable[Path]] = None,
) -> Tuple[Dict[str, Any], List[str]]:
    """Return the safe fingerprint input and any definition sources we could not read."""
    roots = list(skill_roots) if skill_roots is not None else _default_skill_roots()
    missing: List[str] = []
    skill_rows: List[Dict[str, str]] = []
    skill_names = sorted({
        _compact_text(value)
        for value in (job.get("skills") or [])
        if _compact_text(value)
    })
    for skill_name in skill_names:
        skill_path = _find_skill_file(skill_name, roots)
        if skill_path is None:
            missing.append(f"skill:{skill_name}")
            continue
        try:
            content_hash = _sha256_bytes(skill_path.read_bytes())
        except OSError:
            missing.append(f"skill:{skill_name}")
            continue
        skill_rows.append({"name": skill_name, "sha256": content_hash})

    script_row: Optional[Dict[str, str]] = None
    script_path = _resolve_script_file(job)
    if script_path is not None:
        try:
            script_row = {
                "name": _compact_text(job.get("script")),
                "sha256": _sha256_bytes(script_path.read_bytes()),
            }
        except OSError:
            missing.append(f"script:{_compact_text(job.get('script'))}")

    snapshot = {
        "prompt": str(job.get("prompt") or ""),
        "skills": skill_rows,
        "script": script_row,
        "noAgent": bool(job.get("no_agent")),
    }
    return snapshot, missing


def definition_hash(
    job: Dict[str, Any],
    *,
    skill_roots: Optional[Iterable[Path]] = None,
) -> Tuple[str, List[str]]:
    snapshot, missing = definition_snapshot(job, skill_roots=skill_roots)
    canonical = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return f"sha256:{_sha256_bytes(canonical.encode('utf-8'))}", missing


def _validated_text(value: Any, *, field: str, maximum: int) -> str:
    text = _compact_text(value)
    if not text:
        raise ValueError(f"{field} is required")
    if len(text) > maximum:
        raise ValueError(f"{field} exceeds {maximum} characters")
    return text


def build_contract(
    job: Dict[str, Any],
    *,
    display_name: str,
    summary: str,
    steps: Iterable[str],
    icon: Optional[str] = None,
    skill_roots: Optional[Iterable[Path]] = None,
) -> Dict[str, Any]:
    job_id = _compact_text(job.get("id"))
    if SAFE_ID.fullmatch(job_id) is None:
        raise ValueError("job id is invalid")
    normalized_steps = [
        _validated_text(step, field="step", maximum=MAX_STEP_CHARS)
        for step in steps
    ]
    if len(normalized_steps) > MAX_STEPS:
        raise ValueError(f"steps exceeds {MAX_STEPS} entries")
    fingerprint, missing = definition_hash(job, skill_roots=skill_roots)
    if missing:
        raise ValueError(f"definition sources unavailable: {', '.join(missing)}")
    contract: Dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "jobId": job_id,
        "displayName": _validated_text(
            display_name,
            field="displayName",
            maximum=MAX_DISPLAY_NAME_CHARS,
        ),
        "summary": _validated_text(summary, field="summary", maximum=MAX_SUMMARY_CHARS),
        "steps": normalized_steps,
        "definitionHash": fingerprint,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    if icon is not None and _compact_text(icon):
        contract["icon"] = _validated_text(icon, field="icon", maximum=8)
    return contract


def contract_directory() -> Path:
    return Path(os.environ.get("FLUID_AGENT_CONTRACT_DIR", "/opt/data/fluid-agent-contracts"))


def contract_path(job_id: str) -> Path:
    if SAFE_ID.fullmatch(job_id) is None:
        raise ValueError("job id is invalid")
    return contract_directory() / f"{job_id}.json"


def write_contract(contract: Dict[str, Any]) -> Path:
    job_id = _compact_text(contract.get("jobId"))
    target = contract_path(job_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(contract, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if len(encoded) > MAX_CONTRACT_BYTES:
        raise ValueError("contract is too large")
    temporary = target.with_suffix(".json.tmp")
    temporary.write_bytes(encoded)
    os.chmod(temporary, 0o600)
    temporary.replace(target)
    return target


def _read_contract(job_id: str) -> Optional[Dict[str, Any]]:
    try:
        target = contract_path(job_id)
        if not target.is_file() or target.stat().st_size > MAX_CONTRACT_BYTES:
            return None
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def verified_contract(
    job: Dict[str, Any],
    *,
    skill_roots: Optional[Iterable[Path]] = None,
) -> Tuple[Optional[Dict[str, Any]], str]:
    job_id = _compact_text(job.get("id"))
    if SAFE_ID.fullmatch(job_id) is None:
        return None, "invalid-job"
    contract = _read_contract(job_id)
    if contract is None:
        return None, "missing"
    try:
        if contract.get("schemaVersion") != SCHEMA_VERSION or contract.get("jobId") != job_id:
            return None, "invalid"
        _validated_text(contract.get("displayName"), field="displayName", maximum=MAX_DISPLAY_NAME_CHARS)
        _validated_text(contract.get("summary"), field="summary", maximum=MAX_SUMMARY_CHARS)
        steps = contract.get("steps")
        if not isinstance(steps, list) or len(steps) > MAX_STEPS:
            return None, "invalid"
        for step in steps:
            _validated_text(step, field="step", maximum=MAX_STEP_CHARS)
        current_hash, missing = definition_hash(job, skill_roots=skill_roots)
        if missing:
            return None, "source-unavailable"
        if contract.get("definitionHash") != current_hash:
            return None, "stale"
    except (TypeError, ValueError):
        return None, "invalid"
    return {
        "schemaVersion": SCHEMA_VERSION,
        "displayName": contract["displayName"],
        "summary": contract["summary"],
        "steps": contract["steps"],
        "icon": contract.get("icon") if isinstance(contract.get("icon"), str) else None,
        "definitionHash": contract["definitionHash"],
        "createdAt": contract.get("createdAt") if isinstance(contract.get("createdAt"), str) else None,
    }, "verified"
