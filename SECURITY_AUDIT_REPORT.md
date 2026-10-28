# StayCraft PMS — Comprehensive Evidence-Based Security Audit Report

- **Audit Date**: `2026-10-25` (UTC)
- **Target System**: StayCraft PMS (`v1.0.0`, Phases 1–7, Migrations `001`–`008`)
- **Isolated Environments Used**:
  - Automated Unit, Integration, Security & Browser E2E Suite: `staycraft_pms_test` (`current_database()` verified fail-closed before every individual test)
  - Live Preview Verification: `staycraft_pms_preview` (`http://0.0.0.0:3000`)
  - Production Database (`staycraft_pms`): **Untouched (`numbackends = 0`, `xact_commit = 0`, `xact_rollback = 0`, `tup_inserted = 0`, `tup_updated = 0`, `tup_deleted = 0`)**
- **Audit Determination**: **CONDITIONAL RELEASE RECOMMENDATION (Non-Production Ready; Production Release Contingent on Pre-Production Infrastructure & SemVer-Major Dependency Gates)**
  > **Important Notice**: *This report is an evidence-based point-in-time security assessment conducted within an isolated sandbox environment. It does **not** constitute an unconditional security certification or guarantee of immunity from vulnerabilities.*

---

## 1. Executive Summary & Audit Methodology

The audit followed a strict four-stage methodology:

1. **Phase A — Strictly Read-Only Static & Architectural Inspection**: Full line-by-line review of Express middleware (`src/server/app.ts`, `src/server/index.ts`, `src/server/middleware/{auth,errorHandler}.ts`), cryptographic helpers (`src/server/security/password.ts`), database safety guards (`src/server/config.ts`, `src/server/db/{pool,migrate,seed,ensure-admin}.ts`), all 14 domain routers and services (`src/server/modules/**`), shared Zod schemas (`src/shared/schemas.ts`), React SPA client code (`src/client/**`), SQL migrations (`migrations/001`–`008`), and test suites (`tests/*.test.ts`).
2. **Phase B — Safe Read-Only Baseline Verification**: Verified zero activity on `staycraft_pms` via `pg_stat_database` connected strictly to `-d postgres`, inspected PostgreSQL engine settings (`wal_level`, `archive_mode`, `ssl`, `password_encryption`), captured `npm audit --json` and `npm audit --omit=dev --json` advisories, and ran baseline `npm run typecheck` and `npm run lint`.
3. **Phase C — Minimal Surgical Remediation & Fail-Closed Test Guarding**: Applied minimal, targeted code remediations for 9 confirmed findings without altering `migrations/001`–`008` or existing PMS workflows, added a global fail-closed per-test `current_database() === 'staycraft_pms_test'` guard (`tests/setup-db-guard.ts`), and added synthetic-data-only regression tests (`tests/security.audit.test.ts`).
4. **Phase D — Automated Verification & Live Preview Validation**: Executed `npm run typecheck`, `npm run lint`, `npm run build`, all `11` Vitest + Playwright Chromium test suites (`127/127` passing on `staycraft_pms_test`), live preview header/CSP/browser checks on `staycraft_pms_preview`, and post-run `pg_stat_database` verification confirming zero connections or transactions on `staycraft_pms`.

---

## 2. Severity-Ranked Findings, Evidence, Remediation & Test Coverage

