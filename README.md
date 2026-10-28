# StayCraft PMS — Hotel Property Management System (Phase 1)

A modern, responsive, modular, PostgreSQL-backed Property Management System (PMS) built with **TypeScript, Express, PostgreSQL 17, React 18, Vite, and Tailwind CSS**.

## Architecture Overview

- **`migrations/`** — SQL schema migrations (`001_core_pms.sql`, `002_future_modules_foundation.sql`) using PostgreSQL 17 `pgcrypto` UUIDs, `NUMERIC(12,2)` monetary columns, foreign keys, indexes, and `btree_gist` exclusion constraints (`excl_reservations_no_room_overlap`) preventing overlapping active bookings at the database engine level.
- **`src/shared/`** — Shared TypeScript types, Zod input validation schemas, IANA property-timezone calendar utilities, and integer-cent currency calculations.
- **`src/server/`** — Express API & domain service modules (`auth`, `properties`, `rooms`, `guests`, `reservations`, `dashboard`) with `scrypt` password hashing, unified PostgreSQL-backed opaque sessions (`user_sessions` validated via coordinated `Authorization: Bearer` header and `HttpOnly` cookie), RBAC (`admin` and `receptionist`), row-level `FOR UPDATE` locking, and audit/status history tracking.
- **`src/client/`** — Responsive React SPA featuring collapsible sidebar, multi-property selector, operational notifications, Dashboard, Reservations + Detail page, Room Types & Rooms, Housekeeping Status Board, Guest CRM, Property Settings, and honest Phase 2+ roadmap routes.

## Environment Variables (`.env`)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

StayCraft PMS resolves database connections **fail-closed** (`src/server/config.ts`) and never silently defaults to the production database (`staycraft_pms`):

| Variable | Description | Safe Non-Production Example |
| --- | --- | --- |
| `DATABASE_URL` | Explicit PostgreSQL connection URL for active runtime (rejected in non-production if pointing to `staycraft_pms`) | `postgresql://pms_app:pms_local_dev_pw@127.0.0.1:5432/staycraft_pms_preview` |
| `PREVIEW_DATABASE_URL` | PostgreSQL connection URL required when `STAYCRAFT_DB_ROLE=preview` | `postgresql://pms_app:pms_local_dev_pw@127.0.0.1:5432/staycraft_pms_preview` |
| `TEST_DATABASE_URL` | PostgreSQL connection URL required when `NODE_ENV=test` | `postgresql://pms_app:pms_local_dev_pw@127.0.0.1:5432/staycraft_pms_test` |
| `ALLOW_PRODUCTION_MIGRATIONS` | Must be set to `'true'` only during an explicitly authorized production schema migration window (`seedDatabase` remains permanently blocked on `staycraft_pms`) | *(unset by default)* |
| `PORT` | HTTP server port | `3000` |
| `HOST` | Bind interface (`0.0.0.0` for live preview) | `0.0.0.0` |
| `SESSION_COOKIE_NAME` | HTTP-only session cookie name | `staycraft_session` |
| `SESSION_TTL_HOURS` | Session lifetime in hours | `24` |
| `PUBLIC_APP_URL` | Base origin for Guest QR codes (`/guest/menu/:qrToken`) and account-recovery links. **Production (`NODE_ENV=production`)** strictly requires `https://<public-domain>`. **Local development (`NODE_ENV=development`)** also supports a local Wi-Fi LAN origin (`http://<laptop-lan-ip>:<port>`) so a phone on the same Wi-Fi can scan the QR code. Sandbox, loopback (`localhost`/`127.0.0.1`), and token-bearing URLs are always rejected. | `http://<your-laptop-lan-ip>:3000` (local dev) / `https://pms.yourhotel.com` (production) |

## Backup, Verification & Disaster Recovery Runbook

Production deployments require external encrypted backups and regular isolated restore drills (local sandbox clusters run with `archive_mode=off` and `ssl=off` and are intended solely for preview/test):

1. **Logical Consistent Snapshot (`pg_dump` custom format)**:
   ```bash
   pg_dump --format=custom --no-owner --no-privileges --file="staycraft_$(date -u +%Y%m%dT%H%M%SZ).dump" "$BACKUP_SOURCE_DATABASE_URL"
   sha256sum staycraft_*.dump > staycraft_backup.sha256
   ```
2. **Continuous Point-in-Time Recovery (PITR) for Production**:
   - Enable `ssl = on`, `wal_level = replica`, `archive_mode = on`, and encrypted offsite WAL shipping (e.g., `pgBackRest` or managed cloud PostgreSQL automated PITR snapshots) before serving live hotel traffic.
3. **Isolated Restore Verification (Never Restore Over Live Production Unverified)**:
   ```bash
   createdb staycraft_restore_verify
   pg_restore --clean --if-exists --no-owner --no-privileges -d "$RESTORE_VERIFY_DATABASE_URL" staycraft_<timestamp>.dump
   ```
   Verify `schema_migrations`, `properties`, `reservations`, `invoices`, and `payments` counts and balances on `staycraft_restore_verify` before promoting any recovery target.

## Database Setup & Migrations

```bash
# Ensure local PostgreSQL 17 cluster (stored in ./data/pgdata) is running, migrate, and seed:
npm run db:setup

# Or run individual steps:
npm run db:start
npm run db:migrate
npm run db:seed
```

## Initial Administrator & Seeded Staff Accounts (Development / Demo)

No credentials, secrets, or tokens are embedded in client code. Initial setup seeds two staff accounts:

| Role | Email | Password | Permissions |
| --- | --- | --- | --- |
| **Administrator** | `admin@staycraft.local` | `Admin@12345` | Full access across properties, room categories, room inventory, property settings, front office, CRM, and staff view |
| **Receptionist** | `frontdesk@staycraft.local` | `FrontDesk@123` | Front-office operations (Dashboard, Reservations, Check-In/Out, Walk-Ins, Guest CRM, Housekeeping status updates); restricted (`403`) from structural room/property settings |

### Creating or Resetting the Initial Administrator Account

To safely verify, create, or reset the initial administrator account at any time without wiping existing properties, rooms, guests, or reservations:

```bash
# Ensure the initial admin account exists and is active (keeps existing password if already present):
npm run db:ensure-admin

# Reset the initial admin password (and revoke stale sessions for that user):
npm run db:reset-admin

# Custom admin email/password override via environment variables:
ADMIN_EMAIL="admin@staycraft.local" ADMIN_PASSWORD="YourNewStrongPassword123" npm run db:reset-admin
```

## Commands

```bash
npm run dev           # Start Express + Vite dev server on 0.0.0.0:3000
npm run typecheck     # Run TypeScript compiler check
npm run lint          # Run ESLint across src/ and tests/
npm test              # Run all API + DB + Playwright browser E2E suites (staycraft_pms_test)
npm run test:browser  # Run headless Chromium Playwright E2E suite (staycraft_pms_test)
npm run build         # Build production client (dist/client) and server (dist/server)
npm start             # Start compiled production server on 0.0.0.0:3000
```
