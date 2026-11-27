import { createRequire } from 'node:module';

type Value = string | number | null;
export interface Statement {
  run(...args: Value[]): { changes: number | bigint };
  get(...args: Value[]): unknown;
  all(...args: Value[]): unknown[];
  iterate(...args: Value[]): Iterable<unknown>;
}
export interface Database {
  exec(sql: string): unknown;
  prepare(sql: string): Statement;
  close(): void;
}
export function openStore(path: string): Database {
  const require = createRequire(import.meta.url);
  let db: Database;
  if (process.features && Number(process.versions.node.split('.')[0]) >= 22) {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path);
  } else {
    const SQLite = require('libsql');
    db = new SQLite(path);
  }
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cameras (id TEXT PRIMARY KEY, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS registry (serial TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS sightings (camera TEXT NOT NULL, fingerprint TEXT NOT NULL, manifest TEXT NOT NULL, PRIMARY KEY(camera,fingerprint));
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY, camera TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      model TEXT NOT NULL, media TEXT NOT NULL, fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL, completed INTEGER, duration INTEGER, size INTEGER,
      hash TEXT, verification TEXT, destination TEXT, partial TEXT, error TEXT, thumbnail TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS source_once ON transfers(camera,fingerprint);
    CREATE INDEX IF NOT EXISTS work ON transfers(camera,status,retry,created);
    CREATE INDEX IF NOT EXISTS history ON transfers(created DESC,id DESC);
    CREATE INDEX IF NOT EXISTS recent_history ON transfers(status,completed DESC);
    CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, camera TEXT NOT NULL UNIQUE, started INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS batch_members (batch TEXT NOT NULL, transfer TEXT NOT NULL, PRIMARY KEY(batch,transfer));
    CREATE TABLE IF NOT EXISTS camera_sync (camera TEXT PRIMARY KEY, completed INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS camera_history ON transfers(camera,created DESC);
    CREATE INDEX IF NOT EXISTS content ON transfers(camera,hash,status);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, time INTEGER NOT NULL, camera TEXT, kind TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_keys (key TEXT PRIMARY KEY, time INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS event_dedup ON events(kind,camera,time);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, subject TEXT NOT NULL, config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries (
      event INTEGER NOT NULL, device TEXT NOT NULL, state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL,
      PRIMARY KEY(event,device)
    );
    CREATE INDEX IF NOT EXISTS delivery_queue ON deliveries(state,due);
    PRAGMA user_version=1;
  `);
  return db;
}