| ID | Severity | Domain | Summary | Status |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | **HIGH** | 6. CSRF | Cookie-authenticated state-changing endpoints lacked `Origin`/`Referer`/`Sec-Fetch-Site` and form `Content-Type` CSRF defenses (`SameSite=None; Secure` cookie mode) | **REMEDIATED & VERIFIED** |
| **SEC-02** | **HIGH** | 12. CORS / Session Exposure | Wildcard `*.e2b.app` / `*.e2b.dev` credentialed CORS (`Access-Control-Allow-Credentials: true`) allowed cross-sandbox origins; `/api/*` lacked `Cache-Control: no-store` | **REMEDIATED & VERIFIED** |
| **SEC-03** | **HIGH** *(Advisory)* | 11. Dependencies (`zod`, `react-router-dom`) | `zod@3.24.2` (`GHSA-mrhx-c7xc-m3w5`, High) oversized collection memory exhaustion & `react-router-dom@6.28.1` (`GHSA-wrjc-x8rr-h8h6`, Moderate) backslash open redirect in `LoginPage.tsx` | **MITIGATED IN RUNTIME; SEMVER-MAJOR UPGRADE TRACKED** |
| **SEC-04** | **MEDIUM** | 1. Authentication | `POST /api/auth/login` lacked brute-force rate limiting, unbounded password length (`>256` chars into `scrypt`), and constant-work dummy `scrypt` verification on missing/inactive emails | **REMEDIATED & VERIFIED** |
| **SEC-05** | **MEDIUM** | 1 & 10. Admin Provisioning | `ensure-admin.ts` lacked a `current_database()` guard and fell back to hardcoded `'Admin@12345'` when `ADMIN_PASSWORD` was unset even in `NODE_ENV=production` | **REMEDIATED & VERIFIED** |
| **SEC-06** | **MEDIUM** | 7. Input Validation | Unvalidated numeric query parameters (`page`, `pageSize`, `minCapacity`) and malformed JSON caused `NaN` / PostgreSQL `22003` integer-overflow `500` errors | **REMEDIATED & VERIFIED** |
| **SEC-07** | **MEDIUM** *(Dev/Infra)* | 11 & 13. Dev Dependencies & Backups | Dev-only `vitest@3` / `tinypool` / `postcss-selector-parser` advisories; local PostgreSQL runs with `archive_mode=off`, `ssl=off`, and no automated offsite PITR backups | **DOCUMENTED / PRE-PROD GATE** |
| **SEC-08** | **LOW** | 3. Cross-Property UI Scoping | `StaffPage.tsx` passed `propertyId` instead of `filterPropertyId` to `GET /api/users`, surfacing users without access to the selected property in the unlinked-logins banner | **REMEDIATED & VERIFIED** |
| **SEC-09** | **LOW** | 12. Security Headers | `X-Powered-By: Express` exposed; missing `Content-Security-Policy`, `Permissions-Policy`, and `X-Permitted-Cross-Domain-Policies` | **REMEDIATED & VERIFIED** |
| **SEC-10** | **LOW** | 13. Logging & Docs | `errorHandler.ts` logged raw `err` objects without `sanitizeErrorForLog`; Bearer/cookie tokens were not redacted; `README.md` showed legacy `staycraft_pms` default URL | **REMEDIATED & VERIFIED** |

---

### Detailed Finding Records

#### [SEC-01] HIGH — Missing Server-Side CSRF Protection on Cookie-Authenticated State-Changing Routes
- **Evidence**:
  - `src/server/modules/auth/auth.routes.ts:58-74` issues `SameSite=None; Secure; Partitioned` cookies over HTTPS for cross-site preview compatibility.
  - `src/server/middleware/auth.ts:76-82` accepts `req.cookies[config.sessionCookieName]` alone when `Authorization` / `X-Session-Token` headers are absent.
  - Pre-remediation `src/server/app.ts` had no `Origin`, `Referer`, `Sec-Fetch-Site`, or form `Content-Type` enforcement on `POST`/`PUT`/`PATCH`/`DELETE`, leaving bodyless or default-schema endpoints (`/api/auth/logout`, `/api/reservations/:id/check-in`, `/api/reservations/:id/cancel`, `/api/invoices/:id/issue`, `/api/rpc`) vulnerable to cross-site cookie request forgery.
- **Remediation**:
  - Added `/api` CSRF middleware in `src/server/app.ts` blocking `application/x-www-form-urlencoded`, `multipart/form-data`, and `text/plain` on unsafe HTTP methods (`403 CSRF_REJECTED`) and enforcing `isTrustedRequestOrigin` against `Origin`, `Referer`, and `Sec-Fetch-Site` headers while preserving same-host and `https://arena.ai` preview traffic.
