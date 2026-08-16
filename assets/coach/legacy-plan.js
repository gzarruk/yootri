/* The 16-week template the app shipped before the season engine existed.

   This is frozen legacy data: it exists only so `migrate.js` can materialize the
   weeks a v2 plan never edited. Nothing generates from it any more. Extracted
   verbatim from the `planData` constant in index.html rather than retyped, so a
   migrated plan reproduces exactly what the athlete was already looking at.

   Do not edit these numbers. Changing them would silently rewrite the history of
   every plan that has not been migrated yet. */

export const LEGACY_PLAN_DATA = {
    Base: { duration: 6, weeks: [
      { label: 'Base · Week 1', focus: 'Aerobic base', days: [
        { d: 'Mon', disc: 'Rest', focus: 'Recovery & mobility', dur: '—', zone: '—' },
        { d: 'Mon', disc: 'Yoga', focus: 'Yoga & stretching', dur: '0:30', zone: '—' },
        { d: 'Tue', disc: 'Swim', focus: 'Technique drills', dur: '0:45', zone: 'Z2' },
        { d: 'Wed', disc: 'Bike', focus: 'Endurance spin', dur: '1:15', zone: 'Z2' },
        { d: 'Thu', disc: 'Run', focus: 'Easy aerobic', dur: '0:40', zone: 'Z2' },
        { d: 'Fri', disc: 'Swim', focus: 'Endurance sets', dur: '1:00', zone: 'Z2–Z3' },
        { d: 'Sat', disc: 'Bike', focus: 'Long ride', dur: '2:00', zone: 'Z2' },
        { d: 'Sun', disc: 'Run', focus: 'Long run', dur: '1:10', zone: 'Z2' },
      ]},
      { label: 'Base · Week 2', focus: 'Volume build', days: [
        { d: 'Mon', disc: 'Rest', focus: 'Recovery & mobility', dur: '—', zone: '—' },
        { d: 'Mon', disc: 'Yoga', focus: 'Yoga & stretching', dur: '0:30', zone: '—' },
        { d: 'Tue', disc: 'Swim', focus: 'Threshold sets', dur: '0:50', zone: 'Z3' },
        { d: 'Wed', disc: 'Bike', focus: 'Tempo intervals', dur: '1:20', zone: 'Z3' },
        { d: 'Thu', disc: 'Run', focus: 'Aerobic + strides', dur: '0:45', zone: 'Z2–Z4' },
        { d: 'Fri', disc: 'Strength', focus: 'Core & stability', dur: '0:40', zone: '—' },
        { d: 'Sat', disc: 'Bike', focus: 'Long ride', dur: '2:30', zone: 'Z2' },
        { d: 'Sun', disc: 'Brick', focus: 'Ride + transition run', dur: '1:45', zone: 'Z2–Z3' },
      ]},
    ]},
    Build: { duration: 5, weeks: [
      { label: 'Build · Week 1', focus: 'Threshold', days: [
        { d: 'Mon', disc: 'Rest', focus: 'Recovery & mobility', dur: '—', zone: '—' },
        { d: 'Mon', disc: 'Yoga', focus: 'Yoga & stretching', dur: '0:30', zone: '—' },
        { d: 'Tue', disc: 'Swim', focus: 'VO2 sets', dur: '0:55', zone: 'Z4' },
        { d: 'Wed', disc: 'Bike', focus: 'Threshold 2×20', dur: '1:30', zone: 'Z4' },
        { d: 'Thu', disc: 'Run', focus: 'Tempo', dur: '0:55', zone: 'Z3–Z4' },
        { d: 'Fri', disc: 'Swim', focus: 'Endurance', dur: '1:05', zone: 'Z2' },
        { d: 'Sat', disc: 'Bike', focus: 'Long ride + efforts', dur: '3:00', zone: 'Z2–Z3' },
        { d: 'Sun', disc: 'Run', focus: 'Long run', dur: '1:30', zone: 'Z2' },
      ]},
      { label: 'Build · Week 2', focus: 'Race specificity', days: [
        { d: 'Mon', disc: 'Rest', focus: 'Recovery & mobility', dur: '—', zone: '—' },
        { d: 'Mon', disc: 'Yoga', focus: 'Yoga & stretching', dur: '0:30', zone: '—' },
        { d: 'Tue', disc: 'Swim', focus: 'Race-pace sets', dur: '1:00', zone: 'Z3–Z4' },
        { d: 'Wed', disc: 'Bike', focus: 'Over-unders', dur: '1:40', zone: 'Z3–Z4' },
        { d: 'Thu', disc: 'Run', focus: 'Hill repeats', dur: '1:00', zone: 'Z4' },
        { d: 'Fri', disc: 'Strength', focus: 'Power & durability', dur: '0:40', zone: '—' },
        { d: 'Sat', disc: 'Brick', focus: 'Long ride + run', dur: '3:30', zone: 'Z2–Z3' },
        { d: 'Sun', disc: 'Run', focus: 'Long run', dur: '1:40', zone: 'Z2' },
      ]},
    ]},
    Peak: { duration: 3, weeks: [
      { label: 'Peak · Week 1', focus: 'Race simulation', days: [
        { d: 'Mon', disc: 'Rest', focus: 'Recovery & mobility', dur: '—', zone: '—' },
        { d: 'Mon', disc: 'Yoga', focus: 'Yoga & stretching', dur: '0:30', zone: '—' },
        { d: 'Tue', disc: 'Swim', focus: 'Race simulation', dur: '1:10', zone: 'Z3' },
        { d: 'Wed', disc: 'Bike', focus: 'Race-pace hold', dur: '2:00', zone: 'Z3' },
        { d: 'Thu', disc: 'Run', focus: 'Tempo', dur: '1:05', zone: 'Z3–Z4' },
        { d: 'Fri', disc: 'Swim', focus: 'Sharpen', dur: '0:50', zone: 'Z2' },
        { d: 'Sat', disc: 'Brick', focus: '70.3 simulation', dur: '4:00', zone: 'Z2–Z3' },
        { d: 'Sun', disc: 'Run', focus: 'Long steady', dur: '1:45', zone: 'Z2' },
      ]},
    ]},
    Taper: { duration: 2, weeks: [
      { label: 'Taper · Race week', focus: 'Freshen & sharpen', days: [
        { d: 'Mon', disc: 'Rest', focus: 'Recovery & mobility', dur: '—', zone: '—' },
        { d: 'Mon', disc: 'Yoga', focus: 'Yoga & stretching', dur: '0:30', zone: '—' },
        { d: 'Tue', disc: 'Swim', focus: 'Sharpen', dur: '0:35', zone: 'Z2–Z3' },
        { d: 'Wed', disc: 'Bike', focus: 'Openers', dur: '0:50', zone: 'Z2–Z4' },
        { d: 'Thu', disc: 'Run', focus: 'Easy + strides', dur: '0:30', zone: 'Z2' },
        { d: 'Fri', disc: 'Rest', focus: 'Travel & prep', dur: '—', zone: '—' },
        { d: 'Sat', disc: 'Bike', focus: 'Short openers', dur: '0:30', zone: 'Z2–Z3' },
        { d: 'Sun', disc: 'Run', focus: 'Race-day shakeout', dur: '0:20', zone: 'Z1–Z2' },
      ]},
    ]},
};
