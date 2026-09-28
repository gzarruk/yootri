# Garmin bridge

A small program you run on your own computer so the yootri page can read your
recent Garmin activities. It is for **your own account, on your own machine**.

yootri is a static page with no server. Garmin's official developer program
only accepts businesses, so there is no official route a personal planner can
use. This bridge uses [`garminconnect`](https://github.com/cyberjunky/python-garminconnect),
an unofficial library that signs in the way Garmin's own app does. Because it is
unofficial, a change on Garmin's side can break it without warning. The version
is pinned exactly (`pyproject.toml`) for that reason.

## Using it

You need [uv](https://docs.astral.sh/uv/getting-started/installation/). From the
repository root:

```sh
make garmin-login     # once: e-mail, password, and the code Garmin sends you
make garmin           # while you want to sync; Ctrl-C to stop
```

`make garmin` prints a **pairing token** and a setup link. Open the link
(`http://localhost:8000/?garmin=setup` with `make dev` running, or the published
site with `?garmin=setup`), paste the token and save. From then on, that
browser shows a **Garmin** button in the toolbar. Press it while the bridge is
running.

| Command | What it does |
| --- | --- |
| `make garmin-login` | Signs in and saves the session. Your password is passed to the library and never saved. |
| `make garmin` | Runs the bridge on `127.0.0.1:8765` (`GARMIN_PORT=…` to change). |
| `make garmin-status` | Says whether a session is saved. |
| `make garmin-logout` | Deletes the saved session. To end it on Garmin's side too, change your Garmin password. |
| `make garmin-test` | The bridge's tests: a fake Garmin, no network, no account needed. |

## What crosses to the page

Per activity: date and start time, sport, which discipline it counts as, the
activity's name, duration (total, moving, elapsed), distance, average and
normalized power, the effort rating you gave it, whether it was a race, and the
average and maximum heart rate.

The page stores the activity on your plan. **Heart rate stays in the browser
that synced it**: it is never written into a plan, so it is never synced to the
cloud and never included in an exported plan file.

Nothing else crosses. The mapper keeps an explicit allowlist (`WIRE_KEYS` in
`garmin_bridge/mapper.py`), so the GPS track, the device, calories, your name on
the account and Garmin's own scores stay behind even when Garmin sends them.
The bridge asks Garmin for activity summaries and nothing else — no daily data,
no files, no profile — and a test asserts exactly which library calls it makes.

## Where things are kept

`~/.config/yootri/` (or `$XDG_CONFIG_HOME/yootri`, or `$YOOTRI_GARMIN_HOME`),
a directory only you can read:

- `garmin-tokens.json` is the Garmin session. Whoever holds it can read your
  Garmin account until you change your password, so guard it like one.
- `garmin-bridge-token` is the pairing token. `python -m garmin_bridge pair --rotate`
  (from this folder, via `uv run`) makes a new one; pages have to be paired again.

Your e-mail address and password are never written anywhere.

## Who can talk to it

The bridge listens on `127.0.0.1` only, answers `GET` only, and checks three
things before it does anything:

1. **Host** must be `127.0.0.1:<port>` or `localhost:<port>`. A web page that
   points a name it controls at your machine still sends that name, and is
   refused (this is what stops DNS rebinding).
2. **Origin**, when a browser sends one, must be an allowed page:
   `http://localhost:8000`, the published site named in the repository's
   `CNAME`, and anything you add with `--allow-origin`. Any other page gets a
   refusal it cannot even read.
3. **The pairing token** (`Authorization: Bearer …`), compared in constant time.

## Browsers

Asking a program on your own machine from a web page is something browsers
handle carefully, and they differ:

- **Chrome and Edge** ask once whether the page may reach devices on your local
  network. Allow it.
- **Firefox** allows it.
- **Safari** blocks a secure (`https://`) page from reaching `http://127.0.0.1`
  at all. Use it from `make dev` (`http://localhost:8000`) instead.

## When something goes wrong

- **"Not signed in"**: run `make garmin-login`. A session also ends when you
  change your Garmin password.
- **"Garmin is limiting requests"**: Garmin rate-limits sign-ins and requests
  per network address. Wait 15–60 minutes. Signing in again repeatedly makes it
  worse; the saved session exists so that you do not have to.
- **Sign-in stopped working for everyone**: Garmin has changed its sign-in, as
  it did in March 2026. Check the library's releases before changing the pin,
  and re-run `make garmin-test` after.

## One person, one machine

This is written for one person running it for themselves. Running it for
somebody else, or hosting it, would mean holding other people's Garmin
sessions, which is a different undertaking altogether and not what this is.

## Credits

Adapted from [GARMIN-CLAUDE](https://github.com/gzarruk/GARMIN-CLAUDE) by
nandocfz (MIT): the sign-in and session handling, the retry and pacing rules,
the error mapping, the sport mapping and the activity mapper.
