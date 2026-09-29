/**
 * What the gateway tests need in order to be real.
 *
 * Two things stand in for the outside world, and neither of them is a mock of this code:
 *
 * - the **emulator suite** for identity and Firestore, so a request is authenticated by the same
 *   Admin SDK call production makes, against a real token, and entitlement is read from a real
 *   document;
 * - a **stub upstream**, an HTTP server started inside the test, because the tests must never spend
 *   the Orbital key. It is a real socket peer, not an interception of `fetch`.
 *
 * Everything else — the Express app, the forwarding, the streaming, the accounting — is the code
 * that deploys.
 */

import { EventEmitter, once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { createApp } from "../src/app";
import { UPSTREAM_BASE_URL_ENV, UPSTREAM_KEY_ENV } from "../src/environment";
import { parseJsonRecord } from "../src/values";

export const AUTH_EMULATOR = "127.0.0.1:9099";
export const FIRESTORE_EMULATOR = "127.0.0.1:8080";
export const PROJECT_ID = "demo-orbital";

/** Recognisable, and long enough that redaction has something to find. */
export const UPSTREAM_KEY = "orbital-test-upstream-key-0123456789";

/**
 * Point the Admin SDK at the emulator suite and give the gateway an upstream key. Called before
 * anything touches the Admin SDK: it reads the emulator hosts when the app is created.
 */
export function configureEmulators(): void {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR;
  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR;
  process.env.GCLOUD_PROJECT = PROJECT_ID;
  process.env[UPSTREAM_KEY_ENV] = UPSTREAM_KEY;
  delete process.env[UPSTREAM_BASE_URL_ENV];
}

/**
 * A failure here is the most likely reason a fresh checkout sees red, so it says what to start and
 * where. Both emulators answer `/` when they are up.
 */
export async function assertEmulatorSuiteIsRunning(): Promise<void> {
  const hosts: readonly (readonly [string, string])[] = [
    ["auth", AUTH_EMULATOR],
    ["firestore", FIRESTORE_EMULATOR],
  ];
  for (const [name, host] of hosts) {
    try {
      const response = await fetch(`http://${host}/`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `the ${name} emulator is not answering on ${host} (${reason}). Start the suite from the ` +
          "repository root: npx firebase emulators:start --only auth,firestore",
      );
    }
  }
}

export interface TestUser {
  readonly uid: string;
  readonly idToken: string;
}

/**
 * A real account in the auth emulator, and the ID token the emulator issued for it — the same token
 * shape the desktop client presents, signed by the same emulator.
 */
export async function createUser(): Promise<TestUser> {
  const response = await fetch(
    `http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `gateway-${randomUUID()}@example.com`,
        password: "correct-horse-battery",
        returnSecureToken: true,
      }),
    },
  );
  const body = (await response.json()) as { localId?: unknown; idToken?: unknown };
  if (typeof body.localId !== "string" || typeof body.idToken !== "string") {
    throw new Error(`the auth emulator did not create an account: HTTP ${response.status}`);
  }
  return { uid: body.localId, idToken: body.idToken };
}

export interface GatewayHandle {
  readonly origin: string;
  readonly app: Express;
  close(): Promise<void>;
}

/** The real app, on a real port. */
export async function startGateway(): Promise<GatewayHandle> {
  const app = createApp();
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    app,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

export interface RecordedCall {
  readonly body: Record<string, unknown>;
  readonly headers: IncomingHttpHeaders;
}

/** What a stub handler is given: the parsed body and the response it must answer with. */
export type StubHandler = (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>;

export interface StubUpstream {
  readonly baseUrl: string;
  readonly calls: RecordedCall[];
  /** Resolves once at least `count` requests have arrived; a timeout keeps a hung test from hanging. */
  waitForCalls(count: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * The only provider these tests talk to. It records what it was sent, which is how the tests check
 * that the body crossed over unchanged and that the gateway's key — never the caller's token — is
 * what authenticated the hop.
 */
export async function startStubUpstream(handler: StubHandler): Promise<StubUpstream> {
  const calls: RecordedCall[] = [];
  const arrivals = new EventEmitter();

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = parseJsonRecord(Buffer.concat(chunks).toString("utf8")) ?? {};
      calls.push({ body, headers: request.headers });
      // The handler is invoked before the waiters are released, so a test that waited for the call
      // can also see what the handler did with it (a held response, most of all) — but a handler
      // that takes its time does not hold the waiters, which is how a test can interleave its own
      // work with a request the upstream has not answered yet.
      void Promise.resolve(handler(body, response)).catch((error: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(error instanceof Error ? error.message : "stub handler failed");
      });
      arrivals.emit("call");
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    calls,
    waitForCalls: async (count: number) => {
      while (calls.length < count) await once(arrivals, "call");
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

/** A JSON response from the stub, the way an OpenAI-shaped upstream writes one. */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  response.end(body);
}
