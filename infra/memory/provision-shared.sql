-- First-time administrator provisioning only. Inspect existing identities before running.
-- Run in psql as kakamlab_admin on kakamlab-db:5656, initially connected to postgres.
-- CREATE DATABASE must be outside a transaction. No credentials are stored in this file.
CREATE ROLE kakamlab_drift_memory LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 16;
CREATE DATABASE kakamlab_drift_memory_db OWNER kakamlab_admin;
REVOKE ALL ON DATABASE kakamlab_drift_memory_db FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE kakamlab_drift_memory_db TO kakamlab_drift_memory;
ALTER ROLE kakamlab_drift_memory IN DATABASE kakamlab_drift_memory_db
  SET search_path TO drift_memory, public;

\connect kakamlab_drift_memory_db
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA drift_memory AUTHORIZATION kakamlab_drift_memory;
GRANT USAGE ON SCHEMA public TO kakamlab_drift_memory;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- Then set the password interactively: \password kakamlab_drift_memory
-- Deliver it via the application's private .env; never use the administrator role at runtime.
