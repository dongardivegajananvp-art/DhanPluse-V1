# GV2VPD Mobile App Login

This change adds a separate mobile-number + SMS OTP gate before the existing FYERS-authenticated workstation.

## Render environment

Keep all values in the Render backend environment, never in GitHub source, browser JavaScript, or chat:

- `DATABASE_URL` — existing PostgreSQL connection used by the FYERS token store. App Login creates its own `gv2vpd_app_*` tables in this database.
- `MSG91_AUTHKEY` — MSG91 API authkey.
- `MSG91_OTP_TEMPLATE_ID` — the approved MSG91 OTP template ID. The template must contain the `##OTP##` placeholder.
- `GV2VPD_ALLOWED_MOBILE` — the single owner mobile number authorized to receive OTPs, as 10 digits or `+91` followed by 10 digits. This allowlist is mandatory; unapproved numbers are rejected.

Only the owner-allowlisted mobile can sign in; open registration is disabled to prevent another verified phone from accessing the single configured FYERS broker account. The MSG91 account must be enabled for the OTP API, and the SMS sender/template must meet Indian DLT requirements. Check MSG91 IP security rules if Render's outbound IP is not allowed. Do not disable provider-side security without understanding the account's access policy.

## Login behavior

1. The existing Pages app displays the GV2VPD mobile login gate.
2. Backend sends a six-digit OTP through MSG91 with a five-minute expiry.
3. Backend verifies the code directly with MSG91; an HTTP 200 alone is not accepted as success.
4. On success, backend creates/updates the phone user and issues a random 256-bit app-session token. Only its SHA-256 hash is stored in PostgreSQL.
5. App sessions expire after 12 hours. A new login replaces the prior session for that mobile.
6. OTP sends are limited to one per 60 seconds and five per day per mobile. Five failed verification attempts lock that mobile for 15 minutes.
7. All private API routes except health/status, OTP bootstrap/session-check routes, and the public read-only NSE F&O symbol master require the GV2VPD app-session header. Existing FYERS bearer-session protection remains in place for market, options and account endpoints.

## Required validation before production use

- Set the three Render environment values and restart the backend.
- Confirm PostgreSQL tables initialize successfully.
- Test a real SMS send, correct OTP, incorrect OTP, expired OTP, resend cooldown, daily limit, failed-attempt lock, session expiry and logout/revocation.
- Confirm a fresh browser without an App Login session cannot call FYERS OAuth, quotes, candles, options, holdings or positions.
- Confirm a verified App Login still requires the separate FYERS OAuth login before private market/account endpoints work.

The GitHub Pages branch is not production. Merge and deploy only after CI passes and the real MSG91 + Render integration is tested. Order placement remains disabled/read-only.