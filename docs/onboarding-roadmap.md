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
                              P5 readiness data (gated) ◄── P4 weekly release ◄┘
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

## Phase 1 — athlete record and health consent

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

## Phase 2 — training habits the engine uses

Read the R&D findings first: this changes session generation.

- Long-ride and long-run day preferences, honoured by `place()` when the day
  can hold it, with a warning when it cannot.
- Doubles (`allowed` / `avoid`) and a per-day session cap.
- No pool → no swims unless open water is available, through the existing
  constraint.
- `profile.experience` finally read — only as the fallback for sizing a season
  when recent volume is unknown. No new universal coaching constants.
- Plan setup and the coach tools gain the same fields.

## Phase 3 — the onboarding wizard

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

## Phase 4 — weekly release and review

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

## Phase 5 — readiness data (gated)

Reverses a documented, tested stance — the bridge reads activities only — so it
needs a deliberate decision after re-reading the R&D findings and the private
legal note.

- A bridge endpoint for daily sleep, overnight HRV and resting heart rate, off
  unless explicitly enabled, with the bridge tests that forbid it updated on
  purpose.
- `assets/coach/readiness.js` reduces those to weekly flags. Raw values stay in
  this browser; only the flags reach the athlete record, under health consent.
- `proposeNextWeek` may swap a hard session for an easy one or trim a little on
  those flags. Never more, and never a health conclusion.

## Later

- A threshold-test option in week 1 when FTP, CSS or a run result is unknown.
- Travel and blackout weeks from the wizard, as pinned week budgets.
- An archive state for finished seasons.
- Sending each released week's bike sessions to Garmin automatically.