- **Test Coverage**: `tests/security.audit.test.ts` Test `2` (verifies `403 CSRF_REJECTED` across external `Origin`, `Origin: null`, external `Referer`, `Sec-Fetch-Site: cross-site`, `application/x-www-form-urlencoded`, and `POST /api/rpc`, while verifying `https://arena.ai` succeeds).

#### [SEC-02] HIGH — Overly Broad Multi-Tenant `*.e2b.app` Credentialed CORS & Missing `Cache-Control: no-store` on `/api/*`
- **Evidence**:
  - Pre-remediation `isAllowedCorsOrigin` (`src/server/app.ts:28-43`) matched `host.endsWith('.e2b.app')` and `host.endsWith('.e2b.dev')` unconditionally with `Access-Control-Allow-Credentials: true`, allowing *other* E2B sandboxes (`https://3000-attacker.e2b.app`) to make credentialed cross-origin requests where `GET /api/auth/me` returns `sessionToken`.
  - `/api/*` responses lacked `Cache-Control: no-store`, risking intermediate/browser caching of `sessionToken`, guest PII, and financial reports.
- **Remediation**:
  - Replaced `isAllowedCorsOrigin` with `isTrustedRequestOrigin(origin, req)` in `src/server/app.ts`: `.e2b.app`/`.e2b.dev` origins are trusted **only** on exact same-host match (`parsed.host.toLowerCase() === requestHost`), `arena.ai`/`lmarena.ai` require `https:`, and `localhost`/`127.0.0.1` are restricted to `config.nodeEnv !== 'production'`.
  - Added `Cache-Control: no-store, no-cache, must-revalidate, private` and `Pragma: no-cache` on all `/api` responses.
- **Test Coverage**: `tests/security.audit.test.ts` Test `3` (verifies cross-sandbox `Origin: https://3000-attacker-sandbox.e2b.app` against `Host: 3000-victim-sandbox.e2b.app` receives zero CORS headers and `403 CSRF_REJECTED` on `POST`, while same-host receives CORS + `Cache-Control: no-store`).

#### [SEC-03] HIGH (Advisory Mitigated in Runtime) — `zod@3.24.2` (`GHSA-mrhx-c7xc-m3w5`) & `react-router-dom@6.28.1` (`GHSA-wrjc-x8rr-h8h6`)
- **Evidence**:
  - `npm audit --omit=dev --json` flagged:
    1. `zod@3.24.2` (`GHSA-mrhx-c7xc-m3w5`, High, CVSS 7.5): memory exhaustion when validating huge arrays/objects against constrained schemas prior to `zod@4.6.6`.
    2. `react-router` / `react-router-dom@6.28.1` (`GHSA-wrjc-x8rr-h8h6`, Moderate): open redirect via backslash paths (`/\evil.example`) in `<Navigate>`/`<Link>`/`useNavigate`. Static inspection of `src/client/pages/LoginPage.tsx:16-22` confirmed `redirectTarget` checked `rawFrom.startsWith('/') && !rawFrom.startsWith('//')` without rejecting `\` (`/\evil.example` passed!). (`GHSA-337j-9hxr-rhxg` affects React Router SSR `deserializeErrors()`, which is unused in this CSR SPA.)
- **Remediation**:
  - Neutralized `GHSA-mrhx-c7xc-m3w5` at the Express ingress layer (`src/server/app.ts`): reduced `express.json` limit from `1mb` to `100kb` and added `assertBoundedJsonValue` rejecting JSON payloads with depth `> 10`, array length `> 200`, or object keys `> 100` before any Zod schema executes.
  - Neutralized `GHSA-wrjc-x8rr-h8h6` in `src/shared/navigation.ts` (`sanitizeInternalRedirectPath`) wired into `src/client/pages/LoginPage.tsx`: rejects backslashes (`\`), control characters, `//`, `/login`, and any URL resolving outside same-origin.
  - Planned SemVer-major migrations (`zod@^4.6.7`, `react-router-dom@^7.18.4`) are tracked as pre-production release items rather than risking invasive multi-file breaking API changes during minimal remediation.
