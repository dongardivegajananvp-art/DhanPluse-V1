import fs from 'node:fs';

const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const productionBackend = 'https://dhanpluse-v1.onrender.com';
const testBackend = 'https://dhanpulse-clean-test.onrender.com';

const checks = [
  ['preview host matcher is tied to the Netlify deploy-preview hostname', app.includes('IS_ISOLATED_TEST_PREVIEW') && app.includes('deploy-preview-') && app.includes('spectacular-gaufre-b5c029') && app.includes('window.location.hostname')],
  ['preview routes to the isolated test backend', app.includes("? '" + testBackend + "'")],
  ['non-preview routes to production backend', app.includes(": '" + productionBackend + "'")],
  ['routing is conditional on isolated preview detection', app.includes('const BACKEND_URL = IS_ISOLATED_TEST_PREVIEW')],
  ['OAuth start is blocked on isolated preview', app.includes("IS_ISOLATED_TEST_PREVIEW && isBackend && pathname === '/api/fyers/auth/start'") && app.includes('OAuth is disabled in this isolated test preview')],
  ['test and production backend origins are distinct', testBackend !== productionBackend]
];

const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + label);
if (failed.length) process.exit(1);
console.log('Preview isolation regression checks passed.');
