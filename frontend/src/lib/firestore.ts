/**
 * The account's project records in Firestore — the part of a workspace that follows a person.
 *
 * One document per project at `users/{uid}/projects/{documentId}`, and the document id is a digest
 * of the project's path: the path is the identity that survives a machine change, so two machines
 * that know the same folder write the same document rather than one each. That is also what keeps
 * two windows open on the same account from inventing a second copy of a project.
 *
 * What a document may hold is exactly what `firestore.rules` allows — the title, the path, the last
 * phase seen, when the record was last written and the run's artefacts. Nothing else about a
 * project crosses this boundary: no provider key, no token, no file tree, no terminal history.
 *
 * **Size.** Each artefact is capped at {@link PROJECT_ARTEFACT_LIMIT}. The runtime's own file read
 * reports the true size of a file, so the sync *skips* a larger one with a reason rather than
 * truncating it silently — a half-synced plan is worse than a missing one, because nothing in the
 * document would say it had been cut. Three artefacts at the cap come to 192 KB, well inside
 * Firestore's 1 MB document limit; the rules enforce the same per-artefact bound, so a client that
 * forgot to check is refused instead of losing the write.
 *
 * **Emulator.** Firestore follows Auth: when `VITE_FIREBASE_EMULATOR=1`, the same check the login
 * page reports on, this connects to the local suite's Firestore instead of the cloud. No new
 * variable, because two switches that could disagree is a configuration bug waiting to happen.
 */

import { getApp, getApps } from "firebase/app";
import {
  Timestamp,
  collection,
  connectFirestoreEmulator,
  doc,
  getDocs,
  getFirestore,
  writeBatch,
  type Firestore,
} from "firebase/firestore";

import { firebaseConfigError, usingAuthEmulator } from "@/lib/firebase";

/** The Firestore emulator port the suite publishes; the same one the gateway's tests use. */
const FIRESTORE_EMULATOR_PORT = 8080;

/**
 * Longest artefact text a document may carry. Bytes, not characters: it is the file's size on disk
 * that decides, and the rules measure the stored string the same way.
 */
export const PROJECT_ARTEFACT_LIMIT = 64 * 1024;

/** The three run artefacts that travel with a project. Named as the document's own keys. */
export const PROJECT_ARTEFACT_NAMES = ["plan", "agents", "report"] as const;
export type ProjectArtefactName = (typeof PROJECT_ARTEFACT_NAMES)[number];

/** The artefact texts a document carries; a missing key means that file is not there (or is too big). */
export type ProjectArtefacts = Partial<Record<ProjectArtefactName, string>>;

/** One project, as the account records it. */
export interface SyncedProjectDocument {
  title: string;
  /** Absolute directory on the machine that wrote it. */
  path: string;
  /** The last phase that machine saw, or `""` when it never saw one. */
  phase: string;
  /** Epoch seconds; the last-write-wins comparison between two machines. */
  updatedAt: number;
  artefacts: ProjectArtefacts;
}

/** A document plus the id it is stored under, which is what a write addresses. */
export interface SyncedProject extends SyncedProjectDocument {
  documentId: string;
}

/**
 * The key two machines compare a path by: separators unified, case folded.
 *
 * Windows and macOS fold case and Windows accepts either separator, so `/Work/App` and
 * `C:\work\app` are one folder to a person. Folding here means the two machines that open the same
 * folder agree on one document instead of two. A case-sensitive filesystem with two folders
 * differing only in case would collide — a trade this feature takes deliberately, because the
 * failure it prevents (a project duplicated per machine) is the common one.
 */
export function projectKey(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * The document id for a project path: two independent 32-bit digests of {@link projectKey}, hex.
 *
 * Deliberately not a cryptographically secure hash — nothing here is a secret and the value must be
 * computable in every host the webview runs in, including ones where `crypto.subtle` is absent. 64
 * bits are enough that two folders on one account do not collide, and `firestore.rules` requires
 * this exact shape, so an account's projects collection cannot be used as general-purpose storage.
 */
export function projectDocumentId(path: string): string {
  const text = projectKey(path);
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) + code) >>> 0;
  }
  return `${fnv.toString(16).padStart(8, "0")}${djb.toString(16).padStart(8, "0")}`;
}

function openFirestore(): { db: Firestore } | { reason: string } {
  // No configuration means `firebase.ts` never called `initializeApp`, so there is no app to take
  // a Firestore instance from — the same sentence either way, because it is the same problem.
  const app = firebaseConfigError === null && getApps().length > 0 ? getApp() : null;
  if (app === null) {
    return { reason: "Sync needs the Firebase configuration: without it the app has no project to sync with." };
  }
  const db = getFirestore(app);
  if (usingAuthEmulator) connectFirestoreEmulator(db, "127.0.0.1", FIRESTORE_EMULATOR_PORT);
  return { db };
}