- **Test Coverage**: `tests/security.audit.test.ts` Tests `6` and `7`.

#### [SEC-04] MEDIUM — Login Brute-Force Exposure, Unbounded Scrypt Input & User-Enumeration Timing Side-Channel
- **Evidence**:
  - `POST /api/auth/login` (`src/server/modules/auth/auth.routes.ts`) had no rate limiting.
  - `loginSchema.password` (`src/shared/schemas.ts:45`) lacked `.max(256)`, allowing ~1 MB strings into `crypto.scrypt`.
  - Missing/inactive emails returned `401` immediately without running `scrypt`, creating a ~40 ms timing discrepancy vs active accounts.
- **Remediation**:
  - Capped `loginSchema.password` at `.max(256)` and enforced `MAX_PASSWORD_LENGTH = 256` in `src/server/security/password.ts`.
  - Added precomputed `DUMMY_PASSWORD_HASH` verification on missing/inactive accounts in `src/server/modules/auth/auth.routes.ts` and opportunistic cleanup of expired `user_sessions` rows on login.
  - Added sliding-window failed-login rate limiting (`10` failed attempts / `15m` per IP+email; `30` failed attempts / `15m` per IP -> `429 RATE_LIMITED` + `Retry-After` header). *Note: In-memory limiter protects single-node deployments; multi-replica production deployments require shared Redis/PostgreSQL rate limiting.*
- **Test Coverage**: `tests/security.audit.test.ts` Test `4`.

#### [SEC-05] MEDIUM — Missing `current_database()` Check & Production Default-Password Fallback in `ensure-admin.ts`
- **Evidence**:
  - Unlike `migrate.ts` and `seed.ts`, `src/server/db/ensure-admin.ts` did not verify `SELECT current_database()` against `NODE_ENV=test` / `STAYCRAFT_DB_ROLE=preview` / non-production `staycraft_pms`, and fell back to `'Admin@12345'` when `ADMIN_PASSWORD` was omitted even in `NODE_ENV=production`.
- **Remediation**:
  - Added `assertAdminTargetAuthorized(db, env)` in `src/server/db/ensure-admin.ts` and blocked provisioning or resetting an admin password in real production (`NODE_ENV=production` outside `STAYCRAFT_DB_ROLE=preview`, or `staycraft_pms`) unless an explicit non-default `ADMIN_PASSWORD` (`>= 12` chars) is supplied.
- **Test Coverage**: `tests/security.audit.test.ts` Test `5` + `tests/admin-migration-safety.test.ts`.

#### [SEC-06] MEDIUM — Unvalidated Numeric Query Parameters & Malformed JSON Returning `500`
- **Evidence**:
  - `guests.routes.ts`, `reservations.routes.ts`, `invoices.routes.ts`, and `rooms.routes.ts` used `Number(req.query.page)` / `Number(req.query.minCapacity)`, allowing `NaN`, `Infinity`, and `bigint` overflow (`SQLSTATE 22003`) to bypass validation and trigger `500`. Malformed JSON (`entity.parse.failed`) and oversized bodies (`entity.too.large`) in `errorHandler.ts` also fell through to `500`.
- **Remediation**:
  - Exported `parsePositiveIntQuery` and `22003` mapping in `src/server/errors.ts`, applied it across `guests`, `reservations`, `invoices`, and `rooms` routers, and normalized `entity.parse.failed` (`400`) and `entity.too.large` (`413`) in `src/server/middleware/errorHandler.ts`.
- **Test Coverage**: `tests/security.audit.test.ts` Test `6`.

