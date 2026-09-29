#!/usr/bin/env node
/**
 * Start the Orbital agent backend from the repository virtualenv.
 *
 * `npm run backend:dev` cannot be a plain `python -m orbital_backend`:
 *  - the package lives in `backend/`, so the module only resolves with that as the working
 *    directory (the same thing `tauri dev` does when it spawns the sidecar);
 *  - `python` on PATH is whatever the machine has, not the venv that holds fastapi/langgraph.
 *
 * This launcher resolves both, cross-platform, and forwards Ctrl-C to the child so the
 * uvicorn reload/shutdown path runs normally.
 *
 * It also mints the runtime's auth token. The backend refuses callers that do not present it, and
 * both sides need the same value before either has started: the backend reads it from
 * ORBITAL_AUTH_TOKEN here, and the Vite dev server reads the copy this script writes to
 * `frontend/.env.local` — neither can read the other's stdout. The packaged app does none of this;
 * its token is minted by the sidecar and read off the readiness line by the Tauri host.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives beside the package it launches, so the backend dir is its own directory.
const backendDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(backendDir, "..");

// 32 bytes, url-safe: unguessable, and safe in a header, a dotenv line and a readiness line.
const token = randomBytes(32).toString("base64url");

const interpreter =
  process.platform === "win32"
    ? join(repoRoot, ".venv", "Scripts", "python.exe")
    : join(repoRoot, ".venv", "bin", "python");

if (!existsSync(backendDir)) {
  console.error(`No backend package found at ${backendDir}.`);
  process.exit(1);
}

if (!existsSync(interpreter)) {
  console.error(`No virtualenv interpreter at ${interpreter}.`);
  console.error("Create it first:");
  console.error("  python -m venv .venv");
  console.error("  .venv/Scripts/pip install -r backend/requirements.txt   # Windows");
  console.error("  .venv/bin/pip install -r backend/requirements.txt       # macOS / Linux");
  process.exit(1);
}

/**
 * Put `VITE_ORBITAL_TOKEN` into the frontend's `.env.local`, which Vite loads at startup.
 *
 * Merged rather than overwritten: that file is where the developer's Firebase configuration lives
 * (`frontend/.env.example` says to copy it there), and clobbering it would cost them that setup.
 * Vite restarts itself when an env file changes, so a dev server already running picks the token
 * up; starting it afterwards works too.
 */
function writeFrontendToken(value) {
  const path = join(repoRoot, "frontend", ".env.local");
  const line = `VITE_ORBITAL_TOKEN=${value}`;
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // No file yet: the write below creates it.
  }
  const kept = existing
    .split(/\r?\n/)
    .filter((entry) => entry !== "" && !/^\s*VITE_ORBITAL_TOKEN\s*=/.test(entry));
  writeFileSync(path, [...kept, line, ""].join("\n"), "utf8");
  console.log(`Orbital runtime token written to ${path} for the Vite dev server.`);
}

writeFrontendToken(token);

const child = spawn(interpreter, ["-m", "orbital_backend"], {
  cwd: backendDir,
  stdio: "inherit",
  // The minted token wins over an inherited one: the Vite copy above is this value, so a stale
  // ORBITAL_AUTH_TOKEN in the developer's shell would leave the two sides disagreeing.
  env: { ...process.env, ORBITAL_AUTH_TOKEN: token },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`Could not start the backend: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 0 : (code ?? 0));
});
