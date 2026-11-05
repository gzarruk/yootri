# Garmin Coach sync

Fetches the Garmin Coach runs scheduled for the next two weeks and writes them to
your own Firestore account (`users/{uid}/garmin/feed`), where the page lists
them for you to review. It runs on your own machine, on a schedule, with the
Garmin session `make garmin-login` already saved: nothing is signed in from a
cloud runner, and no Garmin token is stored anywhere else.

## One-time setup

1. Publish `firestore.rules` (Firebase console → Firestore → Rules). The page
   can read and delete the feed; only the job writes it.
2. Firebase console → Project settings → Service accounts → Generate new private
   key. Save the file **outside the repo**, e.g. `~/.config/yootri/firebase-sa.json`,
   and `chmod 600` it. Give that service account the "Cloud Datastore User" role
   if it does not already have one.
3. Create `~/.config/yootri/sync.json`:

   ```json
   { "projectId": "local-terminus-467316-m8", "uid": "<your Firebase user id>", "serviceAccount": "/Users/you/.config/yootri/firebase-sa.json" }
   ```

   The user id is under Authentication → Users.
4. `make garmin-login` if you have not signed in to Garmin on this machine.

## Use

```bash
make sync-dry       # fetch and print what would be written; writes nothing
make sync           # write the feed now
make sync-install   # run it automatically (macOS LaunchAgent)
make sync-uninstall
```

The schedule is local time: 00:20 daily, 23:30 on Sunday and 06:30 on Monday
(a retry for a week Garmin posted late). A missed run happens when the machine
wakes. On Linux, run `node tools/sync/run.mjs` from cron at the same times.

## When Garmin ends the session

Garmin ends a session now and then (a password change, a verification code). The
job tells you **once per outage**, not three times a day: a macOS notice saying to
run `make garmin-login`, and a `state` note in the feed document so the page on
your phone and on the published site says the same instead of waiting 36 hours to
look stale. Only `state` and `stateAt` are written then; the runs and `checkedAt`
stay as they were. The first good sync after you sign in clears both.

To get the notice on your phone as well, add a line to
`~/.config/yootri/yootri.conf`:

```ini
YOOTRI_NTFY_TOPIC=pick-a-long-random-name
```

and subscribe to that topic in the [ntfy](https://ntfy.sh) app. It is off unless
set. The message is one fixed sentence, never a plan, a run or a name; anyone who
learns the topic could read it or post to it, so make it long and unguessable.
Signing in itself stays by hand: Garmin's code goes to you, not to a script.

## Told when something is ready

After a good sync the job also reads your synced plan and asks the engine two
questions: has the week you released ended (so it is time to review it and
release the next), and are there suggestions for the current week. Each is said
**once**, as a macOS notice and, if `YOOTRI_NTFY_TOPIC` is set, to your phone:
"Week 12 is over. Open yootri to review it and release week 13." or "2
suggestions for this week are waiting in yootri." The sentences carry a week
number and a count, never a session, a run or a name. Nothing is applied and
nothing is stored for the page: the review and the suggestions are worked out
again when you open it, because the page also sees what stays in a browser
(overnight figures, heart-rate load) and this job never does. A plan that
cannot be read is logged as "digest skipped" and never fails the sync. What has
been said is remembered in `~/.config/yootri/sync-state.json`.

## One plan in the account

An account that has collected several plans under one name leaves each device
working on a different one. `node tools/sync/prune.mjs --keep <plan id>` shows
what would go and changes nothing; with `--yes` it copies the others to
`~/.config/yootri/backups/` and replaces each with a small deletion record, which
every device reads on its next pull and drops its own copy. Run it only after the
page that understands those records is live.

## What it does and does not do

- A failed run writes no runs (the one exception is the sign-in note above),
  keeps the last good feed, appends a line to
  `~/.config/yootri/sync.log` and shows a macOS notification. A Garmin rate limit
  is not retried.
- An empty result means Garmin has not published the week yet. It is recorded as
  checked and is not an error.
- The feed holds each run's name, date, sport and steps only. The page shows a
  notice when the last check is more than 36 hours old.
- Nothing is applied to your plan by the job: the page lists the runs and you
  accept what you want.