#### [SEC-07] MEDIUM (Dev Dependencies & Production Infrastructure Gate) — Dev Tooling Advisories & Unconfigured Offsite PITR Backups
- **Evidence**:
  - Dev-only `npm audit` findings (`vitest@3.2.7` / `tinypool` / `@vitest/mocker` GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr, GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8; `tailwindcss@3.4.17` / `postcss-selector-parser` GHSA-rj75-hqrm-r3gf) affect local test/build devDependencies only and are **not** shipped in production runtime (`NODE_ENV=production node dist/server/server/index.js`).
  - Baseline PostgreSQL settings query (`pg_settings` from `-d postgres`) confirmed `password_encryption = scram-sha-256` and `wal_level = replica`, but `archive_mode = off` and `ssl = off` on the local loopback sandbox cluster, with no automated offsite backup shipping configured (cloud backup integration and production infrastructure changes were explicitly out of scope per operational guardrails).
- **Remediation**: Documented safe `pg_dump` + SHA-256 + isolated `pg_restore` verification runbook and PITR/TLS pre-production requirements in `README.md`.

#### [SEC-08] LOW — Cross-Property User Filter Mismatch on `StaffPage.tsx`
- **Evidence**: `src/client/pages/StaffPage.tsx:222` passed `propertyId` (consumed by `requirePropertyContext`) instead of `filterPropertyId` (`users.routes.ts:28`), causing `/api/users` to return users across all properties and display KHB-only users in EHS's unlinked-logins banner.
- **Remediation**: Updated `StaffPage.tsx` to pass `filterPropertyId` and filter `unlinkedActivePropertyUsers` by `u.role === 'admin' || u.propertyAccess.some(pa => pa.propertyId === selectedProperty.id)`.
- **Test Coverage**: `tests/security.audit.test.ts` Test `8` + live headless Chromium verification switching `KHB` -> `EHS`.

#### [SEC-09] LOW — Missing Defensive HTTP Security Headers & `X-Powered-By` Disclosure
- **Evidence**: Both `src/server/app.ts` and `src/server/index.ts` emitted `X-Powered-By: Express` and lacked `Content-Security-Policy`, `Permissions-Policy`, and `X-Permitted-Cross-Domain-Policies`.
- **Remediation**: Disabled `x-powered-by` on both Express apps; added `Permissions-Policy`, `X-Permitted-Cross-Domain-Policies: none`, and a preview-compatible `Content-Security-Policy` (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'`, intentionally omitting frame-blocking directives so Arena's iframe preview functions cleanly).
- **Test Coverage**: `tests/security.audit.test.ts` Test `3` + `curl -sSI` & headless Chromium CSP verification on `staycraft_pms_preview`.

#### [SEC-10] LOW — Unsanitized Error Logging in `errorHandler.ts` & Stale `.env` Documentation
- **Evidence**: `src/server/middleware/errorHandler.ts:54` passed raw `err` to `console.error`, and `redactConnectionStrings` only redacted `postgres://` URLs (not `Bearer` or `staycraft_session` tokens). `README.md` listed `staycraft_pms` as a default `DATABASE_URL`.
- **Remediation**: Extended `redactConnectionStrings` / `sanitizeErrorForLog` in `src/server/config.ts` to redact PostgreSQL URLs, `Bearer` tokens, and `staycraft_session` / `X-Session-Token` values; updated `errorHandler.ts` to log `sanitizeErrorForLog(err)` only; updated `README.md`.
- **Test Coverage**: `tests/security.audit.test.ts` Test `9`.

---

## 3. Domain-by-Domain Audit Summary (All 13 Scope Areas)

