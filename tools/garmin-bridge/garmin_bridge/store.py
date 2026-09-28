"""The two files the bridge keeps, both readable only by you.

- ``garmin-tokens.json`` — the session the Garmin library hands back after a
  login (``api.client.dumps()``). It is what lets the bridge fetch without
  asking for your password again, which also makes it worth protecting: whoever
  holds it can read your Garmin account until you sign out on Garmin's side.
- ``garmin-bridge-token`` — the pairing token the page must present.

Your password and e-mail address are never written anywhere.

Files are created 0600 inside a 0700 directory, written to a temporary file
and renamed into place, so a crash mid-write never leaves a half-written token.
"""

from __future__ import annotations

import os
import secrets
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path


def default_dir(env: Mapping[str, str] = os.environ) -> Path:
    if env.get("YOOTRI_GARMIN_HOME"):
        return Path(env["YOOTRI_GARMIN_HOME"])
    if env.get("XDG_CONFIG_HOME"):
        return Path(env["XDG_CONFIG_HOME"]) / "yootri"
    return Path(env.get("HOME") or Path.home()) / ".config" / "yootri"


class Store:
    def __init__(self, directory: Path | None = None) -> None:
        self.dir = Path(directory) if directory is not None else default_dir()
        self.tokens_path = self.dir / "garmin-tokens.json"
        self.pairing_path = self.dir / "garmin-bridge-token"

    def _ensure_dir(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o700)

    def _write_private(self, path: Path, text: str) -> None:
        self._ensure_dir()
        tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.replace(tmp, path)
        finally:
            if tmp.exists():
                tmp.unlink()
        os.chmod(path, 0o600)

    @staticmethod
    def _read(path: Path) -> str | None:
        try:
            return path.read_text(encoding="utf-8").strip() or None
        except FileNotFoundError:
            return None

    def read_tokens(self) -> str | None:
        return self._read(self.tokens_path)

    def write_tokens(self, tokens: str) -> None:
        self._write_private(self.tokens_path, tokens)

    def delete_tokens(self) -> bool:
        try:
            self.tokens_path.unlink()
        except FileNotFoundError:
            return False
        return True

    def tokens_saved_at(self) -> str | None:
        try:
            mtime = self.tokens_path.stat().st_mtime
        except FileNotFoundError:
            return None
        return datetime.fromtimestamp(mtime, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    def pairing_token(self, *, create: bool = True, rotate: bool = False) -> str | None:
        existing = None if rotate else self._read(self.pairing_path)
        if existing or not create:
            return existing
        token = secrets.token_urlsafe(32)
        self._write_private(self.pairing_path, token)
        return token
