import fs from 'node:fs';

const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const previewHost = 'deploy-preview-40--spectacular-gaufre-b5c029.netlify.app';
const productionBackend = 'https://dhanpluse-v1.onrender.com';
const testBackend = 'https://dhanpulse-clean-test.onrender.com';

const checks = [
  ['isolated preview hostname matcher exists', /const IS_ISOLATED_TEST_PREVIEW = \/\^deploy-preview-\\\\d\+--spectacular-gaufre-b5c029\\\\\.netlify\\\\\.app\$\//.test(app)],
  ['preview routes to the isolated test backend', app.includes("? '" + testBackend + "'") && app.includes(" : '" + productionBackend + "'")],
  ['production backend remains the non-preview default', app.includes("const BACKEND_URL = IS_ISOLATED_TEST_PREVIEW") && app.includes("'" + productionBackend + "'")],
  ['OAuth start is blocked on isolated preview', app.includes("IS_ISOLATED_TEST_PREVIEW && isBackend && pathname === '/api/fyers/auth/start'") && app.includes('OAuth is disabled in this isolated test preview')],
  ['preview backend is not the production backend', testBackend !== productionBackend],
  ['preview hostname uses the intended Netlify deploy-preview origin', previewHost.startsWith('deploy-preview-') && previewHost.endsWith('.netlify.app')]
];

const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + label);
if (failed.length) process.exit(1);
console.log('Preview isolation regression checks passed.');
