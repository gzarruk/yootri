# Onboarding and weekly release — roadmap

The goal: a new athlete signs in, is walked through who they are, how they
train and what they are racing, and ends with a season built for them and its
first week on the calendar. A returning athlete starting a new season sees what
yootri already knows and is asked only for what is missing. After that the plan
is released **one week at a time**: when a week ends, it is reviewed against
what was actually trained, and the next week is proposed from that.

Decisions this roadmap rests on:

- **Open to the public**, so first run, consent wording and partial profiles all
  have to hold up for strangers.
- **Body measurements sync to the cloud only behind a separate, explicit health
  consent.** Heart rate stays exactly where it is today: in this browser.
- **The season stays a full skeleton** (blocks, weekly hours, races), and only
  its *sessions* are released week by week. The periodisation model is kept.

Each phase below is one pull request and keeps `npm test` green.

```
P0 groundwork ─► P1 athlete record + consent ─► P2 habits in the engine ─► P3 wizard
                                                                              │
                        P5 sleep + overnight heart rate ◄── P4 weekly release ◄┘
```

## What the design leans on

- **Recent races and recent volume beat body measurements** as predictors of
  long-course performance, so week 1 is anchored on the last 4–6 weeks of real
  training rather than on age or weight. Height changes nothing in planning and
  is optional.
- **Thresholds are optional at onboarding** in the established apps: "I don't
  know" is a valid answer, and a plan works by feel until a number exists.
- **Show the plan before committing it.** The wizard ends on the same diff and
  validation the Plan setup form already uses.
- **Missed sessions are not rescheduled**; what is still ahead is adjusted.
  They are marked missed, not deleted, so compliance stays honest.
- **Sleep and HRV can trim or swap intensity, never rebuild a week**, and only
  from a multi-day trend against the athlete's own baseline. The evidence for
  more than that is weak.
- **Weight, resting heart rate, HRV and sleep are health data** under GDPR, so
  they need explicit consent, minimisation (derived weekly flags rather than raw
  nightly series), an EU region, export and deletion.

## Phase 0 — groundwork (done)

Plan-lifecycle bugs the wizard would otherwise inherit:

- Reset week built a race week without its race day. It now goes through
  `freshWeek` in `plan.js`, the same rule a re-fit uses.
- The first-visit check read a schema-v2 shape and never saw a logged session.
  `isUntouchedPlan` replaces it.
- "Create a season" and Import left the first-visit stand-in behind as a second
  plan; they now replace it. A new device signing in no longer uploads its
  stand-in or lands on it.
- New plan started on the old plan's start date and dropped the running
  result, FTP/CSS and synced activities. It now starts this Monday and carries
  them.
- FTP and CSS could only be entered after a Garmin sync. They are in the
  Training paces panel now.

## Phase 1 — athlete record and health consent (done)

- `assets/coach/athlete.js`: an allowlisted athlete record — birth year, sex,
  weight, optional height, years in the sport, per-sport level, recent weekly
  hours, longest recent ride and run, equipment (pool, open water, trainer,
  power meter), goal (finish or time).
- `athleteGaps(athlete, plan)` drives the returning-athlete welcome: what is
  known, what is missing, and why each item matters.
- `estimateAnnualHours({ recentWeeklyHours, raceType, weeks })` sizes the season
  so its first week is close to what the athlete already trains.
- FTP, CSS and running results stay on the plan, as now. Body measurements
  **never** go on a plan or into an exported plan file — tested the same way
  heart rate is.
- Storage: this browser always; `users/{uid}/athlete/profile` in Firestore only
  with the separate health consent. Rules, privacy notice version, notice text,
  account erasure and a "Download my data" action all change with it.
- As built: an **About you** panel in the plan menu edits the record and holds
  the consent box. Withdrawing leaves a data-free marker in the account so a
  second device does not re-upload. Weight shows FTP as W/kg; sex preselects
  the heart-rate formula; recent weekly hours show the annual-hours figure that
  would open the current plan near them. The other fields say plainly that
  nothing reads them yet.

## Phase 2 — training habits the engine uses (done)

Read the R&D findings first: this changes session generation.

- Long-ride and long-run day preferences (`profile.longDays`). The named day
  takes the week shape's biggest share (the run day the biggest the ride left),
  and the long session is placed there first; another discipline's sessions
  keep off a named day until its long session is down. A day with no time, or
  one a constraint rules out, falls back and is reported once for the season
  (`long-day-unavailable`).
- A per-day session cap (`profile.maxSessionsPerDay`, 1–3; 1 means no
  two-a-days), honoured by placement and checked by the validator
  (`too-many-sessions`) for weeks edited by hand or by the coach.
- Plan setup gains the three fields, and the coach a `set_session_preferences`
  tool.
- Both settings are opt-in. A profile without them generates exactly what it
  did before: checked across 11,620 generated weeks, budgets and plans.
- Changed from the plan above: pool access stays on About you, and Plan setup
  points from "no pool, no open water" to the existing swim cap rather than
  setting it behind the athlete's back; the wizard can map it directly. The
  experience fallback for season sizing was left out, because it would need a
  new hours-by-experience table, which is exactly the kind of unfitted default
  this project avoids — the wizard asks for recent hours instead.
- Built without `../yootri-rnd/FINDINGS.md` to hand. Nothing tuned an existing
  constant, but the next session with the notes should check this phase
  against them and record the long-day behaviour there.

