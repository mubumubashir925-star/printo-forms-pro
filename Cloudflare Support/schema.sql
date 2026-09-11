-- ═══════════════════════════════════════════════════════════
-- PrintoForms — D1 schema (replaces Google Sheets)
-- Run once via: wrangler d1 execute printoforms --file=schema.sql
-- or paste into Cloudflare Dashboard → D1 → your DB → Console
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS forms (
  slug              TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  fields_json       TEXT NOT NULL DEFAULT '[]',
  rename_field_id   TEXT NOT NULL DEFAULT '',
  logo_text         TEXT NOT NULL DEFAULT '',
  accent_color      TEXT NOT NULL DEFAULT '#2563eb',
  hide_branding     INTEGER NOT NULL DEFAULT 0,
  public_mode       INTEGER NOT NULL DEFAULT 0,
  manager_password  TEXT NOT NULL DEFAULT '',
  locked            INTEGER NOT NULL DEFAULT 0,
  submission_count  INTEGER NOT NULL DEFAULT 0,
  drive_folder_id   TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL,
  device_id    TEXT NOT NULL DEFAULT '',
  values_json  TEXT NOT NULL DEFAULT '{}',
  dup_key      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_slug         ON submissions(slug);
CREATE INDEX IF NOT EXISTS idx_sub_slug_device  ON submissions(slug, device_id);
CREATE INDEX IF NOT EXISTS idx_sub_slug_dupkey  ON submissions(slug, dup_key);
CREATE INDEX IF NOT EXISTS idx_sub_slug_id      ON submissions(slug, id);
