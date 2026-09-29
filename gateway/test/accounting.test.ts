/**
 * The bookkeeping half of the contract, alone in its own file.
 *
 * Terminating the Admin SDK's Firestore client partway through a request is the only way to make the
 * accounting write fail for a reason the gateway cannot control. It is also irreversible for the
 * process — later Firestore calls on that client fail by design — which is why this file holds one
 * test and reads nothing from Firestore afterwards.
 *
 * The timing is exact rather than hoped for: the upstream holds its answer until the test says so, so
 * the entitlement read has already succeeded when Firestore is taken away and it is only the
 * accounting write that meets a dead client.
 */

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { before, it } from "node:test";
import { getFirestore } from "firebase-admin/firestore";
import { adminApp } from "../src/admin";
import { UPSTREAM_BASE_URL_ENV } from "../src/environment";
import {
  assertEmulatorSuiteIsRunning,
  configureEmulators,
  createUser,
  sendJson,
  startGateway,
  startStubUpstream,
} from "./support";

configureEmulators();

before(async () => {
  await assertEmulatorSuiteIsRunning();
});

it(
  "delivers the completion, and logs, when the bookkeeping write cannot run at all",
  { timeout: 30_000 },
  async () => {
    const user = await createUser();
    const release = new EventEmitter();

    const stub = await startStubUpstream(async (_body, response) => {
      await once(release, "release");
      sendJson(response, 200, {
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "deepseek-v4-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "still delivered" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      });
    });
    process.env[UPSTREAM_BASE_URL_ENV] = stub.baseUrl;
    const gateway = await startGateway();

    // The gateway's own log is the only sign the failure was noticed, so it is captured — and the
    // capture is an event too, which is what keeps this test free of any waiting on the clock.
    const announced = new EventEmitter();
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
      logged.push(line);
      announced.emit("logged", line);
    };

    try {
      const settled = once(announced, "logged");
      const pending = fetch(`${gateway.origin}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${user.idToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "the prompt nobody should ever see in a log" }],
          max_tokens: 64,
        }),
      });

      await stub.waitForCalls(1);
      await getFirestore(adminApp()).terminate();
      release.emit("release");

      const response = await pending;
      assert.equal(response.status, 200, "a bookkeeping failure is not the caller's problem");
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      assert.equal(body.choices?.[0]?.message?.content, "still delivered");

      const [line] = (await settled) as [string];
      assert.match(line, /usage accounting failed/);
      assert.match(line, new RegExp(user.uid), "the account is named, so the failure can be acted on");
      assert.match(line, /"totalTokens":3/, "the figure it could not record is named");
      assert.equal(line.includes("the prompt nobody should ever see in a log"), false);
      assert.equal(line.includes("still delivered"), false);
      assert.equal(line.includes(user.idToken), false);
      assert.equal(logged.length, 1);
    } finally {
      console.error = originalError;
      await gateway.close();
      await stub.close();
      delete process.env[UPSTREAM_BASE_URL_ENV];
    }
  },
);
