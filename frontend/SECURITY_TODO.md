# Security TODO

## 1) Strip sensitive query parameters after parsing
Priority: High

Pages to update:
- `src/routes/(auth)/reset-password/+page.svelte`
- `src/routes/(auth)/verify-email/+page.svelte`
- `src/routes/(auth)/confirm-email-change/+page.svelte`
- `src/routes/(auth)/auth/callback/+page.svelte`

What to do:
- Parse and store `token` / `code` / `state` values first.
- Immediately remove them from the URL (same-page replace, not push).
- Prefer SvelteKit navigation replacement (`goto(..., { replaceState: true })`) to keep router state consistent.

Why:
- Reduces leakage via browser history, screenshots, logs, and accidental sharing.

Acceptance criteria:
- Auth flows still complete successfully.
- URL is clean right after values are captured.

## 2) Add Content Security Policy (CSP)
Priority: High

What to do:
- Add a strict CSP via HTTP response headers (preferred), with meta-tag fallback only if needed.
- Define explicit `default-src`, `script-src`, `style-src`, `img-src`, `connect-src`, `frame-ancestors`, etc.
- Include required API/WebSocket origins in `connect-src`.

Why:
- Limits impact of any future XSS or injection bug.

Acceptance criteria:
- App works in dev/prod with no blocked required resources.
- CSP report/console shows no unexpected violations.

## 3) Enforce secure transport in production
Priority: High

Files:
- `src/lib/api.ts`
- `src/lib/stores/webSocket.ts`

What to do:
- Enforce `https://` API URL in production.
- Enforce `wss://` WebSocket URL in production.
- Fail fast on startup/build when insecure origins are configured for production.

Why:
- Prevents accidental plaintext auth/session traffic due to misconfiguration.

Acceptance criteria:
- Production build/runtime rejects insecure API base URLs.

## 4) Validate backend session security model (server-side)
Priority: High

Current frontend behavior:
- Uses cookie-based auth with `credentials: 'include'`.
- Does not send user ID as auth material.

What to verify on backend:
- Session is server-validated (opaque random session ID or signed token), not client-trusted user fields.
- Cookies are `HttpOnly`, `Secure`, and `SameSite` (`Lax` or `Strict` as appropriate).
- Session IDs/tokens are unforgeable and rotated on login/privilege changes.
- Logout invalidates session server-side.
- Session fixation protections are in place.

Why:
- Prevents user spoofing and session tampering.

Acceptance criteria:
- Attempting to alter client-side identifiers (user id/email in requests/local state) does not change authenticated identity.

## 5) CSRF defenses for state-changing endpoints (server-side)
Priority: High

Why this matters:
- Frontend sends cookies cross-origin capable (`credentials: 'include'`, SSE `withCredentials: true`).

What to verify/add on backend:
- Enforce `SameSite` cookies.
- Validate `Origin`/`Referer` on mutating requests.
- Add CSRF token protection where needed.

Acceptance criteria:
- Cross-site forged POST/PATCH/DELETE requests are rejected.

## 6) JWT decision (optional architecture choice)
Priority: Medium

Guidance:
- JWT is optional; secure opaque server sessions are sufficient.
- If adopting JWT, require strong signature verification and claim checks (`exp`, `iss`, `aud`, etc.).
- Prefer storing JWT in `HttpOnly` cookie over web storage.

Why:
- Signed tokens prevent tampering, but do not replace secure session/cookie/CSRF practices.

Acceptance criteria:
- Auth model is documented and threat-modeled.
- Implementation proves user identity cannot be spoofed by client-side edits.

## 7) Regression tests and verification
Priority: Medium

Add tests/checks for:
- Query param stripping does not break auth/reset/verify flows.
- Callback pages work after URL cleanup.
- Unauthorized requests are rejected when cookie/session missing or invalid.
- CSRF attempts fail.

Operational checks:
- Security headers (including CSP) present in production responses.
- No sensitive tokens appear in browser history after successful flows.
