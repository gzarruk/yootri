/* Durations, in the dialect the app already stores them in.

   index.html persists session durations as "H:MM" strings, with an em dash for
   rest. The engine generates sessions that go straight into that store, so it
   must round-trip the same format rather than inventing a cleaner one. */

export const REST_DUR = '—';

/** "1:15" | "90" | 90 | "—" -> minutes. Mirrors durToMin in index.html. */
export function durToMin(x) {
  if (!x || x === REST_DUR) return 0;
  const t = String(x).trim();
  if (t.includes(':')) {
    const [h, m] = t.split(':');
    return (Number(h) || 0) * 60 + (Number(m) || 0);
  }
  return Number(t) || 0;
}

/** minutes -> "H:MM", or the rest marker for nothing at all. */
export function minToDur(min) {
  const n = Math.max(0, Math.round(Number(min) || 0));
  if (n === 0) return REST_DUR;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
