import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIndianMobile, createAppAuth } from '../src/app-auth.js';

test('normalizes Indian owner mobile formats', () => {
  assert.equal(normalizeIndianMobile('9876543210'), '919876543210');
  assert.equal(normalizeIndianMobile('+91 98765 43210'), '919876543210');
  assert.equal(normalizeIndianMobile('919876543210'), '919876543210');
});

test('rejects malformed and non-Indian mobile numbers', () => {
  for (const value of ['', '1234567890', '987654321', '12345678901', '+1 202 555 0199', 'abcd987654']) {
    assert.equal(normalizeIndianMobile(value), '');
  }
});

test('App Login is fail-closed when persistent storage and owner allowlist are absent', async () => {
  const auth = createAppAuth({ databaseUrl: '', msg91AuthKey: '', msg91OtpTemplateId: '' });
  assert.equal(auth.configured, false);
  assert.equal(auth.msg91Configured, false);
  assert.equal(auth.allowedMobileConfigured, false);
  let status = 0;
  let payload = null;
  const res = {
    status(code) { status = code; return this; },
    json(value) { payload = value; return this; }
  };
  await auth.requireSession({ method: 'GET', path: '/private', get: () => '' }, res, () => {
    assert.fail('next() must not be called when App Login storage is unconfigured');
  });
  assert.equal(status, 503);
  assert.match(payload.error, /not configured/i);
  await auth.close();
});

test('App Login requires an explicit owner mobile allowlist', async () => {
  const auth = createAppAuth({
    databaseUrl: 'postgresql://user:password@127.0.0.1:5432/gv2vpd_test',
    msg91AuthKey: 'test-authkey',
    msg91OtpTemplateId: 'test-template',
    allowedMobile: '+91 98765 43210'
  });
  assert.equal(auth.configured, true);
  assert.equal(auth.msg91Configured, true);
  assert.equal(auth.allowedMobileConfigured, true);
  await auth.close();
});
