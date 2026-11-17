import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));

test('GV2VPD PWA declares installable branded 192px and 512px icons', async () => {
  assert.equal(manifest.name, 'GV2VPD Live Trading Workstation');
  assert.equal(manifest.short_name, 'GV2VPD');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const file = await readFile(new URL(icon.src.replace(/^\//, ''), import.meta.url), 'utf8');
    assert.match(file, /<svg[^>]+viewBox="0 0 512 512"/);
  }
});

test('workstation HTML references the GV2VPD branded install icon', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/gv2vpd-192\.svg"/);
  assert.match(html, /name="application-name" content="GV2VPD"/);
});
