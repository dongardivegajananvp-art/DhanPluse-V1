import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFyersUpstreamFailure } from '../src/fyers-upstream-diagnostics.js';

test('extracts Cloudflare error code and safe response metadata from an HTML 429', () => {
  const summary = summarizeFyersUpstreamFailure({
    responseText: '<html><head><title>Access denied</title></head><body>Cloudflare Error 1020. Ray ID abc</body></html>',
    headers: new Headers({
      'content-type': 'text/html; charset=UTF-8',
      'cf-ray': 'abc123-SIN',
      server: 'cloudflare',
      'retry-after': '0'
    })
  });
  assert.equal(summary.cloudflareErrorCode, '1020');
  assert.equal(summary.responseTitle, 'Access denied');
  assert.equal(summary.cloudflareRayId, 'abc123-SIN');
  assert.equal(summary.upstreamServer, 'cloudflare');
  assert.match(summary.responseBodyPreview, /Cloudflare Error 1020/);
});

test('preserves FYERS JSON error code without inventing a Cloudflare code', () => {
  const summary = summarizeFyersUpstreamFailure({
    responseText: JSON.stringify({ s: 'error', code: -360, message: 'Rate limit exceeded' }),
    headers: new Headers({ 'content-type': 'application/json' }),
    apiCode: -360
  });
  assert.equal(summary.apiCode, '-360');
  assert.equal(summary.cloudflareErrorCode, null);
  assert.match(summary.responseBodyPreview, /Rate limit exceeded/);
});

test('bounds response preview and handles an empty gateway body', () => {
  const summary = summarizeFyersUpstreamFailure({ responseText: 'x'.repeat(1000), headers: new Headers() });
  assert.equal(summary.responseBodyPreview.length, 320);
  assert.equal(summarizeFyersUpstreamFailure({}).responseBodyPreview, null);
});
