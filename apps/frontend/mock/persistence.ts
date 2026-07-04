// Best-effort disk snapshot so the mock survives a Ctrl-C + restart mid-run —
// this is what makes the "kill the mock, restart it, stream resumes with no
// gaps" reconnect test meaningful. A real backend gets this from Postgres;
// this mock gets it from a gitignored JSON file written after every mutation.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(here, ".data.json");

export function loadSnapshot<T>(): T | undefined {
  if (!existsSync(DATA_FILE)) return undefined;
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function saveSnapshot(data: unknown): void {
  try {
    writeFileSync(DATA_FILE, JSON.stringify(data), "utf-8");
  } catch {
    // Best-effort — the mock keeps working in-memory even if the write fails.
  }
}
