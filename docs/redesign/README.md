# Yootri app redesign: handoff to implementation

Source of truth: the design canvas "Yootri app redesign" (prototype files in `prototype/`, open the `.dc.html` files for markup and `app.css` for every style). It uses the Yootri design system (Glacier teal accent, dark and light themes, tokens in `app.css` on `.yt` and `.yt[data-theme="light"]`). Read `CLAUDE.md` first and follow its rules (engine/UI split, tests, no stored derived values).

## Goal
Replace the plan dropdown menu with a persistent left sidebar. The app opens on the current week of the active plan. Everything that lived in the dropdown gets a permanent home.

## Navigation
Sidebar sections: Training plan (This week, default), Training status, Biometrics, Health indicators. Items not built yet show a "Soon" tag and open a placeholder page (see `Status.dc.html`, `Health.dc.html`). Plan switcher sits at the top of the sidebar. Dark/Light switch and Download my data / Sign out sit in the footer. On phones the sidebar becomes a bottom tab bar (`Mobile.dc.html`).

Where the old dropdown items went:
- Plan list, New season, Blank plan, Import plan: plan switcher in the sidebar.
- Rename, Duplicate, Export, Delete plan: the "..." button in the plan header.
- Training paces, About you: Biometrics page.
- Show one week at a time: Week / Month switch in the toolbar.
- Download my data, Sign out: sidebar footer.

## This week page (`Main.dc.html`)
Header, then "Fitness, fatigue and form" cards (Today and Race day), plan phases strip, toolbar, stats row, 7-day grid, then the Season panel with a Training load / Fitness switch.

## What is real and what is sample
Real today (wire to existing engine and data): plan, week grid, sessions, completion, volumes, season training-load chart, biometrics fields, paces, theme.
Sample only, no calculation exists yet: fitness / fatigue / form numbers, the Fitness chart (planned, actual, trend lines), the Olympic / 70.3 / Ironman bands, Training status values, all Health indicators. Ship these as clearly labelled "Sample data / coming soon" states (the `chip-sample` pattern) until the engine exists. Do not invent claims elsewhere.

## Fitness model to implement later (agreed intent)
- Fitness = 42-day chronic load, fatigue = 7-day acute load, form = fitness minus fatigue. Reuse `load.js`; keep values derived on read, never stored.
- Actual line: completed sessions synced through the Garmin bridge (`synced.js` / `match.js`). Planned line: the plan's sessions. Trend: actual projected to race day.
- Bands (illustrative numbers in the prototype, to be set with the owner): Olympic 40 to 70, 70.3 60 to 90, Ironman 80 to 115. Lower edge = fitness to finish comfortably and enjoy it; upper edge = competitive (e.g. Kona-qualifying contender).
- Band colours: Olympic `--disc-swim`, 70.3 `--disc-bike`, Ironman `--disc-brick`. Lines also differ by dash pattern and marker; colour is never the only cue.

## Implementation notes
- Prototype icons are CSS masks (`.ic .i-*`) so no icon font is needed.
- Charts are inline SVG, viewBox 1000x170, with HTML axis labels; x = 20 + (week-1) * 62.67.
- The Training load / Fitness switch is pure CSS (`:has()` on radios); replace with app state as fits the codebase.
- Accessibility: keep the aria-labels, arrows plus signed numbers for deltas, contrast checked in both themes.

## Suggested order
1. Tokens and theme switch into the app CSS.
2. Shell: sidebar, plan switcher, header "..." actions, routing between pages (default This week).
3. Move dropdown features to their new homes; remove the dropdown.
4. Biometrics page from existing About you and paces.
5. Placeholder pages and the labelled sample indicators/Fitness chart.
6. Mobile tab bar.
7. Later: real fitness / fatigue / form in the engine with tests, then swap out the sample data.