1. **Authentication & Sessions**: Passwords hashed via `crypto.scrypt` (`64`-byte key, random `16`-byte salt) and verified via `crypto.timingSafeEqual`. Opaque `256`-bit random session tokens (`crypto.randomBytes(32)`) stored only as `SHA-256` digests (`user_sessions.token_hash`). Sessions immediately invalidated on logout, user deactivation (`PUT /api/users/:id`), and password reset (`POST /api/users/:id/reset-password` & `ensure-admin --reset`). Hardened in this audit with `.max(256)` password cap, dummy `scrypt` timing-oracle protection, failed-login rate limiting (`429`), and expired session pruning (**SEC-04**, **SEC-05**).
2. **Server-Side Role Authorization (RBAC)**: Verified across all 14 route modules. Structural, financial-reversal, catalog, inventory-adjustment, staff-mutation, and user-management endpoints enforce `requireRole('admin')` at the router and/or service layer (`properties`, `rooms`, `room-types`, `out-of-service`, `restore-service`, `invoices/:id/void`, `invoices/:id/items/:itemId`, `restaurant/categories`, `restaurant/menu-items`, `orders/:id/reverse-charge`, `inventory/categories`, `inventory/items`, `inventory/adjustments`, `suppliers`, `expenses/categories`, `expenses/:id`, `expenses/:id/void`, `services/catalog`, `staff`, `users`, plus admin-only manual room/discount/adjustment folio items and blocking maintenance requests). Self-demotion/deactivation of the last active admin is blocked under transaction lock (`ensureRemainingActiveAdminExistsInTx`).
3. **Cross-Property Isolation**: `requirePropertyContext` (`src/server/middleware/auth.ts`) validates UUID format, active property status, and `user_property_access` membership on every property-scoped route (`403 FORBIDDEN` when unauthorized). Every domain SQL query filters by `property_id = $1`. Fixed `StaffPage.tsx` `filterPropertyId` query scoping (**SEC-08**).
4. **SQL Injection**: Audited all `.query(` call sites across `src/server/`. 100% of user values use parameterized `$1..$n` bindings; dynamic `ORDER BY` in `reservations.service.ts` uses a strict static allowlist (`allowedSortColumns`) and boolean ternaries (`ASC`/`DESC`). Verified with SQLi payloads in `tests/security.audit.test.ts`.
5. **Cross-Site Scripting (XSS)**: Scanned `src/client/` for `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `document.write`, `eval`, `new Function`, and unsafe `href=` schemes (`0` matches). All dynamic text renders through React JSX auto-escaping; post-login redirect path hardened via `sanitizeInternalRedirectPath` (**SEC-03**) and production responses carry `Content-Security-Policy` (`script-src 'self'; object-src 'none'`, **SEC-09**).
6. **Cross-Site Request Forgery (CSRF)**: Remediated cookie-mode CSRF across all unsafe `/api` methods and `/api/rpc` (**SEC-01**) and locked down cross-sandbox `*.e2b.app` CORS (**SEC-02**).
7. **Input Validation**: All write bodies validated via strict Zod schemas (`src/shared/schemas.ts`); route/query UUIDs validated via `parseUuidParam` / `parseOptionalUuidQuery`; pagination/capacity integers standardized on `parsePositiveIntQuery`; JSON body capped at `100kb` and pre-Zod structural complexity bounded (**SEC-03**, **SEC-06**).
8. **Insecure Direct Object References (IDOR)**: Every entity lookup, update, transition, and foreign-key link (`guestId`, `roomId`, `roomTypeId`, `reservationId`, `invoiceId`, `categoryId`, `supplierId`, `productId`, `serviceId`, `assignedTo`, `assignedStaffId`, `userId`) scopes queries by both `id` AND `property_id` (returning `404`/`400` on cross-tenant UUIDs). Verified in `tests/security.audit.test.ts` Test `8`.
9. **Business & Financial Integrity**: PostgreSQL `btree_gist` exclusion constraint (`excl_reservations_no_room_overlap`) + `SELECT ... FOR UPDATE` row locks prevent double-booking, concurrent folio overpayments (`OVERPAYMENT_NOT_ALLOWED`), negative inventory stock, and duplicate folio postings (`uq_invoice_items_source_key`, idempotency keys). Paid/partially-paid invoices cannot be voided without explicit refund handling; unpaid/partially-paid invoices are never auto-marked `paid`; historical invoices/payments are never mutated by reports; reports explicitly disclose net operational cashflow is not audited profit; `audit_events` is append-only across all modules.
10. **Migration & Seed Safety**: `migrations/001`–`008` preserved intact. `resolveDatabaseUrl` (`config.ts`) never defaults to `staycraft_pms`. `runMigrations` (`migrate.ts`) blocks `staycraft_pms` and `NODE_ENV=production` unless `ALLOW_PRODUCTION_MIGRATIONS === 'true'`. `seedDatabase` (`seed.ts`) **unconditionally** blocks `staycraft_pms` regardless of flags. `ensureInitialAdminAccount` (`ensure-admin.ts`) decoupled from migrations and hardened with `assertAdminTargetAuthorized` (**SEC-05**). `tests/setup-db-guard.ts` verifies `current_database() === 'staycraft_pms_test'` fail-closed before every test.
11. **Dependencies**: Full `npm audit` (`9` total: `3` prod, `6` dev) analyzed; runtime mitigations deployed and tested for `GHSA-mrhx-c7xc-m3w5` (`zod`) and `GHSA-wrjc-x8rr-h8h6` (`react-router-dom`). SemVer-major upgrades (`zod@4.6.7`, `react-router-dom@7.18.4`, `vitest@4.1.12`, `tailwindcss@4.3.3`) documented as pre-production upgrade items.
12. **Security Headers**: Verified live on `http://127.0.0.1:3000/`: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Permitted-Cross-Domain-Policies: none`, `Cache-Control: no-store` on `/api/*`, and `X-Powered-By` removed (**SEC-02**, **SEC-09**).
13. **Logs & Backup/Recovery Configuration**: `errorHandler.ts` and CLI scripts log only `sanitizeErrorForLog(err)` with connection URL, Bearer token, and session cookie redaction (**SEC-10**). Backup/PITR runbook documented in `README.md` (**SEC-07**).

