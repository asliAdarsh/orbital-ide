/**
 * What a client may and may not do with its own account document.
 *
 * These run against the Firestore emulator with the repository's own `firestore.rules` published to
 * it, so what is under test is the file that deploys rather than a copy of it kept in step by hand.
 *
 * The Admin SDK is used to *seed* a document, because it bypasses rules by design — the gateway
 * writes accounts that way. Everything a client could do goes over the emulator's REST API as that
 * client, with an unsigned token the emulator reads identity from.
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

function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  throw new Error(`these tests write scalars only; got ${typeof value}`);
}

interface Call {
  readonly method: "GET" | "PATCH" | "DELETE";
  /** The uid to present, or null to present nothing at all. */
  readonly uid: string | null;
  readonly fields?: Record<string, unknown>;
  /** A field mask, so the write is a targeted update rather than a whole-document replacement. */
  readonly mask?: string;
  /** Ask the emulator to fail if the document already exists, i.e. a genuine create. */
  readonly mustNotExist?: boolean;
}

/** One REST call as a given caller, and the status the rules decided for it. */
async function firestoreCall(documentPath: string, call: Call): Promise<number> {
  const url = new URL(`${DOCUMENTS}/${documentPath}`);
  if (call.mask !== undefined) url.searchParams.set("updateMask.fieldPaths", call.mask);
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

/** What the gateway would have written; seeded with the Admin SDK, which is allowed to. */
async function seedAccount(uid: string, data: Record<string, unknown>): Promise<void> {
  await getFirestore(adminApp()).doc(`users/${uid}`).set(data);
}

before(async () => {
  await assertEmulatorSuiteIsRunning();
  await publishRules();
});

describe("the account document's rules", () => {
  it("lets a signed-in user read their own document, and nobody else read it", async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    await seedAccount(owner, { plan: "free", tokensUsed: 10, tokensLimit: 100 });

    assert.equal(await firestoreCall(`users/${owner}`, { method: "GET", uid: owner }), 200);
    assert.equal(await firestoreCall(`users/${owner}`, { method: "GET", uid: stranger }), 403);
    assert.equal(await firestoreCall(`users/${owner}`, { method: "GET", uid: null }), 403);
  });

  it("lets a user write their own display-level fields", async () => {
    const uid = randomUUID();

    assert.equal(
      await firestoreCall(`users/${uid}`, {
        method: "PATCH",
        uid,
        fields: { displayName: "Adarsh" },
        mustNotExist: true,
      }),
      200,
    );
    assert.equal(
      await firestoreCall(`users/${uid}`, {
        method: "PATCH",
        uid,
        fields: { photoURL: "https://example.com/me.png" },
      }),
      200,
    );
  });

  it("refuses a user writing anything an entitlement is read from", async () => {
    const serverOwned: readonly (readonly [string, unknown])[] = [
      ["tokensUsed", 0],
      ["tokensLimit", 9_999_999],
      ["disabled", false],
      ["plan", "pro"],
      ["creditsUsed", 0],
      ["creditsLimit", 9_999_999],
      ["creditsResetAt", 0],
      ["updatedAt", "2026-01-01T00:00:00Z"],
    ];
    for (const [field, value] of serverOwned) {
      const uid = randomUUID();
      await seedAccount(uid, {
        plan: "free",
        tokensUsed: 500,
        tokensLimit: 500,
        disabled: true,
        creditsUsed: 30,
        creditsLimit: 30,
        creditsResetAt: 1_900_000_000,
      });
      assert.equal(
        await firestoreCall(`users/${uid}`, { method: "PATCH", uid, fields: { [field]: value }, mask: field }),
        403,
        `${field} must not be writable by the client it is about`,
      );
    }
  });

  it("refuses a user creating their own document with anything but display fields", async () => {
    const uid = randomUUID();
    assert.equal(
      await firestoreCall(`users/${uid}`, {
        method: "PATCH",
        uid,
        fields: { tokensUsed: 0 },
        mustNotExist: true,
      }),
      403,
    );
    // A fresh account that creates itself with credits has already credited itself.
    const creditUid = randomUUID();
    assert.equal(
      await firestoreCall(`users/${creditUid}`, {
        method: "PATCH",
        uid: creditUid,
        fields: { creditsUsed: 0, creditsLimit: 9999, creditsResetAt: 0 },
        mustNotExist: true,
      }),
      403,
    );
  });

  it("refuses a user deleting the document, which would reset their entitlement", async () => {
    const uid = randomUUID();
    await seedAccount(uid, { tokensUsed: 500, tokensLimit: 500 });
    assert.equal(await firestoreCall(`users/${uid}`, { method: "DELETE", uid }), 403);
  });

  it("keeps the gateway's usage records closed to the user they are about", async () => {
    const uid = randomUUID();
    await seedAccount(uid, { tokensUsed: 10, tokensLimit: 100 });

    assert.equal(await firestoreCall(`users/${uid}/usage/record-1`, { method: "GET", uid }), 403);
    assert.equal(
      await firestoreCall(`users/${uid}/usage/record-1`, {
        method: "PATCH",
        uid,
        fields: { totalTokens: 0 },
        mustNotExist: true,
      }),
      403,
    );
  });
});
