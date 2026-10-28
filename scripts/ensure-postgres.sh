#!/usr/bin/env bash
set -euo pipefail

PG_BIN="/usr/lib/postgresql/17/bin"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="${ROOT_DIR}/data/pgdata"
PGRUN="${ROOT_DIR}/data/pgrun"
PGLOG="${ROOT_DIR}/data/postgres.log"

if [ ! -x "${PG_BIN}/pg_ctl" ]; then
  echo "PostgreSQL 17 binaries not found; installing postgresql..."
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-client
  sudo pg_ctlcluster 17 main stop >/dev/null 2>&1 || sudo service postgresql stop >/dev/null 2>&1 || true
fi

mkdir -p "${PGRUN}"

if [ ! -f "${PGDATA}/PG_VERSION" ]; then
  echo "Initializing PostgreSQL 17 cluster in ${PGDATA}..."
  mkdir -p "${PGDATA}"
  chmod 700 "${PGDATA}"
  "${PG_BIN}/initdb" -D "${PGDATA}" -U postgres --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 >/dev/null

  cat >> "${PGDATA}/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = 5432
unix_socket_directories = '${PGRUN}'
logging_collector = off
EOF
else
  # Ensure required PGDATA mode (0700) and empty runtime directories exist after snapshot restore
  mkdir -p \
    "${PGDATA}/pg_notify" \
    "${PGDATA}/pg_replslot" \
    "${PGDATA}/pg_serial" \
    "${PGDATA}/pg_snapshots" \
    "${PGDATA}/pg_stat" \
    "${PGDATA}/pg_stat_tmp" \
    "${PGDATA}/pg_tblspc" \
    "${PGDATA}/pg_twophase" \
    "${PGDATA}/pg_commit_ts" \
    "${PGDATA}/pg_wal/archive_status" \
    "${PGDATA}/pg_logical/snapshots" \
    "${PGDATA}/pg_logical/mappings"
  chmod 700 "${PGDATA}"
fi

if ! "${PG_BIN}/pg_ctl" -D "${PGDATA}" status >/dev/null 2>&1; then
  if "${PG_BIN}/pg_isready" -h "127.0.0.1" -p 5432 >/dev/null 2>&1; then
    sudo pg_ctlcluster 17 main stop >/dev/null 2>&1 || sudo service postgresql stop >/dev/null 2>&1 || true
  fi
  rm -f "${PGDATA}/postmaster.pid" "${PGRUN}/.s.PGSQL.5432" "${PGRUN}/.s.PGSQL.5432.lock"
  echo "Starting PostgreSQL 17..."
  "${PG_BIN}/pg_ctl" -D "${PGDATA}" -l "${PGLOG}" -w start
fi

# Detect active Unix socket directory (supports both ${PGRUN} and /tmp)
PG_SOCK_DIR="${PGRUN}"
if [ ! -S "${PG_SOCK_DIR}/.s.PGSQL.5432" ] && [ -S "/tmp/.s.PGSQL.5432" ]; then
  PG_SOCK_DIR="/tmp"
fi

ROLE_EXISTS=$(PGOPTIONS='-c default_transaction_read_only=on' psql -h "${PG_SOCK_DIR}" -p 5432 -U postgres -d postgres -tAc "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pms_app'")
if [ "${ROLE_EXISTS}" != "1" ]; then
  psql -h "${PG_SOCK_DIR}" -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pms_app') THEN
    CREATE ROLE pms_app WITH LOGIN PASSWORD 'pms_local_dev_pw' CREATEDB;
  END IF;
END
$$;
SQL
fi

# Strictly scope database provisioning so preview/test startups never connect to production staycraft_pms
if [ "${STAYCRAFT_DB_ROLE:-}" = "preview" ]; then
  TARGET_DBS=("staycraft_pms_preview")
elif [ "${NODE_ENV:-}" = "test" ]; then
  TARGET_DBS=("staycraft_pms_test")
else
  TARGET_DBS=("staycraft_pms_preview" "staycraft_pms_test")
fi

for DB_NAME in "${TARGET_DBS[@]}"; do
  EXISTS=$(PGOPTIONS='-c default_transaction_read_only=on' psql -h "${PG_SOCK_DIR}" -p 5432 -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'")
  if [ "${EXISTS}" != "1" ]; then
    echo "Creating database ${DB_NAME}..."
    createdb -h "${PG_SOCK_DIR}" -p 5432 -U postgres -O pms_app "${DB_NAME}"
    psql -h "${PG_SOCK_DIR}" -p 5432 -U postgres -d "${DB_NAME}" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS btree_gist;" >/dev/null
  fi
done

echo "PostgreSQL 17 is ready on 127.0.0.1:5432 (${TARGET_DBS[*]})."
