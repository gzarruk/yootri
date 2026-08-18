# yootri

<!-- SPDX-License-Identifier: MIT -->

A triathlon training planner — a 16‑week Ironman 70.3 plan you can edit,
reschedule by drag‑and‑drop, track completion on, and visualize as a season
training‑load chart. Single‑file, no build step, plain vanilla JS.

Live at **https://yootri.gzarruk.com**

## What it does
- 16‑week Base / Build / Peak / Taper plan with per‑day sessions (swim, bike,
  run, strength, yoga, brick, rest).
- Drag‑and‑drop rescheduling, add/edit/delete sessions, mark‑done tracking.
- Weekly and cumulative training‑load totals, per‑discipline volume, completion %.
- Hand‑drawn SVG season chart with hover tooltips (no charting library).
- Multiple named plans; create / switch / rename / duplicate / delete.

## Data & sync
- **Local first:** everything saves to the browser's `localStorage` and works
  fully offline / signed out.
- **Optional cloud sync:** sign in with Google to sync plans across devices via
  Cloud Firestore. Last‑write‑wins by `updatedAt`. See
  [`FIREBASE_SETUP.md`](FIREBASE_SETUP.md).
- **Export / Import:** each plan can be saved to / loaded from a JSON file.

## Files
- `index.html` — the entire app (markup + styles + logic).
- `assets/nocturne.css` — the "Nocturne" design‑system base styles.
- `assets/favicon.svg`, `assets/apple-touch-icon.png`, `favicon.ico` — icons.
- `firestore.rules` — Firestore security rules (owner‑only per‑user plans).
- `FIREBASE_SETUP.md` — one‑time Firebase console setup for cloud sync.

## Run locally
Because assets use relative paths, just serve the folder from its root:

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

## Deploy (GitHub Pages + custom subdomain)
1. Settings → **Pages** → Source = **Deploy from a branch**, Branch = `main`,
   Folder = **/ (root)**.
2. The committed `CNAME` file (`yootri.gzarruk.com`) sets the custom domain.
3. At the DNS host (Squarespace), add a record: `CNAME  yootri → gzarruk.github.io`.
4. Once DNS propagates, tick **Enforce HTTPS** in Settings → Pages.

Publishes at `https://yootri.gzarruk.com`.

## License

MIT — see [`LICENSE`](LICENSE).

`SPDX-License-Identifier: MIT`