## Phase 3 — the onboarding wizard (done)

`assets/coach/onboarding.js` holds the steps, per-step validation (races reuse
`eventProblem` and `planLandings`), prefill from the athlete record, the current
plan and Garmin history, and `planArgsFromAnswers`, which returns exactly what
`newPlan` takes. The page draws it as a multi-step panel with progress, resumes
after a reload, and never loses answers on Back.

1. **Welcome** — the process in three lines, or, for a returning athlete, what is
   known and what is missing. Offers Garmin to prefill.
2. **About you** — birth year, sex, weight, height (optional), with the health
   consent inline.
3. **Background** — years in the sport, per-sport level, recent weekly hours,
   longest ride and run.
4. **Thresholds** — FTP, a recent run result, swim CSS. "I don't know" is fine.
5. **Your week** — minutes per day (0 is a rest day), long-ride day, long-run day,
   doubles, swims per week, pool and trainer access.
6. **Races** — the main race and any tune-ups, with the live taper preview.
7. **Goal** — finish or a time; anything else as a note.
8. **Review** — the season, its warnings (errors block), and week 1.
9. **Done** — "Your plan is ready — week 1 is in your calendar."

It opens on a first visit or first sign-in with no real plan, and from the plan
menu as "Start a new season". The previous season is kept.

As built: the plan menu's **New season…** opens it (the old quick panel is
**Blank plan…**), and the first-run notice and a sign-in that brings no season
open it by themselves until it has been put off once. Only recent weekly hours
and the main race are required. A returning athlete's welcome lists what is
already known and what is still worth adding; the steps arrive filled in, and
the old race is never carried over. Nowhere to swim becomes a swim cap of 0.
The review shows the season's weekly hours as bars, week 1 session by session,
and the validator's warnings; an error blocks Create, as it blocks an Apply.

## Phase 4 — weekly release and review (done)

Read the R&D findings first: this changes adaptation.

- `release: { through }` on the plan (a field added without a schema bump, like
  `events`). Sessions stay materialised so validation, the chart and `adapt.js`
  keep working; the calendar shows sessions only up to `through`, and later
  weeks as their block and planned hours.
- Re-fits default to starting at the current week, so trained weeks are never
  rewritten.
- `assets/coach/review.js`: `reviewWeek` (done, partial, missed, extra, planned
  vs actual, acute and chronic load) and `proposeNextWeek`, which runs the
  existing suggestions plus one load rule (never an increase on load alone) and
  returns a draft for the next week.
- A banner once a week has ended: sync from Garmin if paired, review, preview
  next week, Apply. Nothing is released without Apply.
- Coach tools: `get_week_review`, `release_next_week`.
- As built: the load rule was **left out**. FINDINGS (28 Sep) records that no
  rule should decide anything from training load until there is a season of real
  data, and that ACWR-style readings are deliberately not exposed. The review
  shows chronic and acute load as information only; next week's change comes
  solely from the existing adaptation rules. Releasing logs the review's synced
  matches and missed sessions (`pendingActuals`, written at apply, never over
  the athlete's own log). The plan menu toggles weekly release for older plans.

## Phase 5 — sleep and overnight heart rate (done)

Reverses a documented, tested stance — the bridge read activities only — so it
waited for a deliberate decision. FINDINGS (28 Sep) records that the
daily-physiology scores and the ingestion of daily data they feed on (HRV, sleep
and Garmin's own daily figures) were deliberately not ported, and that their
vocabulary is barred from yootri's copy. The repository owner decided on 12 Oct
to go ahead; this phase is built to stay as close to that earlier stance as the
feature allows.

- The bridge serves `GET /v1/overnight` only when started with
  `YOOTRI_GARMIN_OVERNIGHT=1`, and the page asks only when the athlete has
  ticked a box in the Garmin panel. Three range calls, never the per-night
  endpoints; the tests that pinned "activities only" now pin exactly which
  calls each path makes.
- Per night, at most three numbers: minutes asleep, the overnight HRV average,
  resting heart rate. Garmin's own scores, statuses, baselines and feedback are
  dropped in the bridge; so are sleep stages, SpO2 and respiration.
- `assets/coach/overnight.js` (not `readiness.js`: the word is barred from the
  copy) compares the last seven nights with the four weeks before them, figure
  by figure, against the athlete's own usual range.
- In the weekly review, a box makes next week's hardest session easy — the same
  length, at the Prep row's focus and zone. It is never ticked for the athlete;
  when two figures are outside the usual range the review says so beside it.
  The coach can do the same through `release_next_week`'s `ease`, only when the
  athlete asks, and never sees the nights.
- As built, narrower than planned: **nothing reaches the athlete record or the
  cloud** — not even derived flags. The nights live in this browser only, like
  heart rate, so the privacy position for synced data is unchanged. There is no
  "trim a little" (it would have been a new unfitted constant), no weight from
  Garmin, and no sleep score.
- Not yet measured against a real Garmin account: the response shapes come from
  `garminconnect` 0.3.16's own code and typed models, and the mapper drops what
  it cannot read rather than guessing.

## Later

- A threshold-test option in week 1 when FTP, CSS or a run result is unknown.
- Travel and blackout weeks from the wizard, as pinned week budgets.
- An archive state for finished seasons.
- Sending each released week's bike sessions to Garmin automatically.
