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
import os
import sys
import webbrowser
from collections.abc import Callable
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import quote

from garmin_bridge import __version__
from garmin_bridge.agent import Agent
from garmin_bridge.auth import ApiFactory, login, open_api, quiet_library
from garmin_bridge.client import GarminClient
from garmin_bridge.errors import BridgeError, RateLimited
from garmin_bridge.server import DEFAULT_PORT, Config, make_server
from garmin_bridge.store import Store

LOCAL_DEV_ORIGIN = "http://localhost:8000"

# tools/garmin-bridge/garmin_bridge/cli.py → the repo root holds CNAME.
REPO_CNAME = Path(__file__).resolve().parents[3] / "CNAME"


def workouts_enabled(env: dict[str, str] | None = None) -> bool:
    """Workout export is off unless the athlete switches it on: YOOTRI_GARMIN_WORKOUTS=1.

    It leans on Garmin endpoints nobody promised to keep, so a bridge started
    without the flag behaves exactly as it did before they were added.
    """
    return (env if env is not None else os.environ).get("YOOTRI_GARMIN_WORKOUTS", "").strip() in ("1", "true", "yes")


def overnight_enabled(env: dict[str, str] | None = None) -> bool:
    """Overnight figures are off unless the athlete switches them on: YOOTRI_GARMIN_OVERNIGHT=1.

    Sleep, overnight HRV and resting heart rate are daily measurements of the
    body, a step past activity summaries, so a bridge started without the flag
    reads none of them — exactly as it did before they were added.
    """
    return (env if env is not None else os.environ).get("YOOTRI_GARMIN_OVERNIGHT", "").strip() in ("1", "true", "yes")


def default_origins(cname: Path = REPO_CNAME) -> tuple[str, ...]:
    """`make dev`'s origin, plus the published site named in the repo's CNAME."""
    try:
        host = cname.read_text(encoding="utf-8").strip()
    except OSError:
        host = ""
    return (LOCAL_DEV_ORIGIN, f"https://{host}") if host else (LOCAL_DEV_ORIGIN,)


def pairing_links(origins: tuple[str, ...] | list[str], port: int, token: str) -> list[str]:
    """One link per page allowed to use the bridge, that pairs it in one click.

    The address and token sit after the `#`, so a browser never sends them to
    the server the page is loaded from — and the page removes them from the
    address bar as soon as it has read them. Anything that can read the link
    can pair a browser, so it is shown only on this machine's terminal, the way
    the bare token always was; `pair --rotate` makes the old ones useless.
    """
    bridge = quote(f"http://127.0.0.1:{port}", safe="")
    return [f"{origin}/?garmin=setup#garmin={bridge}&token={token}" for origin in origins]


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
    serve.add_argument("--quiet", action="store_true",
                       help="do not print the pairing token or links (for a bridge that logs to a file)")
    agent = sub.add_parser("agent", help="keep the bridge running: a macOS LaunchAgent")
    agent_sub = agent.add_subparsers(dest="agent_command", required=True)
    install = agent_sub.add_parser("install", help="start the bridge at login and keep it running")
    install.add_argument("--port", type=int, default=DEFAULT_PORT)
    install.add_argument("--allow-origin", action="append", default=[], metavar="URL")
    agent_sub.add_parser("uninstall", help="stop it and remove the agent")
    agent_sub.add_parser("status", help="is the agent installed and running?")
    pair = sub.add_parser("pair", help="print the pairing token")
    pair.add_argument("--rotate", action="store_true", help="make a new one; pages must be paired again")
    pair.add_argument("--link", action="store_true", help="print one-click pairing links instead of the bare token")
    pair.add_argument("--open", action="store_true", help="open the first pairing link in your browser")
    pair.add_argument("--port", type=int, default=DEFAULT_PORT, help="the port the bridge listens on")
    pair.add_argument("--allow-origin", action="append", default=[], metavar="URL",
                      help="another page to make a link for (repeatable)")
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
    open_url: Callable[[str], Any] | None = None,
    agent: Agent | None = None,
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
        token = store.pairing_token(rotate=args.rotate) or ""
        if args.link or args.open:
            origins = tuple(dict.fromkeys([*default_origins(), *args.allow_origin]))
            links = pairing_links(origins, args.port, token)
            if args.open:
                say("Opening the pairing link in your browser…")
                (open_url or webbrowser.open)(links[0])
            else:
                for link in links:
                    say(link)
        else:
            say(token)
        return 0

    if args.command == "agent":
        ag = agent or Agent()
        if args.agent_command == "install":
            origins = tuple(dict.fromkeys(args.allow_origin))
            say(ag.install(port=args.port, origins=origins))
        elif args.agent_command == "uninstall":
            say(ag.uninstall())
        else:
            say(ag.status())
        return 0

    # serve
    quiet_library()
    token = store.pairing_token() or ""
    origins = tuple(dict.fromkeys([*default_origins(), *args.allow_origin]))

    def provider() -> GarminClient:
        return GarminClient(open_api(store, api_factory=api_factory),
                            on_tokens_changed=store.write_tokens)

    server = make_server(Config(token=token, origins=origins, store=store, client_provider=provider,
                                  workouts=workouts_enabled(), overnight=overnight_enabled()),
                         port=args.port)
    port = server.server_address[1]
    say(f"yootri Garmin bridge {__version__} listening on http://127.0.0.1:{port}")
    say(f"Pages allowed to use it: {', '.join(origins)}")
    if workouts_enabled():
        say("Workout export is ON (YOOTRI_GARMIN_WORKOUTS=1): the page may send bike workouts to Garmin.")
    if overnight_enabled():
        say("Overnight figures are ON (YOOTRI_GARMIN_OVERNIGHT=1): the page may read sleep, overnight HRV "
            "and resting heart rate.")
    if not args.quiet:
        say(f"Pairing token: {token}")
        say("Pair a page in one click — open the link for the page you use:")
        for link in pairing_links(origins, port, token):
            say("  " + link)
        say("Or open the page with ?garmin=setup and paste the token by hand.")
        if store.read_tokens() is None:
            say("Not signed in to Garmin yet: run `make garmin-login` in another terminal first.")
    if not args.quiet:
        say("Press Ctrl-C to stop.")
    try:
        (run_server or (lambda s: s.serve_forever()))(server)
    except KeyboardInterrupt:
        say()
    finally:
        server.server_close()
    return 0
