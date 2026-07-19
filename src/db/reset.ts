import { existsSync, unlinkSync } from "node:fs";
import { DEFAULT_DB_PATH } from "./client.js";

for (const suffix of ["", "-wal", "-shm"]) {
  const p = DEFAULT_DB_PATH + suffix;
  if (existsSync(p)) unlinkSync(p);
}
console.log(`Removed ${DEFAULT_DB_PATH} (and WAL/SHM sidecars if present). Run "npm run seed" to recreate it.`);
