# yootri

Single-file vanilla-JS triathlon training planner. The whole app is
`index.html` (markup + styles + logic); `assets/nocturne.css` is the design
system base. No build step. Served at the repo root by GitHub Pages — anything
committed here is public.

## R&D notebooks

Exploratory work on **training-load / physiology models** and **chart
prototyping** lives outside this repo, in `../yootri-rnd/` (Python notebooks,
deliberately not version controlled).

**Before changing training-load computation or the SVG season chart, read
`../yootri-rnd/FINDINGS.md`.** It records what was tried, what the numbers
said, and what was ruled out — the notebooks themselves are noisy and are only
worth opening when a finding points at one.

If a session concludes something worth keeping, write it back to that
`FINDINGS.md`. It is the only durable record; there is no git history behind it.
