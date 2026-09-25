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
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives beside the package it launches, so the backend dir is its own directory.
const backendDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(backendDir, "..");

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

const child = spawn(interpreter, ["-m", "orbital_backend"], {
  cwd: backendDir,
  stdio: "inherit",
  env: process.env,
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
