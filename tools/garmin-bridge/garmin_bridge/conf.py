"""`yootri.conf`: the bridge's switches, in one file next to the Garmin session.

Workout export and overnight figures used to reach a running agent only if the
shell had them set when it was installed. They can now live in
`~/.config/yootri/yootri.conf` (the same directory as the session), one
`KEY=VALUE` per line, and take effect the next time the bridge starts — no
reinstall. The shell still wins when it sets one. Only the keys below are read;
the file holds no secret, and anything else in it is ignored.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

CONF_NAME = "yootri.conf"
KEYS = ("YOOTRI_GARMIN_WORKOUTS", "YOOTRI_GARMIN_OVERNIGHT")


def read_conf(directory: Path) -> dict[str, str]:
    try:
        text = (Path(directory) / CONF_NAME).read_text(encoding="utf-8")
    except OSError:
        return {}
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip("\"'")
        if key in KEYS:
            out[key] = value
    return out


def with_conf(env: Mapping[str, str], directory: Path) -> dict[str, str]:
    """The conf's values under the environment's: whoever set it in the shell decided."""
    return {**read_conf(directory), **env}
