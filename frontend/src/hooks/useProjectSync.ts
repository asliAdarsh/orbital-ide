/**
 * The account's copy of the launcher's projects.
 *
 * What follows a person between machines is the list of projects and the small artefacts of each
 * run; what never does is a provider key. This hook pushes the local registry, pulls the account's
 * records and merges the two by the project's path — the one identity a folder keeps when it moves
 * machines — with `updatedAt` deciding which side wins.
 *
 * The *launcher* mounts it rather than `App`: this is the surface that lists projects, and the sync
 * is an addition to that list, never a prerequisite for it. Nothing here can block the dashboard —
 * every failure is a line of text — and a window with no account never reaches Firestore at all.
 *
 * Three properties the loop is built around:
 *  - **Idempotent.** The record this machine composes is a function of the registry and the files
 *    on disk, and the document id is the path's digest, so a second sync writes nothing: the stored
 *    record is already at least as new as the composed one and is kept as it is.
 *  - **No fighting between windows.** A tie keeps what the account holds instead of pushing the
 *    local record, so two windows on one account converge on the same document instead of taking
 *    turns overwriting each other. The single exception is a record that carries artefacts where
 *    the stored one carries none — the run's files, which no other machine has a copy of.
 *  - **Quiet.** No write on render, no spinner over the list: the panel shows a sentence.
 *
 * What it deliberately does not do: delete records. A project forgotten on one machine is still a
 * project the account knows about, and the honest way to show that is as a record that is not on
 * this machine — a tombstone is a decision this contract leaves open.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api, errorMessage } from "@/lib/api";
import { auth } from "@/lib/firebase";
import {
  PROJECT_ARTEFACT_LIMIT,
  firestore,
  firestoreUnavailableReason,
  projectKey,
  readAccountProjects,
  writeAccountProjects,
  type ProjectArtefactName,
  type ProjectArtefacts,
  type SyncedProject,
  type SyncedProjectDocument,
} from "@/lib/firestore";
import { useAuth } from "@/hooks/useAuth";
import { useAppStore } from "@/store/app-store";
import { AGENTS_MD_PATH, PLAN_PATH, TEST_REPORT_PATH, type ProjectEntry } from "@/types/protocol";

/**
 * Where this machine remembers the last phase it saw for a project, keyed by {@link projectKey}.
 *
 * The registry the runtime serves carries no phase — a project has one only while it is open — so
 * the phase a machine can offer is one it has seen. It is remembered per machine, which is what it
 * is: the phase on the machine that did the work, not a fact about the project.
 */
const PHASE_KEY = "orbital.projectPhase";

let phaseCache: Record<string, string> | null = null;

function knownPhases(): Record<string, string> {
  if (phaseCache !== null) return phaseCache;
  const known: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PHASE_KEY) ?? "null");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" && value !== "") known[key] = value;
      }
    }
  } catch {
    // Storage disabled, or holding something that is not this: "no phase remembered" is a starting
    // state, not a failure — the sync still carries the title, the path and the artefacts.
  }
  phaseCache = known;
  return known;
}

let lastSeenPhase: string | null = null;

/**
 * Follow the open project's phase, once per change.
 *
 * This is installed at import rather than from an effect on purpose: the launcher unmounts while
 * the IDE is open, and that is exactly when the phase moves. The write is to this machine's own
 * storage — no account, no network, nothing to do with Firestore — and the value is only ever read
 * back into a record when a uid exists.
 */
useAppStore.subscribe((state) => {
  const path = state.project?.projectPath ?? null;
  if (path === null || path === "") return;
  const seen = `${projectKey(path)}\u0000${state.activePhase}`;
  if (seen === lastSeenPhase) return;
  lastSeenPhase = seen;
  const known = { ...knownPhases(), [projectKey(path)]: state.activePhase };
  phaseCache = known;
  try {
    window.localStorage.setItem(PHASE_KEY, JSON.stringify(known));
  } catch {
    // Best effort: the phase still applies to this session.
  }
});

/** The three artefact files a run leaves behind, and the document key each one travels as. */
const ARTEFACT_FILES: readonly { name: ProjectArtefactName; label: string; path: string }[] = [
  { name: "plan", label: "plan.md", path: PLAN_PATH },
  { name: "agents", label: "Agents.md", path: AGENTS_MD_PATH },
  { name: "report", label: "test-report.md", path: TEST_REPORT_PATH },
];

/** A file size a person reads at a glance, for the reasons the sync reports. */
function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The artefacts of one project, read through the runtime.
 *
 * The runtime reads files under the workspace root it holds, and it holds one at a time: whichever
 * project was opened last. So the artefacts that can travel are that project's. Binding the
 * workspace to each project in turn to read the rest would bump their last-opened times and move
 * the user's list around, which is a worse trade than an artefact that arrives the next time the
 * project is opened. Everything else about a project — its title, its path, its phase and its time
 * — is carried either way.
 *
 * A file over {@link PROJECT_ARTEFACT_LIMIT} is left out with a reason rather than truncated: a
 * half-synced plan reads as a plan, and nothing in the document would say it had been cut.
 */
