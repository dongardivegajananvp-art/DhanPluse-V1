import fs from 'node:fs';

const server = fs.readFileSync(new URL('../backend/src/server.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
const checks = [
  ['backend uses FYERS_REDIRECT_URI first with supported legacy fallbacks', /const redirectUri = \\(process\\.env\\.FYERS_REDIRECT_URI \\|\\| process\\.env\\.FYERS_REDIRECT_URL \\|\\| process\\.env\\.FYERS_REDIRECT \\|\\| ''\\)\\.trim\\(\\)/.test(server)],
  ['authorization request uses exact configured redirect URI', /url\.searchParams\.set\('redirect_uri', redirectUri\)/.test(server)],
  ['authorization request includes state and authorization-code response type', /url\.searchParams\.set\('response_type', 'code'\)[\s\S]{0,120}url\.searchParams\.set\('state', state\)/.test(server)],
  ['state is cryptographically random and expires after ten minutes', /crypto\.randomBytes\(24\)\.toString\('hex'\)/.test(server) && /AUTH_STATE_TTL_MS = 10 \* 60 \* 1000/.test(server)],
  ['exchange requires a valid pending state and consumes it once', /pendingAuthStates\.get\(state\)[\s\S]{0,300}pendingAuthStates\.delete\(state\)/.test(server)],
  ['exchange validates code server-side without exposing app secret to browser', /createHash\('sha256'\)[\s\S]{0,120}\.update\(\`\$\{appId\}:\$\{appSecret\}\`\)/.test(server) && !/appSecret/.test(app)],
  ['callback reads FYERS auth_code and state parameters', /params\.get\('auth_code'\)/.test(app) && /params\.get\('state'\)/.test(app)],
  ['callback removes authorization query from address bar before exchange', /window\.history\.replaceState\(\{\}, document\.title, window\.location\.pathname\)[\s\S]{0,450}\/api\/fyers\/auth\/exchange/.test(app)],
  ['dashboard session token is kept in sessionStorage, not localStorage', /sessionStorage\.setItem\('dhanpulse-dashboard-session-v1'/.test(app) && !/localStorage\.setItem\('dhanpulse-dashboard-session-v1'/.test(app)],
  ['isolated preview refuses to start OAuth before redirect verification', /IS_ISOLATED_TEST_PREVIEW && isBackend && pathname === '\/api\/fyers\/auth\/start'/.test(app) && /OAuth is disabled in this isolated test preview/.test(app)]
];
const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + label);
if (failed.length) process.exit(1);
console.log('Offline OAuth/redirect source checks passed; this does not prove FYERS portal configuration or callback success.');
