# yootri

Vanilla-JS triathlon training planner. No build step, no dependencies. Served at
the repo root by GitHub Pages — **anything committed here is public**.

## Layout

- `index.html` — the app: markup, styles, DOM, rendering, storage, cloud sync.
  Its main script is a `<script type="module">` that imports the engine below.
- `assets/coach/*.js` — the engine: pure ES modules, no DOM, no I/O. This is
  where the training model, session generation, validation and plan operations
  live, so they can be tested without a browser.
- `assets/nocturne.css` — the "Nocturne" design-system base.
- `tests/` — `npm test` (plain `node --test`, no test framework).
- `tools/garmin-bridge/` — the one part that is not plain files: a small Python
  program (run with `uv`) that signs in to Garmin on the athlete's own machine
  and answers the page on 127.0.0.1. `make garmin-test` runs its tests; CI runs
  them too. See "Garmin" below.

Because assets use relative paths and ES modules need a real origin, serve the
folder rather than opening the file: `make dev` (see `tools/dev-server.mjs`).
It serves on `http://localhost:8000/` — spelled `localhost`, because that is the
hostname Firebase authorizes by default and `127.0.0.1` is not, so Google
sign-in works on one and not the other. It also 404s a case-wrong path, which a
case-insensitive macOS filesystem otherwise hides until Pages serves it.

## The engine

