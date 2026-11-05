import test from 'node:test';
import assert from 'node:assert/strict';
import { reload } from '../tools/launchd.mjs';

// launchd's bootout returns before the job is gone: until then the service still prints, and a
// bootstrap is refused with `Input/output error`.
const slowLaunchctl = (polls) => {
  const calls = []; let down = 0; let loaded = true;
  const run = (args) => {
    calls.push(args[0]);
    if (args[0] === 'bootout') { down = polls; return ''; }
    if (args[0] === 'print') { if (down > 0) { down--; return 'loaded'; } return loaded ? 'loaded' : null; }
    if (args[0] === 'bootstrap') { if (down > 0) return null; loaded = true; return ''; }
    return '';
  };
  return { run, calls, get loaded() { return loaded; } };
};

test('a running agent is reloaded only after launchd has finished unloading it', () => {
  const l = slowLaunchctl(3);
  const ok = reload({ domain: 'gui/501', label: 'com.x', plist: '/p', run: l.run, sleep: () => {} });
  assert.equal(ok, true);
  const verbs = l.calls;
  assert.ok(verbs.indexOf('bootout') < verbs.lastIndexOf('print'));
  assert.ok(verbs.lastIndexOf('print') < verbs.indexOf('bootstrap'));
});

test('a bootstrap that is refused for good gives up and says false', () => {
  const run = (args) => (args[0] === 'bootstrap' ? null : args[0] === 'print' ? null : '');
  assert.equal(reload({ domain: 'gui/501', label: 'com.x', plist: '/p', run, sleep: () => {} }), false);
});

test('installing for the first time does not wait for anything', () => {
  const calls = [];
  const run = (args) => { calls.push(args[0]); return args[0] === 'print' ? null : ''; };
  assert.equal(reload({ domain: 'gui/501', label: 'com.x', plist: '/p', run, sleep: () => { throw new Error('no wait'); } }), true);
});
