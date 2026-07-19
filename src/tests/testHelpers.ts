import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "..", "db", "schema.sql");

/**
 * Fully isolated in-memory db for unit tests -- deliberately bypasses the
 * getDb() singleton (which caches by path) so tests never share state with
 * each other regardless of execution order.
 */
export function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  return db;
}

export interface Test {
  name: string;
  run: () => void | Promise<void>;
}

export function assertTrue(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message} (expected ${String(expected)}, got ${String(actual)})`);
  }
}