---

## 4. Executed Commands & Observed Results

| Check | Exact Command Executed | Target Environment | Observed Result |
| :--- | :--- | :--- | :--- |
| Pre-Audit DB Baseline | `psql -h /home/user/data/pgrun -p 5432 -U postgres -d postgres -c "SELECT datname, numbackends, xact_commit, xact_rollback, tup_inserted, tup_updated, tup_deleted FROM pg_stat_database WHERE datname LIKE 'staycraft%';"` | PostgreSQL catalog (`-d postgres`) | `staycraft_pms`: `0` backends, `0` commits, `0` tuples modified |
| Dependency Audit | `npm audit --json` & `npm audit --omit=dev --json` | Lockfile (`package-lock.json`) | `3` prod advisories (`zod` High, `react-router`/`react-router-dom` Moderate — mitigated in runtime); `6` dev-only advisories |
| TypeScript Typecheck | `npm run typecheck` (`tsc --noEmit`) | Workspace source & tests | **PASS** (`0` errors) |
| ESLint Static Analysis | `npm run lint` (`eslint src tests`) | `src/` and `tests/` | **PASS** (`0` errors, `0` warnings) |
| Production Bundle Build | `npm run build` (`vite build` + `tsc -p tsconfig.server.json` + `release/` mirror) | `dist/` & `release/` | **PASS** (client built in `6.46s`, server compiled cleanly) |
| Security Audit Regression Suite | `NODE_ENV=test npx vitest run tests/security.audit.test.ts` | `staycraft_pms_test` | **PASS** (`9/9` tests passed in `964ms`) |
| Full Unit, Integration & Browser E2E Suite | `NODE_ENV=test npm test` (`vitest run`) | `staycraft_pms_test` | **PASS** (`11/11` test files, `127/127` tests passed, including `19/19` headless Chromium Playwright E2E tests) |
| Live Preview Startup & Header/CSP Check | `start_process` (`bash scripts/start-preview.sh`) + `curl -sSI` + headless Chromium `/login` -> `/` -> `/staff` (`KHB` <-> `EHS`) | `staycraft_pms_preview` (`0.0.0.0:3000`) | **PASS** (`0.0.0.0:3000` ready in `1.29s`; CSP & security headers verified; `0` console/page errors; `EHS_SHOWS_PRIYA: false`) |
| Post-Audit DB Isolation Proof | `psql -h /home/user/data/pgrun -p 5432 -U postgres -d postgres -c "SELECT datname, numbackends, xact_commit, xact_rollback, tup_inserted, tup_updated, tup_deleted FROM pg_stat_database WHERE datname LIKE 'staycraft%';"` | PostgreSQL catalog (`-d postgres`) | `staycraft_pms`: **`numbackends = 0`, `xact_commit = 0`, `xact_rollback = 0`, `tup_inserted = 0`, `tup_updated = 0`, `tup_deleted = 0`** |

