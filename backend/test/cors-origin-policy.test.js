import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedDhanPulsePreview } from '../src/cors-origin-policy.js';

test('allows numbered deploy previews for the exact DhanPulse Netlify site', () => {
  assert.equal(isTrustedDhanPulsePreview('https://deploy-preview-40--spectacular-gaufre-b5c029.netlify.app'), true);
  assert.equal(isTrustedDhanPulsePreview('https://deploy-preview-1234--spectacular-gaufre-b5c029.netlify.app'), true);
});

test('rejects unrelated Netlify sites and lookalike hosts', () => {
  assert.equal(isTrustedDhanPulsePreview('https://deploy-preview-40--attacker.netlify.app'), false);
  assert.equal(isTrustedDhanPulsePreview('https://deploy-preview-40--spectacular-gaufre-b5c029.netlify.app.attacker.test'), false);
  assert.equal(isTrustedDhanPulsePreview('https://other-preview--spectacular-gaufre-b5c029.netlify.app'), false);
  assert.equal(isTrustedDhanPulsePreview('http://deploy-preview-40--spectacular-gaufre-b5c029.netlify.app'), false);
});

test('rejects malformed preview build identifiers and non-string origins', () => {
  assert.equal(isTrustedDhanPulsePreview('https://deploy-preview-abc--spectacular-gaufre-b5c029.netlify.app'), false);
  assert.equal(isTrustedDhanPulsePreview('https://deploy-preview-40x--spectacular-gaufre-b5c029.netlify.app'), false);
  assert.equal(isTrustedDhanPulsePreview(''), false);
  assert.equal(isTrustedDhanPulsePreview(null), false);
  assert.equal(isTrustedDhanPulsePreview(undefined), false);
});
