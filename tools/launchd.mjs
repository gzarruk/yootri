/* Load a LaunchAgent, safely over one that is already running.

   `launchctl bootout` returns before launchd has finished with the job, and a
   `bootstrap` sent in that window is refused with "Input/output error" — which
   left the agent unloaded after a reinstall. So: bootout, wait until the
   service is gone, then bootstrap, trying again a few times if it still says no.
   `run(args)` returns launchctl's output, or null when it exits non-zero;
   `sleep(ms)` is passed in so tests never wait. */
import { execFileSync } from 'node:child_process';

export const launchctl = (args) => { try { return execFileSync('launchctl', args, { stdio: 'pipe' }).toString(); } catch { return null; } };
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function reload({ domain, label, plist, run = launchctl, sleep = wait }) {
  const target = `${domain}/${label}`;
  if (run(['print', target]) !== null) {
    run(['bootout', target]);
    for (let i = 0; i < 40 && run(['print', target]) !== null; i++) sleep(250);
  }
  for (let i = 0; i < 4; i++) {
    if (run(['bootstrap', domain, plist]) !== null) return true;
    sleep(500);
  }
  return false;
}