---

## 5. Untested & Blocked Items (`NOT TESTED` / `BLOCKED`)

In accordance with strict audit guardrails, the following items were intentionally not executed and are explicitly labeled:

| Item | Status | Reason / Guardrail |
| :--- | :--- | :--- |
| Production database (`staycraft_pms`) schema, role grants, row contents, and live state | **`BLOCKED`** | Strict operational prohibition against connecting to, querying, migrating, or inspecting `staycraft_pms`. |
| Concurrency load, volumetric DoS, and stress testing | **`NOT TESTED` / `BLOCKED`** | Destructive and load testing explicitly prohibited by audit rules. |
| External network penetration testing, TLS cipher/HSTS termination, and WAF validation | **`NOT TESTED` / `BLOCKED`** | External testing and production infrastructure modifications prohibited; TLS terminates at upstream proxy outside sandbox. |
| Distributed multi-instance login rate-limiting synchronization | **`NOT TESTED`** | Current rate limiter is in-process memory (`Map`); shared store (Redis/PostgreSQL) requires production topology changes. |
| Live offsite cloud backup shipping, WAL archiving (`archive_mode=on`), and production PITR restore drill | **`BLOCKED`** | Cloud backup integration and production PostgreSQL infrastructure changes explicitly prohibited (`archive_mode=off`, `ssl=off` on local sandbox cluster). |
| SemVer-major framework migrations (`zod@4`, `react-router-dom@7`, `vitest@4`, `tailwindcss@4`) | **`NOT TESTED`** | Deferred in favor of minimal non-breaking runtime mitigations to preserve existing Phases 1–7 contracts. |

---

## 6. Release Recommendation (No Unconditional Certification)

- **Preview / Staging / QA Environments (`staycraft_pms_preview`, `staycraft_pms_test`)**: **READY FOR CONTINUED USE.** All confirmed application-layer CSRF, CORS, login rate-limiting, password DoS, admin fallback, query-overflow, open-redirect, security-header, cross-property user filter, and log-redaction findings have been remediated and verified across `127/127` automated tests and live headless Chromium checks with zero contact with `staycraft_pms`.
- **Production Release (`staycraft_pms`)**: **CONDITIONAL — DO NOT DEPLOY UNCONDITIONALLY.** Before serving live production hospitality traffic, operators must complete the following pre-production gates:
  1. Provision encrypted offsite PostgreSQL backups + continuous WAL archiving (`archive_mode = on`, `ssl = on`) and complete an isolated `pg_restore` verification drill.
  2. Configure an explicit high-entropy `ADMIN_PASSWORD` (`>= 16` chars) via secret manager and rotate any development/demo credentials.
  3. Enforce HTTPS + `Strict-Transport-Security` at the production reverse proxy/load balancer and configure an explicit production domain origin allowlist.
  4. Replace or back the in-memory login rate limiter with a shared store (Redis or PostgreSQL) if running `>1` server replica.
  5. Schedule a dedicated dependency modernization sprint to complete SemVer-major upgrades (`zod@^4.6.7`, `react-router-dom@^7.18.4`, `vitest@^4.1.12`, `tailwindcss@^4.3.3`) until `npm audit` reports `0` vulnerabilities.
