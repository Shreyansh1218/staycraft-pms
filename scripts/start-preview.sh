#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

STAYCRAFT_DB_ROLE=preview bash scripts/ensure-postgres.sh

if [ ! -d "node_modules" ]; then
  echo "Installing Node.js dependencies..."
  npm ci --no-audit --no-fund
fi

SERVER_ENTRY=""
if [ -f "dist/server/server/index.js" ] && [ -f "dist/client/index.html" ]; then
  SERVER_ENTRY="dist/server/server/index.js"
elif [ -f "release/server/server/index.js" ] && [ -f "release/client/index.html" ]; then
  SERVER_ENTRY="release/server/server/index.js"
else
  echo "Building client and server bundles..."
  npm run build
  SERVER_ENTRY="dist/server/server/index.js"
fi

PREVIEW_DB_URL="$(node --input-type=commonjs -r dotenv/config -e '
const explicit = process.env.PREVIEW_DATABASE_URL;
if (explicit && explicit.trim().length > 0) {
  process.stdout.write(explicit.trim());
  process.exit(0);
}
const base = process.env.DATABASE_URL || "postgresql://pms_app:pms_local_dev_pw@127.0.0.1:5432/staycraft_pms_preview";
const parsed = new URL(base);
parsed.pathname = "/staycraft_pms_preview";
process.stdout.write(parsed.toString());
')"

# Verify current_database() === staycraft_pms_preview before any migration/seed check
VERIFIED_DB="$(PREVIEW_DB_URL="${PREVIEW_DB_URL}" node --input-type=commonjs -e '
const pg = require("pg");
(async () => {
  const pool = new pg.Pool({ connectionString: process.env.PREVIEW_DB_URL });
  try {
    const r = await pool.query("SELECT current_database() AS db");
    const db = String(r.rows[0]?.db || "").trim();
    if (db !== "staycraft_pms_preview") {
      console.error(`ABORT: Expected staycraft_pms_preview, connected to "${db}"`);
      process.exit(1);
    }
    const migCnt = await pool.query("SELECT to_regclass(\x27public.schema_migrations\x27) AS reg");
    let applied = 0;
    let props = 0;
    if (migCnt.rows[0]?.reg) {
      const a = await pool.query("SELECT COUNT(*)::int AS cnt FROM schema_migrations");
      applied = Number(a.rows[0]?.cnt || 0);
      const pReg = await pool.query("SELECT to_regclass(\x27public.properties\x27) AS reg");
      if (pReg.rows[0]?.reg) {
        const p = await pool.query("SELECT COUNT(*)::int AS cnt FROM properties");
        props = Number(p.rows[0]?.cnt || 0);
      }
    }
    process.stdout.write(`${db}:${applied}:${props}`);
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error("Preview DB verification failed:", err.message);
  process.exit(1);
});
')"

EXPECTED_MIGRATIONS="$(ls -1 migrations/*.sql | wc -l | tr -d ' ')"
APPLIED_MIGRATIONS="$(echo "${VERIFIED_DB}" | cut -d: -f2)"
EXISTING_PROPS="$(echo "${VERIFIED_DB}" | cut -d: -f3)"

if [ "${APPLIED_MIGRATIONS}" != "${EXPECTED_MIGRATIONS}" ] || [ "${EXISTING_PROPS}" -eq 0 ]; then
  STAYCRAFT_DB_ROLE=preview PREVIEW_DATABASE_URL="${PREVIEW_DB_URL}" DATABASE_URL="${PREVIEW_DB_URL}" npm run db:seed
else
  echo "Verified current_database()=staycraft_pms_preview (${APPLIED_MIGRATIONS}/${EXPECTED_MIGRATIONS} migrations applied, ${EXISTING_PROPS} properties present)."
fi

DEFAULT_NODE_ENV="$(node --input-type=commonjs -r dotenv/config -e 'process.stdout.write((process.env.NODE_ENV || "development").trim())')"
exec env NODE_ENV="${NODE_ENV:-${DEFAULT_NODE_ENV}}" SERVE_STATIC_CLIENT=true STAYCRAFT_DB_ROLE=preview PREVIEW_DATABASE_URL="${PREVIEW_DB_URL}" DATABASE_URL="${PREVIEW_DB_URL}" PORT="${PORT:-3000}" HOST="${HOST:-0.0.0.0}" node "${SERVER_ENTRY}"
