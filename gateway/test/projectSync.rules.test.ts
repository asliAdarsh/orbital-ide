/**
 * What a client may and may not put in its own project record.
 *
 * The record is the one collection a client writes — `users/{uid}/projects/{projectId}`, the list of
 * projects an account holds and the artefacts of each run — so these tests are about the two things
 * that make that safe: the fields are the five the contract names and nothing else, and the record
 * belongs to exactly one person.
 *
 * Like the account-document tests beside this file, they run against the Firestore emulator with the
 * repository's own `firestore.rules` published to it, so what is under test is the file that deploys.
 * Everything a client could do goes over the emulator's REST API as that client, with an unsigned
 * token the emulator reads identity from; the Admin SDK is used only to *look* at what did and did
 * not land, which is the one thing a client could not tell us about a refused write.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { before, describe, it } from "node:test";
import { getFirestore } from "firebase-admin/firestore";
import { adminApp } from "../src/admin";
import { assertEmulatorSuiteIsRunning, configureEmulators, FIRESTORE_EMULATOR, PROJECT_ID } from "./support";

configureEmulators();

const DOCUMENTS = `http://${FIRESTORE_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

/** 64 KB — the cap the client applies to an artefact, and the bound these rules enforce on it. */
const ARTEFACT_LIMIT = 64 * 1024;

/** The five keys a record may carry. */
const RECORD_KEYS = ["title", "path", "phase", "updatedAt", "artefacts"] as const;

/** A document id in the shape the client derives from a project's path. */
function digestId(seed: string): string {
  return (seed + seed).replace(/[^0-9a-f]/g, "0").slice(0, 16).padEnd(16, "0");
}