async function readProjectArtefacts(
  project: ProjectEntry,
): Promise<{ artefacts: ProjectArtefacts; notes: string[] }> {
  const artefacts: ProjectArtefacts = {};
  const notes: string[] = [];
  for (const file of ARTEFACT_FILES) {
    try {
      const content = await api.readFile(file.path);
      if (content.bytes > PROJECT_ARTEFACT_LIMIT) {
        notes.push(
          `${project.name}: ${file.label} is ${bytesLabel(content.bytes)}, over the ${bytesLabel(
            PROJECT_ARTEFACT_LIMIT,
          )} sync cap — it was left out rather than truncated.`,
        );
        continue;
      }
      artefacts[file.name] = content.content;
    } catch (cause) {
      // The phase that writes an artefact may not have run yet, and that is not news. Anything else
      // — a permissions failure, a runtime that stopped answering — is worth a line.
      if (cause instanceof ApiError && cause.status === 404) continue;
      notes.push(`${project.name}: ${file.label} could not be read — ${errorMessage(cause)}`);
    }
  }
  return { artefacts, notes };
}

/** The runtime's own word about which folder it has open; null when it has none, or is away. */
async function boundProjectPath(): Promise<string | null> {
  try {
    return (await api.project()).projectPath;
  } catch {
    // The account's list does not depend on the runtime: a runtime that is down means no artefacts
    // travel, not a sync that fails.
    return null;
  }
}

/** One project as this machine would store it, keyed by {@link projectKey}. */
async function composeRecords(
  local: readonly ProjectEntry[],
  boundKey: string | null,
  notes: string[],
): Promise<Map<string, SyncedProjectDocument>> {
  const phases = knownPhases();
  const records = new Map<string, SyncedProjectDocument>();
  for (const project of local) {
    const key = projectKey(project.path);
    let artefacts: ProjectArtefacts = {};
    if (key === boundKey) {
      const read = await readProjectArtefacts(project);
      artefacts = read.artefacts;
      notes.push(...read.notes);
    }
    records.set(key, {
      title: project.name,
      path: project.path,
      phase: phases[key] ?? "",
      // The registry's own clock. "Last opened" is the only moment the runtime records that
      // something happened to a project, and it moves exactly when a machine has new work to
      // offer, which is also when its artefacts become readable.
      updatedAt: project.lastOpenedAt || project.createdAt,
      artefacts,
    });
  }
  return records;
}

interface SyncPlan {
  /** Records this machine should write: either nothing is stored for that path, or something older. */
  writes: SyncedProjectDocument[];
  /** Stored records for projects that are not in this machine's registry. */
  elsewhere: SyncedProject[];
  notes: string[];
}

function planSync(
  records: Map<string, SyncedProjectDocument>,
  remote: readonly SyncedProject[],
  notes: string[],
): SyncPlan {
  const writes: SyncedProjectDocument[] = [];
  const elsewhere: SyncedProject[] = [];
  const stored = new Map(remote.map((entry) => [projectKey(entry.path), entry]));

  for (const entry of remote) {
    if (!records.has(projectKey(entry.path))) elsewhere.push(entry);
  }

  for (const [key, record] of records) {
    const existing = stored.get(key) ?? null;
    if (existing === null) {
      writes.push(record);
      continue;
    }

    if (existing.updatedAt === record.updatedAt) {
      // A tie keeps what is stored, so that two windows converge instead of taking turns
      // overwriting each other. The one exception is the direction that carries information: a
      // record with artefacts where the stored one has none is the run's files, which the account
      // has no copy of, and keeping the emptier record would lose the whole point of the sync. Two
      // windows holding *different* artefacts still converge on the stored copy, because only this
      // one direction is taken.
      if (Object.keys(existing.artefacts).length === 0 && Object.keys(record.artefacts).length > 0) {
        writes.push(record);
      }
      continue;
    }

    if (existing.updatedAt > record.updatedAt) continue;

    // The files could not be read here, so writing would replace artefacts the account holds with
    // nothing at all. Keeping the stored record loses a title edit; writing it loses the plan.
    if (Object.keys(existing.artefacts).length > 0 && Object.keys(record.artefacts).length === 0) {
      notes.push(
        `${record.title}: the account's recorded artefacts were kept — this machine's runtime has another folder open.`,
      );
      continue;
    }
    writes.push(record);
  }

  return { writes, elsewhere, notes };
}

/** What the last sync did, in one line. */
function describeSync(plan: SyncPlan): string {
  const pushed =
    plan.writes.length === 0
      ? "nothing new to push"
      : `pushed ${plan.writes.length} project${plan.writes.length === 1 ? "" : "s"}`;
  const other =
    plan.elsewhere.length === 0
      ? "none stored for other machines"
      : `${plan.elsewhere.length} stored for another machine`;
  return `${pushed}; ${other}.`;
}