const opened = openFirestore();

/**
 * The Firestore instance, or null when there is nothing to sync with. Callers check
 * {@link firestoreUnavailableReason} for the sentence to show — the same shape `firebase.ts` uses
 * for Auth, and for the same reason: an import that threw would blank the window.
 */
export const firestore: Firestore | null = "db" in opened ? opened.db : null;

/** Why there is no Firestore client, or null when there is one. */
export const firestoreUnavailableReason: string | null = "reason" in opened ? opened.reason : null;

/** A stored `updatedAt` read back as epoch seconds, whichever of the two shapes it was written in. */
function asEpochSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Timestamp) return value.toMillis() / 1000;
  return null;
}

function asArtefacts(value: unknown): ProjectArtefacts | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const artefacts: ProjectArtefacts = {};
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (!(PROJECT_ARTEFACT_NAMES as readonly string[]).includes(key)) return null;
    if (typeof text !== "string") return null;
    artefacts[key as ProjectArtefactName] = text;
  }
  return artefacts;
}

/**
 * One stored document as the sync wants it, or null when it is not the shape this file writes.
 *
 * A record that does not fit is dropped rather than guessed at: the rules make it unreachable for a
 * client, so a document that is the wrong shape was written by something else — the Admin SDK or an
 * older build — and the sync has no business inventing a project out of it.
 */
export function syncedProjectFromData(documentId: string, data: unknown): SyncedProject | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const { title, path, phase, updatedAt } = record;
  const seconds = asEpochSeconds(updatedAt);
  const artefacts = asArtefacts(record.artefacts ?? {});
  if (typeof title !== "string" || title === "") return null;
  if (typeof path !== "string" || path === "") return null;
  if (phase !== undefined && typeof phase !== "string") return null;
  if (seconds === null || artefacts === null) return null;
  return {
    documentId,
    title,
    path,
    phase: typeof phase === "string" ? phase : "",
    updatedAt: seconds,
    artefacts,
  };
}

/** Every project record the account holds, and how many documents were not in a shape we can read. */
export interface AccountProjects {
  projects: SyncedProject[];
  /** Documents that were there but not readable as a project; reported, never guessed at. */
  unreadable: number;
}

/**
 * Read the account's project records.
 *
 * Own records only: the rules let a signed-in user see their own `users/{uid}/projects` and nothing
 * else, so this is the whole account's list and no one else's.
 */
export async function readAccountProjects(uid: string): Promise<AccountProjects> {
  const db = firestore;
  if (db === null) return { projects: [], unreadable: 0 };
  const snapshot = await getDocs(collection(db, "users", uid, "projects"));
  const projects: SyncedProject[] = [];
  let unreadable = 0;
  for (const entry of snapshot.docs) {
    const project = syncedProjectFromData(entry.id, entry.data());
    if (project === null) unreadable += 1;
    else projects.push(project);
  }
  return { projects, unreadable };
}

/** Firestore refuses a batch over 500 writes; this many per batch leaves room to spare. */
const WRITES_PER_BATCH = 400;

/** The stored shape of one document — every key the rules require, and nothing else. */
function storedDocument(project: SyncedProjectDocument): Record<string, unknown> {
  const artefacts: Record<string, string> = {};
  for (const name of PROJECT_ARTEFACT_NAMES) {
    const text = project.artefacts[name];
    if (text !== undefined) artefacts[name] = text;
  }
  return {
    title: project.title,
    path: project.path,
    phase: project.phase,
    updatedAt: project.updatedAt,
    artefacts,
  };
}

/**
 * Write the given records, in whole documents, replacing whatever was there for the same path.
 *
 * The write is unconditional: the last-write-wins decision has already been taken against the
 * records this run read, and a write that re-read before committing would be the very race between
 * two windows this feature exists to avoid.
 */
export async function writeAccountProjects(
  uid: string,
  projects: readonly SyncedProjectDocument[],
): Promise<void> {
  const db = firestore;
  if (db === null || projects.length === 0) return;
  for (let start = 0; start < projects.length; start += WRITES_PER_BATCH) {
    const batch = writeBatch(db);
    for (const project of projects.slice(start, start + WRITES_PER_BATCH)) {
      batch.set(doc(db, "users", uid, "projects", projectDocumentId(project.path)), storedDocument(project));
    }
    await batch.commit();
  }
}