/** A valid record, which each test then bends in exactly one place. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Todo list",
    path: "C:\\Work\\todo",
    phase: "build",
    updatedAt: 1_790_000_000,
    artefacts: { plan: "# Plan\n\n- one requirement\n" },
    ...overrides,
  };
}

/** The rules exactly as the repository ships them. */
async function publishRules(): Promise<void> {
  const content = await readFile(path.resolve(__dirname, "..", "..", "firestore.rules"), "utf8");
  const response = await fetch(`http://${FIRESTORE_EMULATOR}/emulator/v1/projects/${PROJECT_ID}:securityRules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }),
  });
  assert.equal(response.status, 200, "the emulator accepted the repository's rules");
}

/**
 * A token in the shape the emulator reads identity from. Unsigned on purpose: the emulator does not
 * check a signature, which is what lets these tests say "I am this uid" and nothing more.
 */
function emulatorToken(uid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const claims = {
    user_id: uid,
    sub: uid,
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
  };
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
}

/** A marker so one test can write a genuine `timestampValue`, the other shape `updatedAt` accepts. */
class TimestampAt {
  constructor(readonly at: string) {}
}

function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof TimestampAt) return { timestampValue: value.at };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, toFirestoreValue(entry)]),
        ),
      },
    };
  }
  throw new Error(`these tests write scalars and maps only; got ${typeof value}`);
}

interface Call {
  readonly method: "GET" | "PATCH" | "DELETE";
  /** The uid to present, or null to present nothing at all. */
  readonly uid: string | null;
  readonly fields?: Record<string, unknown>;
  /** Field paths to update. Omitted, the write is the create of a whole document. */
  readonly mask?: readonly string[];
  /** Ask the emulator to fail if the document already exists, i.e. a genuine create. */
  readonly mustNotExist?: boolean;
}

/** One REST call as a given caller, and the status the rules decided for it. */
async function firestoreCall(documentPath: string, call: Call): Promise<number> {
  const url = new URL(`${DOCUMENTS}/${documentPath}`);
  for (const field of call.mask ?? []) url.searchParams.append("updateMask.fieldPaths", field);
  if (call.mustNotExist === true) url.searchParams.set("currentDocument.exists", "false");

  const headers: Record<string, string> = {};
  if (call.uid !== null) headers.authorization = `Bearer ${emulatorToken(call.uid)}`;
  let body: string | undefined;
  if (call.fields !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify({
      fields: Object.fromEntries(
        Object.entries(call.fields).map(([key, value]) => [key, toFirestoreValue(value)]),
      ),
    });
  }

  const response = await fetch(url, { method: call.method, headers, body });
  return response.status;
}

/** What the account actually holds, read with the Admin SDK — a refused write must leave nothing. */
async function storedRecord(documentPath: string): Promise<Record<string, unknown> | null> {
  const snapshot = await getFirestore(adminApp()).doc(documentPath).get();
  return snapshot.exists ? (snapshot.data() as Record<string, unknown>) : null;
}

before(async () => {
  await assertEmulatorSuiteIsRunning();
  await publishRules();
});

describe("a project record's rules", () => {
  it("lets a signed-in user create, update and read their own record", async () => {
    const uid = randomUUID();
    const documentId = digestId("a1");
    const target = `users/${uid}/projects/${documentId}`;

    assert.equal(
      await firestoreCall(target, { method: "PATCH", uid, fields: record(), mustNotExist: true }),
      200,
      "a record in the contract's shape is written",
    );
    assert.equal(await firestoreCall(target, { method: "GET", uid }), 200);
    assert.equal(
      await firestoreCall(target, {
        method: "PATCH",
        uid,
        fields: record({ title: "Todo list, renamed", updatedAt: 1_790_000_500, artefacts: {} }),
        mask: RECORD_KEYS,
      }),
      200,
      "and can be brought up to date",
    );

    const stored = await storedRecord(target);
    assert.equal(stored?.title, "Todo list, renamed");
    assert.equal(stored?.updatedAt, 1_790_000_500);
  });

  it("accepts a timestamp for updatedAt, which is the other shape the contract allows", async () => {
    const uid = randomUUID();
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${digestId("a2")}`, {
        method: "PATCH",
        uid,
        fields: record({ updatedAt: new TimestampAt("2026-09-27T10:00:00Z") }),
        mustNotExist: true,
      }),
      200,
    );
  });

  it("keeps a record to the person it belongs to", async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    const target = `users/${owner}/projects/${digestId("b1")}`;
    assert.equal(await firestoreCall(target, { method: "PATCH", uid: owner, fields: record(), mustNotExist: true }), 200);

    assert.equal(await firestoreCall(target, { method: "GET", uid: stranger }), 403);
    assert.equal(await firestoreCall(target, { method: "GET", uid: null }), 403);
    assert.equal(
      await firestoreCall(target, {
        method: "PATCH",
        uid: stranger,
        fields: record({ title: "not mine" }),
        mask: ["title"],
      }),
      403,
    );
    assert.equal(
      await firestoreCall(target, { method: "PATCH", uid: null, fields: record({ title: "anon" }), mask: ["title"] }),
      403,
    );

    const stored = await storedRecord(target);
    assert.equal(stored?.title, "Todo list", "a refused write left the record exactly as it was");
  });

  it("refuses a record carrying anything but the keys it names", async () => {
    const uid = randomUUID();
    const id = digestId("c1");
    // A key of the shape that would matter most if it were ever allowed through.
    const withExtra = { ...record(), apiKey: "sk-not-a-real-key" };
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: withExtra,
        mustNotExist: true,
      }),
      403,
      "a credential has nowhere to go in this document",
    );

    const { artefacts: _artefacts, ...missingArtefacts } = record();
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: missingArtefacts,
        mustNotExist: true,
      }),
      403,
      "every key the contract names has to be there",
    );

    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: record({ title: 42 }),
        mustNotExist: true,
      }),
      403,
      "a text field that is not text",
    );
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: record({ updatedAt: "yesterday" }),
        mustNotExist: true,
      }),
      403,
      "updatedAt is a number or a timestamp, never the client's own words",
    );
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: record({ phase: "p".repeat(33) }),
        mustNotExist: true,
      }),
      403,
      "a phase is an id, not a paragraph",
    );
  });

  it("refuses an artefact that is not one of the three, or is not text", async () => {
    const uid = randomUUID();
    const id = digestId("d1");
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: record({ artefacts: { notes: "some other file" } }),
        mustNotExist: true,
      }),
      403,
    );
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: record({ artefacts: { plan: 3 } }),
        mustNotExist: true,
      }),
      403,
    );
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: record({ artefacts: "agent/plan.md" }),
        mustNotExist: true,
      }),
      403,
      "artefacts is a map of texts, not a path",
    );
  });

  it("accepts an artefact at the cap and refuses one over it", async () => {
    const uid = randomUUID();
    const id = digestId("e1");
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: record({ artefacts: { plan: "a".repeat(ARTEFACT_LIMIT) } }),
        mustNotExist: true,
      }),
      200,
    );
    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}`, {
        method: "PATCH",
        uid,
        fields: record({ artefacts: { plan: "a".repeat(ARTEFACT_LIMIT + 1) } }),
      }),
      403,
      "a client that forgot to check the size is refused rather than storing half a plan",
    );
  });

  it("refuses a document id that is not a project path's digest", async () => {
    const uid = randomUUID();
    assert.equal(
      await firestoreCall(`users/${uid}/projects/my-favourite-project`, {
        method: "PATCH",
        uid,
        fields: record(),
        mustNotExist: true,
      }),
      403,
      "the collection holds one document per project path, not arbitrary storage",
    );
  });

  it("leaves the account document's own restrictions where they were", async () => {
    const uid = randomUUID();
    assert.equal(
      await firestoreCall(`users/${uid}`, {
        method: "PATCH",
        uid,
        fields: { tokensUsed: 0 },
        mask: ["tokensUsed"],
      }),
      403,
      "a project record's rule must not have widened the document above it",
    );
  });

  it("leaves everything the rules do not name closed, including under a record", async () => {
    const uid = randomUUID();
    const id = digestId("f1");
    assert.equal(await firestoreCall(`users/${uid}/projects/${id}`, { method: "PATCH", uid, fields: record(), mustNotExist: true }), 200);

    assert.equal(
      await firestoreCall(`users/${uid}/projects/${id}/notes/1`, {
        method: "PATCH",
        uid,
        fields: { text: "anything" },
        mustNotExist: true,
      }),
      403,
      "the match is on the record, not on everything beneath it",
    );
    assert.equal(await firestoreCall(`users/${uid}/projects/${id}/notes/1`, { method: "GET", uid }), 403);
    assert.equal(await firestoreCall(`projects/${id}`, { method: "GET", uid }), 403);
  });

  it("lets the owner remove their own record, and nobody else", async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    const target = `users/${owner}/projects/${digestId("9a")}`;
    assert.equal(await firestoreCall(target, { method: "PATCH", uid: owner, fields: record(), mustNotExist: true }), 200);

    assert.equal(await firestoreCall(target, { method: "DELETE", uid: stranger }), 403);
    assert.notEqual(await storedRecord(target), null, "a refused delete leaves the record in place");

    assert.equal(await firestoreCall(target, { method: "DELETE", uid: owner }), 200);
    assert.equal(await storedRecord(target), null);
  });
});
