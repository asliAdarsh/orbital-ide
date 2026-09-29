import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Byte-count formatter used by the terminal and tool inspector. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human duration for tool/command timings. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Unique id for entities the client creates itself (terminal commands, session ids).
 * `crypto.randomUUID` needs a secure context; the timestamp+random path is the
 * fallback for anything served over plain http.
 */
export function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Last path segment of a path, which is the name a chip or row has room for.
 *
 * Both separators: workspace paths inside the app are POSIX-separated (`FileNode.path`), but a
 * chat's workspace is the absolute path the runtime holds, which on Windows is backslashed.
 */
export function baseName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** A coarse "how long ago" for list rows: exactness matters less than the order of magnitude. */
export function formatRelativeAge(stamp: number, now = Date.now()): string {
  // The runtime is not consistent about the unit — the project registry stores seconds, frames
  // carry milliseconds — so anything below the millisecond magnitude is read as seconds. A wrong
  // guess here is only ever a wrong-looking age.
  const ms = stamp < 1e11 ? stamp * 1000 : stamp;
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
