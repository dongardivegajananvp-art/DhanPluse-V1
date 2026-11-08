import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIndianMobile, createAppAuth } from '../src/app-auth.js';

test('normalizes Indian mobile numbers to international format', () => {
  assert.equal(normalizeIndianMobile('9876543210'), '919876543210');
  assert.equal(normalizeIndianMobile('+91 98765 43210'), '919876543210');
  assert.equal(normalizeIndianMobile('919876543210'), '919876543210');
});

test('rejects invalid or non-Indian mobile numbers', () => {
  for (const value of ['', '1234567890', '987654321', '12345678901', '+1 202 555 0199', 'abcd987654']) {
    assert.equal(normalizeIndianMobile(value), '');
  }
});

test('fails closed when persistent storage and MSG91 are not configured', () => {
  const auth = createAppAuth({ databaseUrl: '', msg91AuthKey: '', msg91OtpTemplateId: '' });
  assert.equal(auth.configured, false);
  assert.equal(auth.msg91Configured, false);
});