| Module | Responsibility |
| --- | --- |
| `season.js` | The block model → weekly hours. Port of `../yootri-rnd/plan_model.py`; `fitToRace` lands it on a runway of N weeks, sized by `peakHours` — the athlete's own biggest week (`peakHoursFor` in `profile.js`, from their availability). The reference model's `annualHours` form survives only for the golden tests and the legacy migration. |
| `generate.js` | One week's hour budget → actual sessions. Deterministic. `easySession` is one session made easy — same id, day and length, at the Prep row's focus and zone — so easing adds no coaching content. |
| `profile.js` | Athlete profile: availability, constraints, per-block discipline splits, and two optional preferences — `longDays` (the day the long ride and long run land on) and `maxSessionsPerDay` (1 = no two-a-days). Absent means today's behaviour, and generation for a profile without them is unchanged. |
| `validate.js` | Deterministic rules. `error` = physically impossible (blocks an apply); `warn` = coaching judgement (the athlete's call). |
| `plan.js` | Plan-level operations and the draft → diff → apply flow. `freshWeek` rebuilds one week from the stored season with its race day (Reset week); `isUntouchedPlan` recognises the first-visit stand-in "My plan", which creating or importing a season replaces and a sign-in never uploads. `carryOver`/`upcomingEvents` say what survives a start-over. |
| `migrate.js` | Schema v2 → v3. `legacy-plan.js` is the frozen old template it needs. |
| `portable.js` | The plan-file envelope: what `exportPlan` writes and what `Import plan…` will accept. Import is total — every bad file comes back as a reason, never a throw. |
| `duration.js` | `"H:MM"` ↔ minutes, the format the app already stores. |
| `calendar.js` | Week-and-weekday ↔ real date, and the Monday-start month grid the calendar view draws. |
| `events.js` | The athlete's events. Races carry a *priority*: one is `primary` (shown as the **A race**) and is the only source of the plan's race date and distance, any number are `secondary` (**B races**) and get a taper landed on them — if they take more than two hours (`hasTaper`). The primary also carries an `ambition` (`finish`, `intermediate`, `competitive`), and any race may carry the athlete's own `expectedMinutes`. Holds the lists of distances a race may be, what each one is called on screen, and `RACE_NOMINAL`, the typical duration and intensity of each distance (unfitted). |
| `paces.js` | Running paces. Daniels' VDOT model over one benchmark result, and the benchmark list that holds it — the one-is-flagged shape `events.js` used before races needed three states. |
| `activities.js` | Reading an activity export. Garmin's activity CSV, plus the arithmetic the page's TCX/GPX readers need. Total, like `portable.js`. |
| `synced.js` | Activities synced from the Garmin bridge: the one boundary heart rate crosses (`splitSynced`), the allowlist a stored activity is held to, merging, sync windows and coverage, and the device-only heart-rate store's shape. Pure — the page fetches and stores. |
| `match.js` | Which synced activity was which planned session: same date, same discipline, closest duration. Proposes actuals; never writes one, never over the athlete's own log. |
| `load.js` | Training load: one number per session where an hour at threshold is 100 (power, pace, swim pace, session RPE, heart rate as the fallback), and its chronic (42-day) and acute (7-day) averages. Ported from GARMIN-CLAUDE. Never stored — worked out when read. |
| `workout.js` | A planned bike session as warm-up / main set / cool-down steps with %FTP targets (watts when `loadRefs.ftpW` is set), plus `planSyncSet`, which says what one "send to Garmin" run would do. Worked out when asked for, never stored on a session. |
| `athlete.js` | The athlete record ("About you"): birth year, sex, height, weight, background, recent training, equipment, goal. `normalizeAthlete` is an allowlist; `athleteGaps` says what is missing and, honestly, whether anything reads it yet; recent weekly hours are kept as the athlete's own record and size nothing. Never on a plan — see below. |
| `onboarding.js` | The onboarding wizard's logic: `STEPS`, `stepProblems` (what each step refuses, in sentences shown beside the box), `prefill` (what a returning athlete is not asked again — About you, the current plan's week and numbers, recent hours from synced Garmin weeks), `racePreview`, `buildPlanFromAnswers` (a new plan starting this Monday, sized by the week the athlete gave, tune-ups landed through `refit`) and `planReview`. The page draws the steps and saves; nothing here stores anything. Body measurements leave through `athleteFromAnswers` only. |
| `review.js` | Weekly release. `releaseState` (is a release due, which week is reviewed and which released next), `reviewWeek` (each session done, partial or missed — from the athlete's log, a matched synced activity, or nothing on a past day) and `proposeNextWeek` (the draft that releases the next week: the review's logs, plus at most one week budget from the existing `suggest` rules, plus — only when the athlete ticks it — `ease`, which makes `hardestSession` easy). No coaching constant of its own, and it never reads the overnight figures. |
| `fitness.js` | Fitness (42-day) and fatigue (7-day) training load as of today, form as their difference, and the lines the Fitness chart draws: actual (load.js), planned (an *estimate* of each planned session from its length and zone — `PLANNED.zoneIF`, unfitted) and a trend carried to race day. Derived on read, never stored. Lifts the 28 Sep exclusion of form (FINDINGS, 16 Oct); ACWR, monotony and strain stay out. Also the plan followed from today as a line (`followed`), `FITNESS_BANDS` and the illustrative race-day form range (`PLANNED.raceForm`). |
| `preparation.js` | Race preparation: a checklist of facts — fitness on race day against the distance's band, long sessions per discipline over 42 days, steady weeks among those the sync covered, race-day form. **No score and no verdict** (FINDINGS, 17 Oct); silent under three covered weeks. Derived on read, never stored; every number in `PREP` is unfitted. |
| `history.js` | What was actually trained, week by week, from synced activities — and which weeks a sync fully *covered*, so a gap in syncing never reads as a week off. `adapt.js`'s history rules and the coach's `get_training_history` read it. |
| `overnight.js` | Sleep and overnight heart rate from the bridge: the device-only store's shape (`normalizeNight` is an allowlist), its sync window, and `compareNights` — the last seven nights against the athlete's own four weeks before them. Describes nights, decides nothing. See below. |
| `targets.js` | What a season is built to arrive with. `PLAN_MODEL` is the **one frozen table of unfitted coaching constants** for the target-driven planner (ramp, tolerance, taper tiers, the start-fitness estimate); `targetCtl(raceType, ambition)` reads a target off `FITNESS_BANDS`; `taperDepth` gives the share of a week a tune-up's taper takes out. Kept out of `fitness.js` on purpose: the copy test holds that file to a stricter word list, and `competitive` is on it. |
| `startfit.js` | `startFitness`: the athlete's chronic training load today, from an entered figure, their synced sessions (power, pace, swim pace and session effort only — never heart rate) or an estimate from recent weekly hours, years in the sport and per-sport level. Body measurements play no part. |
| `races.js` | Where a plan's races fall: `landingsOf`, `landingsDetail`, `raceDayFor`, `raceClosure`, and `plannedRaceLoads` (what each tune-up adds to its day). Split out of `plan.js`, which hands them back, so the planner can read them without importing the plan. |
| `backplan.js` | The planner. `planSeason` builds a season backwards from a target fitness: even climb over the loading weeks from where the athlete is, hours found by bisection through `generateWeek` and `plannedLoad` (the Fitness chart's own estimate), each week inside the athlete's week, the validator's volume steps and `PLAN_MODEL.ramp.max`. Returns the season with `ctl` per week and a feasibility record; builds the best it can and says so when the target is out of reach, never overshoots. `planLevers` works out, by rebuilding, what would make it reachable. Pure. `refit` and `newPlan` call it for a plan that has a `target` (see below). |

**Nothing edits a stored plan in place.** A change builds a *draft* (a detached
copy), which is diffed, validated, shown, and only written by `applyDraft`. That
is what makes it safe to point an agent at a training plan, and it is why the
Plan setup form goes through the same ceremony a model would.

Events live on the plan as `events`, alongside `weekBudgets` — both are fields
added without a schema bump, because `migratePlan` passes a v3 record through
untouched and export/import/sync all carry unknown top-level fields. The one
race flagged `priority: 'primary'` owns `profile.raceDate` and `profile.raceType`;
moving it re-fits the season through the same draft → diff → apply flow the setup
form uses, which is why Plan setup only *shows* the race date. `normalizeEvent`
reads a legacy `goal: true` as `primary`, which is how that field changed with no
schema bump — do not reintroduce `goal` as a stored field. The two names the
athlete reads, **A race (target)** and **B race (fitness test)**, are display text
only: the stored values stay `primary` and `secondary`. `ambition` is kept on the
primary race alone (it goes with the priority if the race is stood down, and a new
primary inherits the old one's), and `expectedMinutes` on any race.

**Starting a new season keeps the races the athlete chooses.** **Delete plan & start
over…** (`openStartOverDialog`) lists the upcoming events (A = `primary`, B =
`secondary`, markers); the ticked ones are carried into the wizard as answers
(`carriedAnswers` in `onboarding.js`, `carryOver` in `plan.js`). Nothing is removed
until the wizard finishes — `replaceCurrentPlan` then swaps the plan, with a
ten-second Undo — so backing out changes nothing. What is true of the athlete
(benchmarks, FTP/CSS, synced Garmin history, About you) comes along; weeks, logs
and chat do not.

**A season can hold more than one race.** A race marked `secondary` is a B race, a
tune-up inside the build: `planLandings` in `season.js` decides where it lands and
`fitToRace` splices in one **taper week** and one **race week**, taken out of
whatever block those weeks were in. The season never gets longer for it — the
primary's date is what decides the length. The secondary taper week is not a new
opinion about how hard a down week should be: it is `multiplier('Peak', 2)`
written out as its own block, so a secondary landing is the primary's landing with
the first peak week removed. `planLandings` is the only place the rule lives — the
page, the validator and the coach tools all ask it rather than re-deriving it, so
the refusal the athlete is shown is the same refusal the model honoured.

**A B race of two hours or less gets no taper.** `hasTaper` (`events.js`) is the
rule: a race longer than `TAPER_MIN_MINUTES` (120) — by the athlete's own
`expectedMinutes` if given, else the typical time for the distance in
`RACE_NOMINAL` — gets the taper and race week above; a shorter one (10 km, half
marathon, sprint) is a hard day in the build. `landingsDetail` in `plan.js` hands
`planLandings` each landing as `{ absWeek, taper }`, and a landing with
`taper: false` changes no week of the season. A race of unknown length is
tapered, as every tune-up always was. The Ironman row of `RACE_NOMINAL` in
particular is a mid-pack guess; finishing times depend on the athlete.

**Nothing is scheduled on a race day or on the days after it — except after a
short B race.** `generateWeek` takes a `raceDay`, and `raceClosure` in `plan.js`
supplies it for any week a prioritised race falls in — including one the model
refused a taper for, because the athlete is racing that day either way. A race
early in the week therefore leaves the rest of that week clear; `tests/plan.test.js`
pins the Monday case so it reads as a decision rather than a bug. The exception
is a B race that gets no taper (above): `raceClosure` returns `raceOnly`, and
`generateWeek` clears just that day, since the days after a 10 km are not part of
any taper. A week with a race that needs a taper in it clears from its earliest
race day on. See `docs/FINDINGS.md` (25 Aug) for the latent bug this fixed in the
*primary* race week.

**yootri plans endurance racing from the Olympic up, and the distance list is three
lists because of it.** Each answers a different question:

- `RACE_TYPES` — what the race a season is *built for* may be: `olympic`, `70.3`
  and `ironman`, shortest first. This is what a picker offers for an A race.
  Olympic came back on 18 Oct 2026 (an owner decision): the fitness bands and
  `RACE_DEMAND` already described it, and the season is built to arrive at a
  target. It is not the default anywhere — the wizard opens on `70.3`.
- `KNOWN_RACE_TYPES` — what may reach `profile.raceType`, and so what a season may
  be *sized by*: the above plus the retired `sprint`. Every name
  here has a `RACE_DEMAND` row in `generate.js`. A plan is self-contained, so a
  season already built for a sprint has to go on being sized and validated as one
  rather than falling back to the default and quietly becoming a 70.3.
- `SECONDARY_RACE_TYPES` — what a *secondary* race may be: `10k`,
  `half-marathon`, `marathon`, `sprint`, `olympic`, and the long-course two. It
  can afford to be wider precisely because a secondary race never reaches
  `profile.raceType` — it is a label on a taper the model has already decided the
  shape of, so it needs no `RACE_DEMAND` row.

`normalizeEvent` enforces the boundary: a race marked `primary` whose distance is
not in `KNOWN_RACE_TYPES` is **demoted to secondary**, never dropped. Without that
a marathon would reach `profile.raceType`, `demandFor` would fall back to a 70.3,
and the season would be sized for a race nobody entered. `eventProblem` in
`tools.js` refuses the same thing with a sentence the coach can act on. It also
refuses a retired distance (`sprint`) as a *new* A race, while a season already
built for one goes on being edited.

In the page, `raceTypeOptions()` builds every distance picker from one rule: a
record that already carries a retired distance is handed its own value back, so
opening a panel can never silently re-aim a season, while a race being chosen now
may only pick from the pool its priority allows. **Do not put `sprint` (or a
distance shorter than it) back in `RACE_TYPES`, and do not delete the retired row
from `RACE_DEMAND`.**

**What a distance is stored as and what it is called are two things.** The
stored name — `70.3`, `ironman` — is a key: it indexes `RACE_DEMAND`, it syncs
to Firestore, it is written into every exported plan file, and it is what a
season already under way is sized and validated by. `raceTypeLabel` in
`events.js` maps it to the name the athlete reads (`IM 70.3`, `IRONMAN`); a
distance with no entry is shown as it is stored, which is what a distance out of
a plan file this app did not write wants. Every place a distance is *shown* goes
through it — the pickers'
option text, the Plan setup fit hint, the import preview's Race row, and the
`volume-beyond-race` warning — while every place one is *stored* keeps the key,
including each `<option value>`. **Restyling a name must never change a stored
one**: renaming the key would re-aim every plan that already carries it, because
`demandFor` falls back to the default distance without saying so, and a season
built for an ironman would quietly be sized as a 70.3. Note the copy has no
article before the label — "a IRONMAN" is wrong and "an IM 70.3" only works for
one of the two, so both messages read "…of training for IRONMAN".

Running paces work the same way. `benchmarks` is a third such field: a list of
results the athlete entered or picked out of an export, exactly one flagged
`current`. Every pace on a Run card is derived from that one at *draw* time,
never stored on a session — so replacing a benchmark updates the whole season at
once rather than leaving past weeks asserting last spring's fitness. What
generation does write is `paceZone`, a band name, resolved from the session's
own zone label so a card can never show "Z3–Z4" beside a band saying "easy".

**Heart rate never goes on a plan, and that is load-bearing rather than
incidental.** The whole plan except `chat` syncs to Firestore and exports to a
file, so a heart-rate field that reached a plan would be one sync from being
stored. File imports and the Strava mapper still read past it entirely
(`activities.js` has a test asserting the value never survives). Garmin sync is
the one place it is read, since 28 Sep, and only per activity (average and
maximum): `splitSynced` in `synced.js` is the only
function that touches it, and hands it back *separately* for the page to keep in
this browser's own storage (`yootri_activity_hr`). The activity that goes on the
plan carries none of it, and `normalizeSyncedActivity` is an allowlist that
`loadPlan` also runs, so a hand-edited plan file cannot put it back. Anything
later derived from it (training load) is computed at read time and never
stored. Before widening what is read, read `../yootri-rnd/FINDINGS.md` (25 Aug
and 28 Sep) and §9 item 4 of the private legal note.

**About you is not plan content, and its cloud copy has a consent of its own.**
Weight and height are health data, while a plan syncs and exports under the
ordinary sync consent — so the athlete record lives in this browser
(`yootri_athlete_v1`), never on a plan, never in a plan export, and never in a
coach session. `loadPlan` and `exportEnvelope` both drop an `athlete` field if
one is ever put on a plan. It reaches the account (`users/{uid}/athlete/profile`)
only when the athlete ticks a second box, recorded as `yootri_health_consent_v1`
and versioned by the privacy notice like sync consent. The cloud copy carries
the consent it was written under, and withdrawing replaces it with a bare
`withdrawnAt` marker rather than deleting it, so another device that still
remembers agreeing learns otherwise on its next pull instead of re-uploading.
`tests/index-html.test.js` pins the guards. The bridge reads no body data, and
its only daily data are the overnight figures below, which never leave the
browser.

**Garmin.** Garmin's developer program only takes businesses, so the page asks
`tools/garmin-bridge` — run by the athlete on their own machine, for their own
account — on 127.0.0.1. It is off unless a browser has been paired
(`?garmin=setup`), the way Strava is. Synced activities are *history*, not plan
content: storing them changes no session, so they are written directly rather
than through a draft (the same exception `commitBenchmarks` makes), while
logging them against sessions goes through `setActual` like the session modal.
`applyDraft` takes `activities` and `activitySync` from the stored plan, as it
does `chat`, so a coach draft taken before a sync cannot roll it back.

The coach proposes from that history the same way it proposes anything: the
judgement is in `adapt.js` (`HISTORY_THRESHOLDS` — silent under three covered
weeks, never an increase, never a week already under way), each suggestion
names a tool call, and the change goes through draft → diff → apply. A
suggestion's action speaks the engine's 0-based week; `adviceCall` in
`tools.js` is the one translation to the tools' 1-based weeks, for the model
and for the page's Preview button alike.

**Pairing is one click and the bridge's state is shown, never assumed.** `make garmin`
prints (and `make garmin-pair` opens) a link whose *fragment* carries the bridge
address and token; `parsePairing` in `synced.js` accepts it only for a loopback
address and a full-length token, and the page saves it through the one existing
path and removes it from the address bar first. A paired browser asks the bridge
what state it is in (`bridgeState`: ready, sign in, not running, pair again) and
says so under the Garmin item; an **unpaired browser makes no request to this
computer at all**, which `tests/index-html.test.js` pins. On macOS
`make garmin-install` keeps the bridge running as a LaunchAgent started with
`serve --quiet` (no token in its log); it changes nothing about what the bridge
reads or who may use it.

**Workouts go to Garmin through the bridge, and nowhere else.** `POST /v1/workouts`,
`/v1/workouts/remove` and `/v1/workouts/fit` exist only when the bridge is started
with `YOOTRI_GARMIN_WORKOUTS=1`; every other method and path is still refused. They
rest on unofficial Garmin endpoints, so all of it lives in `adapter.py` and a
refusal is `workout_rejected`, never an engine failure. What was sent is
remembered in this browser only (`yootri_garmin_workouts`), never on the plan —
the same rule as heart rate — and a send changes no session. The workout
contains the session's steps, FTP and date; keep heart rate and anything
health-related out of it. `tests/copy.test.js` guards the wording of this
feature (no medical or performance claims).

**Sleep and overnight heart rate are device-only, opted into twice, and decide
nothing.** Since 12 Oct the bridge can read three figures a night — minutes
asleep, the overnight HRV average, resting heart rate — from three range calls,
only when it was started with `YOOTRI_GARMIN_OVERNIGHT=1` *and* the athlete
ticked the box in the Garmin panel. `garmin_bridge/overnight.py` is an
allowlist that drops Garmin's own scores, statuses, baselines and feedback. The
page keeps the nights in `yootri_overnight`, this browser only: never on a plan,
so never synced or exported, and never in a coach session — no engine module but
`overnight.js` reads them, and `tests/index-html.test.js` pins that. The weekly
review sets the last seven nights beside the four weeks before them; when two
figures are outside the athlete's usual range it says so beside a box that makes
next week's hardest session easy, and that box is never ticked for them. The
plan records the eased session, not why. Unticking the box or disconnecting the
bridge deletes the store. Keep Garmin's vocabulary for these out of the copy
(`tests/copy.test.js`). Every threshold in `OVERNIGHT` is unfitted.

**A plan can be released one week at a time.** `release: { through }` is
another field added without a schema bump: sessions are shown up to that week,
later weeks as their block and planned hours. Absent means the whole season is
shown, which is every plan made before it; the wizard turns it on, and the plan
menu toggles it. The whole season stays materialized, so the validator, chart
and adaptation rules read it as before. A release is a draft like any change,
`applyDraft` never moves the horizon backwards, and the logs a review proposes
travel as `pendingActuals`, written at apply only for sessions that still exist
and never over the athlete's own log — `applyDraft` otherwise takes history
from the stored plan, not the draft. Training load appears in the review as
information only: per FINDINGS (28 Sep), no rule decides anything from load
until there is a season of real data.

**A change never rewrites a week already trained.** `refit` takes `keepBefore`:
weeks before it keep their sessions *and* their planned hours. Plan setup, race
changes and every coach tool pass the week today falls in; with no date (a coach
session without `today`) the whole season refits as before.

**A plan can be built to a target.** `plan.target = { ctl, start, feasibility }` —
another field added without a schema bump — records the chronic training load the
season was built to arrive with on race day (read off `FITNESS_BANDS` through the
race's `ambition`, `targets.js`), where the athlete started from and where that
figure came from (`startfit.js`: an entered figure, their synced sessions, or an
estimate from recent hours), and whether the planner (`backplan.js`) could reach
it. `season[].ctl` is the planned fitness at the end of each week. `refit` and
`newPlan` size such a plan with the planner; the weeks before `keepBefore` come
back byte for byte, pinned `weekBudgets` are fixed inputs, and a later week that is
still exactly what the generator made follows a re-size while one the athlete
edited does not. **Only Plan setup, a change of race and the wizard upgrade a plan
with no target** (`refit({ upgrade: true, start })`): the weekly review and the
coach's week-level tools leave a plan's sizing as they found it, so one week's
change never quietly re-sizes a season. The weekly release re-anchors a plan with a
target from the athlete's fitness at the end of the reviewed week when their synced
sessions say (`actualCtlAt`, never heart rate), and never lowers the target. The
inputs the start was worked out from (recent hours, years in the sport, background,
body measurements) are not stored on the plan; only the figure and its source are.

**A plan with no target is sized by the athlete's own week, never by an annual
figure.** There is no annual-hours setting: the biggest week of a season is all the time the
athlete said they have (`peakHoursFor`, rounded *down* to the half hour), and the
block model shapes every other week from it, so a season cannot outrun the week
it has to fit in and cannot flatten. `normalizeProfile` is an allowlist, so an old
plan or file carrying `annualHours` loads cleanly and the stored `season` keeps
its weeks until a refit re-sizes it. `volumeBeyondRace` is the one sanity check
left: an empty diary against a short race. See `docs/FINDINGS.md` (18 Oct).

**The page shows one plan.** There is no plan list: the switcher button names the
current plan and its menu starts a new season or imports one. Doing either
replaces what is stored — `clearPlans` in `index.html` removes every stored plan,
locally and from the cloud, but only once the wizard or import is finished.
Deleting the plan starts over from the untouched stand-in, which the page shows
as "Not set up yet". Storage still holds a list of plan records; the page just
never offers more than the current one.

Plans are schema v3: absolute week keys (`w0`…`w15`), materialized sessions, and
a stored `season`. A plan is self-contained, so changing the engine never
reshapes a season somebody is midway through. `adoptPlan` migrates older records
on the way in and writes the upgrade back immediately.

## R&D notebooks

Exploratory work on **training-load / physiology models** and **chart
prototyping** lives outside this repo, in `../yootri-rnd/` (Python notebooks,
deliberately not version controlled).

**Before changing training-load computation, session generation, validation
thresholds, the pace model or the SVG season chart, read
`../yootri-rnd/FINDINGS.md`.** It
records what was tried, what the numbers said, and what was ruled out — the
notebooks themselves are noisy and are only worth opening when a finding points
at one. It also records which constants are unfitted guesses, which matters
before tuning any of them.

If a session concludes something worth keeping, write it back to that
`FINDINGS.md`. It is the only durable record; there is no git history behind it.

## Working here

- Engine changes are test-first; `npm test` must stay green — CI runs it on
  Node 20, 22 and 24 for every pull request, alongside a repo-hygiene check
  (`.github/scripts/check-repo-hygiene.mjs`) that guards what gets published.
- `index.html` is not importable, so `tests/index-html.test.js` checks it as
  text: its module scripts parse, and every module, named export and asset it
  references exists. Rename an engine export and that is what catches it.
- The coaching constants (discipline splits, session lengths, ramp ceilings) are
  deliberately *not* universal truths. Prefer making something profile-driven
  over tuning a default toward one athlete.
