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

## What it does and does not do

- A failed run writes nothing, keeps the last good feed, appends a line to
  `~/.config/yootri/sync.log` and shows a macOS notification. A Garmin rate limit
  is not retried.
- An empty result means Garmin has not published the week yet. It is recorded as
  checked and is not an error.
- The feed holds each run's name, date, sport and steps only. The page shows a
  notice when the last check is more than 36 hours old.
- Nothing is applied to your plan by the job: the page lists the runs and you
  accept what you want.
