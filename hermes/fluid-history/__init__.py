"""Fluid history plugin hooks, including its scoped service credential."""
from __future__ import annotations

import hmac
import os
from typing import Optional

from hermes_cli.dashboard_auth import (
    DashboardAuthProvider,
    LoginStart,
    Session,
    TokenPrincipal,
)


MIN_SECRET_CHARS = 43


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
            scopes=("fluid:history",),
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


def register(ctx) -> None:
    """Register token auth through Hermes' supported plugin lifecycle."""
    ctx.register_dashboard_auth_provider(FluidHistoryTokenProvider())