export interface ProjectSyncApi {
  /** Why the sync cannot run at all — no account, or no Firebase configuration. Null when it can. */
  unavailable: string | null;
  /** The account's records for projects that are not on this machine. */
  elsewhere: SyncedProject[];
  /** How many projects the account held when the last sync finished. */
  syncedCount: number;
  /** When that sync finished, in epoch milliseconds; null before the first one. */
  lastSyncedAt: number | null;
  /** One line about what the last sync did; null before the first one. */
  result: string | null;
  /** Why the last sync could not finish; null when it did. */
  error: string | null;
  /** Per-project reasons from the last sync: an artefact over the cap, a record kept as stored. */
  notes: string[];
  /** True while a sync is running. The button disables itself on this; nothing else changes. */
  syncing: boolean;
  /** Push the local list, pull the account's, merge them. Never throws. */
  syncNow(): void;
}

export function useProjectSync(): ProjectSyncApi {
  const { status: authStatus, user } = useAuth();
  const uid = authStatus === "signed-in" ? (user?.uid ?? null) : null;
  const projects = useAppStore((state) => state.projects);
  const loading = useAppStore((state) => state.projectsLoading);
  const loadError = useAppStore((state) => state.projectsError);

  const [syncing, setSyncing] = useState(false);
  const [pulled, setPulled] = useState<SyncedProject[]>([]);
  const [syncedCount, setSyncedCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  // One sync at a time in this window. Two windows are handled by the merge, not by a lock: there
  // is nothing here to coordinate over, and a stored record that is already as new wins the tie.
  const inFlight = useRef(false);
  /** True once the registry read has been seen to start, so a sync cannot outrun it. */
  const sawLoading = useRef(false);

  const unavailable =
    firestoreUnavailableReason ?? (uid === null ? "Sign in to sync your projects." : null);

  const runSync = useCallback(async (): Promise<void> => {
    if (uid === null || firestore === null || inFlight.current) return;
    inFlight.current = true;
    setSyncing(true);
    try {
      const local = useAppStore.getState().projects;
      const bound = await boundProjectPath();
      const notes: string[] = [];
      const records = await composeRecords(local, bound === null ? null : projectKey(bound), notes);
      const account = await readAccountProjects(uid);
      if (account.unreadable > 0) {
        const plural = account.unreadable === 1 ? "record" : "records";
        notes.push(
          `${account.unreadable} ${plural} on this account were not in a shape this build can read, and were left alone.`,
        );
      }
      const plan = planSync(records, account.projects, notes);

      // Signing out mid-sync is not a reason to write as nobody. The rules would refuse it; not
      // asking is better, and it is what makes "a signed-out window writes nothing" true even here.
      if (auth === null || auth.currentUser?.uid !== uid) {
        setResult("Signed out before the sync finished — nothing was written.");
        return;
      }

      await writeAccountProjects(uid, plan.writes);
      setPulled(account.projects);
      setSyncedCount(records.size + plan.elsewhere.length);
      setNotes(plan.notes);
      setResult(describeSync(plan));
      setError(null);
      setLastSyncedAt(Date.now());
    } catch (cause) {
      setError(errorMessage(cause, "The sync could not be completed."));
    } finally {
      inFlight.current = false;
      setSyncing(false);
    }
  }, [uid]);

  const syncNow = useCallback((): void => {
    void runSync();
  }, [runSync]);

  // A new sign-in must not open on the previous account's answers.
  useEffect(() => {
    setPulled([]);
    setSyncedCount(0);
    setLastSyncedAt(null);
    setResult(null);
    setNotes([]);
    setError(null);
  }, [uid]);

  useEffect(() => {
    if (loading) sawLoading.current = true;
  }, [loading]);

  /**
   * The registry's own fingerprint. A rename, a newly created project or one forgotten changes it;
   * nothing else does, so a favourite toggled while the launcher is open does not start a sync.
   */
  const signature = projects
    .map((project) => `${project.id}:${project.name}:${project.path}:${project.lastOpenedAt}`)
    .join("|");

  useEffect(() => {
    if (uid === null || unavailable !== null || loading) return;
    // Wait for the registry read to settle. Syncing before it returns would report every stored
    // record as "not on this machine" and push nothing at all.
    if (!sawLoading.current && loadError === null) return;
    void runSync();
  }, [uid, unavailable, loading, loadError, signature, runSync]);

  const elsewhere = useMemo(() => {
    const local = new Set(projects.map((project) => projectKey(project.path)));
    return pulled.filter((entry) => !local.has(projectKey(entry.path)));
  }, [pulled, projects]);

  return {
    unavailable,
    elsewhere,
    syncedCount,
    lastSyncedAt,
    result,
    error,
    notes,
    syncing,
    syncNow,
  };
}
