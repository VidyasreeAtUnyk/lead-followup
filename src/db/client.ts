import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

export const DEFAULT_DB_PATH = path.join(__dirname, "..", "..", "data", "leads.sqlite");

let instance: DatabaseSync | null = null;
let instancePath: string | null = null;

/**
 * Every process (CLI command, agent run, eval scenario) opens the DB fresh via
 * this function rather than sharing in-memory handles across "sessions" --
 * this is what makes the system resumable after a kill: nothing but this file
 * on disk needs to survive a restart.
 */
export function getDb(dbPath: string = DEFAULT_DB_PATH): DatabaseSync {
  if (instance && instancePath === dbPath) return instance;
  if (instance) instance.close();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  migrateExistingTables(db);
  instance = db;
  instancePath = dbPath;
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` (used above) only handles brand-new tables --
 * it does nothing for a pre-existing db file missing a column added later
 * (e.g. the locking columns below). Rather than a full migration framework,
 * we just try to add each column and swallow the "duplicate column" error on
 * a db that already has it. Safe to run on every startup.
 */
function migrateExistingTables(db: DatabaseSync): void {
  const columnAdditions = [
    "ALTER TABLE leads ADD COLUMN locked_at TEXT",
    "ALTER TABLE leads ADD COLUMN locked_by TEXT",
  ];
  for (const stmt of columnAdditions) {
    try {
      db.exec(stmt);
    } catch {
      // column already exists -- fine
    }
  }
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
    instancePath = null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
