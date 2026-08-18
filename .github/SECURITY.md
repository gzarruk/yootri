# Security policy

yootri is a static, single-page app with no server of its own. It runs entirely
in the browser, stores plans in `localStorage`, and talks to two services only
when you ask it to: Firebase, if you sign in, and your own AI provider, if you
configure the coach.

## Reporting a vulnerability

Please report it privately, through GitHub:

**[Open a private security advisory](https://github.com/gzarruk/yootri/security/advisories/new)**

That keeps the report between us until there is a fix. Please do not open a
public issue for a security problem — the app holds people's own API keys, and a
public report is a public exploit.

Useful things to include: what an attacker gains, the steps to reproduce, and
the browser you saw it in.

For ordinary bugs that are not security problems, the
[issue tracker](https://github.com/gzarruk/yootri/issues) is the right place.

## What you can expect

yootri is written and maintained by one person, unpaid, in their own time. It is
free and MIT-licensed and there is nothing to buy, so please calibrate your
expectations accordingly:

- Reports are read and acted on as best I can. **There is no committed response
  time and no service level of any kind.** I would rather say that plainly than
  promise something I cannot keep.
- **There is no bug bounty** and no reward. Nothing to claim, nothing to
  negotiate.
- I will credit you in the advisory if you would like to be credited, and not if
  you would not.

## What gets fixed

The deployed site at <https://yootri.gzarruk.com> and the current `main` branch.

Released tags are not patched. If you are running an older tag or an older fork,
the fix is to take a newer version. A copy you already have keeps working — that
is the point of it being MIT-licensed and dependency-free — but it does not keep
receiving fixes.

## In scope

These are the things worth reporting, roughly in order of how much they would
worry me:

- Anything that sends the athlete's provider API key anywhere other than the
  provider they configured.
- Anything that lets one signed-in user read or write another user's plans, or
  that gets past the owner-scoped rules in `firestore.rules`.
- Script injection through data that comes back into the page — plan names,
  session titles, notes, log entries, imported plan files, or coach output.
- Anything that mutates a stored plan without going through the
  draft → diff → validate → `applyDraft` gate described in `CLAUDE.md`. That
  gate is the safety property the whole design rests on, and a bypass is a
  security bug even if no data leaves the browser.
- Anything in the import path that can be made to overwrite or destroy a plan
  the user did not intend to touch.

## Out of scope

Not because they do not matter, but because they are known, deliberate, and
already documented — a report about them tells me nothing new:

- **The API key is readable by any script running on the page.** This follows
  unavoidably from having no server: the key has to be in the browser to be
  used. It is disclosed in the app at the point where the key is entered. The
  mitigation is the same as the disclosure — do not run yootri alongside
  untrusted extensions or scripts, and use a key you can revoke.
- **Firebase web API keys are visible in the client source.** They are
  identifiers, not secrets. Access is governed by `firestore.rules`, which is
  owner-scoped with default deny.
- **A fork's own infrastructure.** Misconfigured Firebase projects, hosting, or
  DNS on a fork are that fork's to fix, not this repository's.
- Missing hardening headers that GitHub Pages does not let a static site set.
- Findings from an automated scanner with no demonstrated impact.

## Liability

The software is provided "as is" under the MIT licence, without warranty of any
kind. Nothing in this policy excludes or limits liability where the law does not
allow it, including liability for death or personal injury.

The full disclaimer is in the app, under **About & disclaimer** in the footer.
