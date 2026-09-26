'use strict';
/**
 * db.js — SQLite database layer for Saroye Express Inc.
 *
 * Uses better-sqlite3 with a single file database (./data/saroye.db by default,
 * overridable with DB_PATH). All tables are created on first boot. Nothing is
 * seeded with business data — zones, drivers and deliveries start empty so the
 * owner configures everything themselves.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'saroye.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS owners (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL,
  photo_path    TEXT,
  gov_id_path   TEXT NOT NULL,
  authority_proof_path TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Failed owner sign-in attempts, used for the 15-minute lockout after 5 failures.
CREATE TABLE IF NOT EXISTS owner_login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
  success      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS drivers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  full_name          TEXT NOT NULL,
  phone              TEXT NOT NULL,
  photo_path         TEXT,
  licence_path       TEXT NOT NULL,
  permit_path        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | corrections_requested | rejected
  correction_notes   TEXT,
  service_zone_id    INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (service_zone_id) REFERENCES zones(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS zones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,          -- e.g. "Downtown Core" (owner-configured)
  postal_prefixes  TEXT NOT NULL,          -- comma-separated prefixes, e.g. "T5J,T5K"
  base_price       REAL NOT NULL DEFAULT 0,
  per_km_price     REAL NOT NULL DEFAULT 0,
  same_day         INTEGER NOT NULL DEFAULT 0,  -- 1 = same-day available
  active           INTEGER NOT NULL DEFAULT 1,  -- 1 = active, 0 = paused
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deliveries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_code    TEXT NOT NULL UNIQUE,
  -- customer / parcel
  sender_name      TEXT NOT NULL,
  sender_phone     TEXT NOT NULL,
  pickup_address   TEXT NOT NULL,
  pickup_postal    TEXT,
  recipient_name   TEXT NOT NULL,
  recipient_phone  TEXT NOT NULL,
  dropoff_address  TEXT NOT NULL,
  dropoff_postal   TEXT,
  parcel_description TEXT,
  parcel_weight_kg REAL,
  zone_id          INTEGER,
  -- workflow
  status           TEXT NOT NULL DEFAULT 'requested', -- requested | approved | rejected | received | picked_up | in_transit | delivered | cancelled
  driver_id        INTEGER,
  owner_notes      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (zone_id)   REFERENCES zones(id)   ON DELETE SET NULL,
  FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS delivery_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id  INTEGER NOT NULL,
  status       TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE
);
`);

module.exports = db;
