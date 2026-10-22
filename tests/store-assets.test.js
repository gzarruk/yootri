import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/* Images for a third-party app listing, published from assets/store/. They are
   made from assets/example-plan.json, so they carry no personal data; what this
   pins is what a listing form asks for — the sizes and the count. */

const DIR = new URL('../assets/store/', import.meta.url);

/** Width and height from a PNG's header, with no decoder. */
function pngSize(file) {
  const b = readFileSync(new URL(file, DIR));
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is not a PNG`);
  assert.equal(b.subarray(12, 16).toString('ascii'), 'IHDR');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test('the cover is 1200 x 630', () => {
  assert.deepEqual(pngSize('cover.png'), { w: 1200, h: 630 });
});

test('there are three or four screenshots, each 1440 x 900', () => {
  const shots = readdirSync(DIR).filter((f) => /^screenshot-.+\.png$/.test(f));
  assert.ok(shots.length >= 3 && shots.length <= 4, `${shots.length} screenshots`);
  for (const f of shots) assert.deepEqual(pngSize(f), { w: 1440, h: 900 }, f);
});

test('only images live there', () => {
  for (const f of readdirSync(DIR)) assert.match(f, /\.png$/, `${f} is not an image`);
});
