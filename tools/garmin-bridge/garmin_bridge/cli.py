"""Command line: sign in once, then run the bridge while you sync.

    python -m garmin_bridge login     sign in to Garmin (password + code, once)
    python -m garmin_bridge serve     run the bridge on 127.0.0.1:8765
    python -m garmin_bridge status    is there a saved session?
    python -m garmin_bridge logout    forget the saved session
    python -m garmin_bridge pair      print (or --rotate) the pairing token

The Makefile wraps these as `make garmin-login`, `make garmin` and friends.
"""

from __future__ import annotations

import argparse
import getpass
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, TextIO

from garmin_bridge import __version__
from garmin_bridge.auth import ApiFactory, login, open_api, quiet_library
from garmin_bridge.client import GarminClient
from garmin_bridge.errors import BridgeError, RateLimited
from garmin_bridge.server import DEFAULT_PORT, Config, make_server
from garmin_bridge.store import Store

LOCAL_DEV_ORIGIN = "http://localhost:8000"

# tools/garmin-bridge/garmin_bridge/cli.py → the repo root holds CNAME.
REPO_CNAME = Path(__file__).resolve().parents[3] / "CNAME"


def default_origins(cname: Path = REPO_CNAME) -> tuple[str, ...]:
    """`make dev`'s origin, plus the published site named in the repo's CNAME."""
    try:
        host = cname.read_text(encoding="utf-8").strip()
    except OSError:
        host = ""
    return (LOCAL_DEV_ORIGIN, f"https://{host}") if host else (LOCAL_DEV_ORIGIN,)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="garmin_bridge", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("login", help="sign in to Garmin and save the session")
    sub.add_parser("logout", help="forget the saved Garmin session")
    sub.add_parser("status", help="say whether a Garmin session is saved")
    serve = sub.add_parser("serve", help="run the bridge")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.add_argument("--allow-origin", action="append", default=[], metavar="URL",
                       help="another page allowed to use the bridge (repeatable)")
    pair = sub.add_parser("pair", help="print the pairing token")
    pair.add_argument("--rotate", action="store_true", help="make a new one; pages must be paired again")
    return parser


def main(
    argv: list[str] | None = None,
    *,
    store: Store | None = None,
    api_factory: ApiFactory | None = None,
    input_fn: Callable[[str], str] = input,
    getpass_fn: Callable[[str], str] = getpass.getpass,
    out: TextIO | None = None,
    run_server: Callable[[Any], None] | None = None,
) -> int:
    args = _parser().parse_args(argv)
    store = store or Store()
    out = out or sys.stdout

    def say(line: str = "") -> None:
        print(line, file=out, flush=True)

    if args.command == "login":
        email = input_fn("Garmin e-mail: ").strip()
        password = getpass_fn("Garmin password (not shown, never saved): ")
        try:
            name = login(store, email, password,
                         prompt_mfa=lambda: input_fn("Verification code from Garmin: ").strip(),
                         api_factory=api_factory)
        except BridgeError as error:
            say(f"Could not sign in to Garmin: {error.message}")
            if isinstance(error, RateLimited):
                say("Garmin limits sign-in attempts. Wait 15–60 minutes before trying again.")
            return 1
        who = f" as {name}" if name else ""
        say(f"Signed in to Garmin{who}. Session saved in {store.dir} (readable only by you).")
        say("Your password was not saved.")
        return 0

    if args.command == "logout":
        removed = store.delete_tokens()
        say("Signed out: the saved Garmin session was deleted." if removed
            else "Signed out: there was no saved Garmin session.")
        return 0

    if args.command == "status":
        saved = store.tokens_saved_at()
        say(f"Signed in to Garmin (session saved {saved})." if saved
            else "Not signed in to Garmin. Run `make garmin-login`.")
        return 0

    if args.command == "pair":
        say(store.pairing_token(rotate=args.rotate) or "")
        return 0

    # serve
    quiet_library()
    token = store.pairing_token() or ""
    origins = tuple(dict.fromkeys([*default_origins(), *args.allow_origin]))

    def provider() -> GarminClient:
        return GarminClient(open_api(store, api_factory=api_factory),
                            on_tokens_changed=store.write_tokens)

    server = make_server(Config(token=token, origins=origins, store=store, client_provider=provider),
                         port=args.port)
    port = server.server_address[1]
    say(f"yootri Garmin bridge {__version__} listening on http://127.0.0.1:{port}")
    say(f"Pages allowed to use it: {', '.join(origins)}")
    say(f"Pairing token: {token}")
    say("Pair a page once: open " + " or ".join(f"{o}/?garmin=setup" for o in origins)
        + " and paste the token.")
    if store.read_tokens() is None:
        say("Not signed in to Garmin yet: run `make garmin-login` in another terminal first.")
    say("Press Ctrl-C to stop.")
    try:
        (run_server or (lambda s: s.serve_forever()))(server)
    except KeyboardInterrupt:
        say()
    finally:
        server.server_close()
    return 0
