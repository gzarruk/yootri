/* ---- Privacy notice ----

   Cloud sync makes this project the controller of somebody else's training
   data, and a notice is what the law requires in return. It is a data array,
   drawn in two places from this one file: the privacy panel in the app's
   footer (index.html) and privacy.html, the same notice on a page of its own
   that a link can point at. Neither keeps a copy of the words, so the two
   cannot drift. Pure: no DOM, no storage.

   Two values below cannot be derived from anything else in the repo: the
   contact route, because a notice without a working one is not a notice, and
   the Firestore region, because the client config does not say where the data
   actually sits. They are filled in for this deployment; a fork has to set
   its own. Either left blank renders a loud marker in the notice and fails
   `tests/index-html.test.js`, so neither can be published by forgetting.

   The version is the notice's date. Change the notice materially, change the
   version, and everyone who agreed to sync is asked again. */

export const PRIVACY_CONTACT = 'gzarruk@gmail.com';
export const PRIVACY_REGION = 'eur3 (Europe)';
export const PRIVACY_VERSION = '2026-10-11';

const mustSet = (v, name) => v || '\u26a0 SET ' + name + ' BEFORE PUBLISHING';

export const PRIVACY_SECTIONS = () => [
  ['Who is responsible.',
    'Gustavo Zarruk, Norway, sole developer of yootri. For any question or request about your data, write to ' + mustSet(PRIVACY_CONTACT, 'PRIVACY_CONTACT') + '.'],
  ['Signed out, nothing is collected.',
    'yootri stores your plans in this browser and works fully without an account. Everything below applies only if you choose to sign in.'],
  ['What is stored if you sign in.',
    'From Google: an account identifier, your email address and your display name. From yootri: your plans — the schedule, your profile settings, which sessions you marked done, what you logged against them, including any note you typed, and any activities you synced from Garmin. About you only if you separately choose to keep it in your account (below). It is held in Google Cloud Firestore, in ' + mustSet(PRIVACY_REGION, 'PRIVACY_REGION') + '. Google acts as the processor.'],
  ['About you.',
    'Whatever you choose to fill in: birth year, sex, height, weight, your training background and recent training, equipment and goal. It is kept in this browser, and is never written into a plan, never in a plan export, and never read by the coach or sent to its AI provider. Weight and height are health data, so keeping About you in your account is a consent of its own, separate from plan sync: only if you tick that box is it copied to Google Cloud Firestore, in ' + mustSet(PRIVACY_REGION, 'PRIVACY_REGION') + '. Untick it, or clear About you, and that copy is deleted. A marker with no data in it stays, recording only that you withdrew, so another device of yours does not upload it again.'],
  ['Activities from Garmin.',
    'Only if you run the Garmin bridge on your own computer and pair this browser with it. The activities it reads — date and start time, sport, duration, distance, power, the effort rating you gave, and the activity’s name — are kept with the plan you synced them into, so they sync with it when you are signed in and are included when you export it. The average and maximum heart rate of each activity stay in this browser: they are never written into a plan, never synced and never exported, and so do any heart-rate thresholds you enter for working out training load. If you use the coach, the training load figures it reads — some of them worked out from that heart rate — go to the AI provider you configured, along with the rest of what it reads.'],
  ['Sleep and overnight heart rate from Garmin.',
    'Only if you start the Garmin bridge with overnight figures switched on and tick the box for them in the Garmin panel. Night by night: minutes asleep, the overnight HRV average and resting heart rate — none of Garmin’s own scores or readings of them. They stay in this browser: they are never written into a plan, never synced, never exported, and never given to the coach or its AI provider. They are used for one thing: the weekly review sets your last seven nights beside the four weeks before them and, when they are outside your usual range, says so beside the option to make one session easy, which you choose or not. Nights older than three months are deleted as new ones arrive; unticking the box, or disconnecting this browser from the bridge, deletes them all.'],
  ['Workouts sent to Garmin.',
    'Only if you choose “To Garmin” or “Send to Garmin” with the bridge running and workout export switched on. For each bike session the bridge is sent the session’s name, its steps with their durations and power targets, your FTP if you entered one, and the date. The bridge passes them to your own Garmin account. Nothing is added to your plan by it, and no heart rate or other health data is part of it. This browser remembers which sessions it sent so a second send does not duplicate them; that record stays in this browser.'],
  ['What never leaves this browser, signed in or not.',
    'Your AI provider API key and every coach conversation, which are stripped before anything is sent, and heart rate, sleep and overnight heart rate read from Garmin, which are never put on a plan at all. None of these is in an export either.'],
  ['What it is used for.',
    'Making your plans, and About you if you chose to keep it there, available on your other devices. That is the only purpose. There is no analytics, no tracking, no advertising, and your data is never shared or sold.'],
  ['The basis for it.',
    'Your consent, asked for separately the first time you sign in, and for About you a second consent of its own. Each is withdrawable at any time without losing anything stored in this browser.'],
  ['How long it is kept.',
    'Until you delete it. Deleting your cloud data removes the plans, About you and the account record, and takes effect immediately.'],
  ['Not intended for children.',
    'yootri is not directed at children under 16 and should not be used by them without a parent or guardian.'],
];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** The sections as the markup both places draw. */
export const privacySectionsHtml = () =>
  '<div class="legal">' +
    PRIVACY_SECTIONS().map(([head, body]) => '<p><b>' + esc(head) + '</b> ' + esc(body) + '</p>').join('') +
  '</div>';

/** What a person can ask for, and where to complain. In the app the deletion
    button sits right under it; on its own page it has to say where that is. */
export const privacyRightsHtml = ({ standalone = false } = {}) =>
  '<p class="legal-about"><b>Your rights.</b> You can ask for a copy of your data, correct it, have it deleted, or withdraw your consent. ' +
    'A copy needs no asking — <b>Download my data</b> (in the sidebar) writes out every plan and About you, and ' +
    '<b>Export this plan</b> (the … button beside the plan’s name) writes out one plan. ' +
    'Corrections you make by editing the plan. ' +
    (standalone
      ? 'Deletion is <b>Delete my cloud data</b>, in the privacy notice at the foot of the app once you are signed in. '
      : 'Deletion is the button below. ') +
    'If you believe your data has been mishandled you can complain to ' +
    '<a href="https://www.datatilsynet.no/" target="_blank" rel="noopener">Datatilsynet</a>.</p>';
