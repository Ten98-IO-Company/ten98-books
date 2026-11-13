#!/bin/sh
# Creates the two database roles of D-03 and hands the database to the migrator. Run once per cluster as a superuser:
# the postgres image runs it from /docker-entrypoint-initdb.d on first start, and CI runs it against its service.
#   books_migrator  owns the tables and applies migrations (MIGRATION_DATABASE_URL).
#   books_app       web and worker (DATABASE_URL); not a superuser, cannot bypass row-level security, owns no table.
# The migrator is a member of books_app only so migration 0001 can create the pg-boss schema owned by books_app.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrator_password="$BOOKS_MIGRATOR_PASSWORD" -v app_password="$BOOKS_APP_PASSWORD" -v database="$POSTGRES_DB" <<'SQL'
CREATE ROLE books_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'migrator_password';
CREATE ROLE books_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
GRANT books_app TO books_migrator;
ALTER DATABASE :"database" OWNER TO books_migrator;
SQL
