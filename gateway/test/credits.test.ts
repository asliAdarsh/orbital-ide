/**
 * The credits half of the contract, over a real socket: what a prompt costs, what it charges, what
 * happens when the month turns over, and what `/v1/models` and `/v1/account` answer.
 *
 * Same two stand-ins as the other proxy tests — the emulator suite for identity and Firestore, and a
 * stub HTTP server for the provider. Nothing here talks to the real upstream or spends a real key.
 */

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { before, describe, it } from "node:test";
import { getFirestore } from "firebase-admin/firestore";
import { adminApp } from "../src/admin";
import { CATALOGUE, PLANS, type CatalogueEntry, type PlanDefinition } from "../src/config";
import { allowanceResetAt } from "../src/entitlement";
import { UPSTREAM_BASE_URL_ENV } from "../src/environment";
import {
  assertEmulatorSuiteIsRunning,
  configureEmulators,
  createUser,
  sendJson,
  startGateway,
  startStubUpstream,
  type GatewayHandle,
  type StubHandler,
  type StubUpstream,
  type TestUser,
} from "./support";

configureEmulators();

before(async () => {
  await assertEmulatorSuiteIsRunning();
});

/**
 * The tiers as the owner fixed them, written out again on purpose: a table that a test reads back
 * from itself cannot catch a table that regressed, and the cost of a model is the one number a user
 * is charged on.
 */
const EXPECTED_COSTS: Readonly<Record<string, number>> = {
  "deepseek-flash": 0.5,
  "deepseek-v4-flash": 0.5,
  "deepseek-v4-flash-vision-exp": 0.5,
  "glm-5.3-flash": 0.5,
  hy3: 0.5,
  "longcat-2.0": 0.5,
  "longcat-2.5-preview-free": 0.5,
  "mimo-v2.6-flash": 0.5,
  "minimax-m2.5": 0.5,
  "muse-spark-1.2-contributor": 0.5,
  "muse-spark-1.3-contributor": 0.5,
  "qwen3.8-flash": 0.5,
  "space-bunny-free": 0.5,
  "deepseek-v4.1-flash": 1,
  "glm-5.1": 1,
  "glm-5.2": 1,
  "glm-5.3": 1,
  "grok-4.6": 1,
  "hy4-preview": 1,
  "kimi-k2.6": 1,
  "kimi-k2.7-code": 1,
  "mimo-v2.5": 1,
  "mimo-v2.5-pro": 1,
  "mimo-v2.6-pro": 1,
  "minimax-m2.7": 1,
  "omen-alpha": 1,
  "qwen3.6-plus": 1,
  "qwen3.7-plus": 1,
  "deepseek-v4-pro": 2,
  "grok-4.7": 2,
  "gpt-5.6-luna": 2,
  "gpt-6-luna": 2,
  "kimi-k3": 2,
  "minimax-m3": 2,
  "qwen3.7-max": 2,
  "qwen3.8-max": 2,
};

/**
 * The instant the gateway itself writes as a period's end: the 1st of the next month, UTC. Tests
 * seed it rather than a fresh `now + 30 days`, because that is the only shape the gateway ever
 * stores and the refusal reads it back to a person.
 */
function nextMonthReset(): number {
  return Math.floor(allowanceResetAt(new Date()).getTime() / 1000);
}

function accountDocument(uid: string) {
  return getFirestore(adminApp()).doc(`users/${uid}`);
}

/** The gateway's own write, seeded with the Admin SDK so the document is exactly the shape it reads. */
async function seedAccount(uid: string, data: Record<string, unknown>): Promise<void> {
  await accountDocument(uid).set(data);
}

async function updateAccount(uid: string, data: Record<string, unknown>): Promise<void> {
  await accountDocument(uid).set(data, { merge: true });
}

async function readAccountDocument(uid: string): Promise<Record<string, unknown>> {
  return (await accountDocument(uid).get()).data() ?? {};
}

async function usageRecords(uid: string): Promise<Record<string, unknown>[]> {
  return (await getFirestore(adminApp()).collection(`users/${uid}/usage`).get()).docs.map((doc) => doc.data());
}

interface ErrorEnvelope {
  readonly error: { readonly message: string; readonly type: string; readonly code: string };
}

async function errorOf(response: Response): Promise<ErrorEnvelope["error"]> {
  const body = (await response.json()) as Partial<ErrorEnvelope>;
  return {
    message: body.error?.message ?? "",
    type: body.error?.type ?? "",
    code: body.error?.code ?? "",
  };
}

function clientBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "Write the phase plan." }],
    max_tokens: 256,
    ...overrides,
  };
}

function completion(content: string, usage: Record<string, number> | null): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "deepseek-v4-flash",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...(usage === null ? {} : { usage }),
  };
}

function answerWith(content: string, usage: Record<string, number> | null): StubHandler {
  return (_body, response) => {
    sendJson(response, 200, completion(content, usage));
  };
}

function postCompletion(
  gateway: GatewayHandle,
  user: TestUser,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${gateway.origin}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${user.idToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getRoute(gateway: GatewayHandle, path: string, user: TestUser): Promise<Response> {
  return fetch(`${gateway.origin}${path}`, { headers: { authorization: `Bearer ${user.idToken}` } });
}

/** A gateway pointed at a stub upstream, torn down whatever the test does with it. */
async function withStubUpstream(
  handler: StubHandler,
  body: (stub: StubUpstream, gateway: GatewayHandle) => Promise<void>,
): Promise<void> {
  const stub = await startStubUpstream(handler);
  process.env[UPSTREAM_BASE_URL_ENV] = stub.baseUrl;
  const gateway = await startGateway();
  try {
    await body(stub, gateway);
  } finally {
    await gateway.close();
    await stub.close();
    delete process.env[UPSTREAM_BASE_URL_ENV];
  }
}

/**
 * Wait for the accounting write, which deliberately runs after the response has been handed over.
 * A document listener is the signal — an event, not a guessed delay — and the snapshot that arrives
 * on subscribing is what makes a write that already landed impossible to miss. The wait carries a
 * deadline rather than a delay: nothing in the happy path waits on a clock, and the bound only stops
 * a charge that never lands from hanging the run.
 */
async function waitForAccount(
  uid: string,
  matches: (data: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const settled = new EventEmitter();
  const deadline = AbortSignal.timeout(20_000);
  const arrived = once(settled, "settled", { signal: deadline }) as Promise<
    [{ readonly data?: Record<string, unknown>; readonly error?: unknown }]
  >;
  const unsubscribe = accountDocument(uid).onSnapshot(
    (snapshot) => {
      const data = snapshot.data() ?? {};
      if (matches(data)) settled.emit("settled", { data });
    },
    (error: unknown) => settled.emit("settled", { error }),
  );
  try {
    const [outcome] = await arrived;
    if (outcome.error !== undefined) {
      throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
    }
    return outcome.data ?? {};
  } catch (error) {
    if (deadline.aborted) throw new Error(`no accounting write landed for ${uid} within 20s`);
    throw error;
  } finally {
    unsubscribe();
  }
}

const WAITING_TEST = { timeout: 30_000 };

describe("the free plan's credits", () => {
  it("reports the allowance, the remaining credits and the refill instant", async () => {
    const user = await createUser();
    const resetsAt = nextMonthReset();
    await seedAccount(user.uid, {
      plan: "free",
      creditsLimit: 30,
      creditsUsed: 12,
      creditsResetAt: resetsAt,
    });
    const gateway = await startGateway();
    try {
      const response = await getRoute(gateway, "/v1/account", user);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        plan: "free",
        credits: {
          limit: 30,
          used: 12,
          remaining: 18,
          resets_at: new Date(resetsAt * 1000).toISOString(),
        },
      });
    } finally {
      await gateway.close();
    }
  });

  it("refuses /v1/account without a verified token, because it names whose credits they are", async () => {
    const gateway = await startGateway();
    try {
      const anonymous = await fetch(`${gateway.origin}/v1/account`);
      assert.equal(anonymous.status, 401);
      const refusal = await errorOf(anonymous);
      assert.equal(refusal.type, "invalid_request_error");
      assert.equal(refusal.code, "unauthenticated");
      assert.match(refusal.message, /Authorization/);
    } finally {
      await gateway.close();
    }
  });

  it("treats an account with no document at all as the free plan's full allowance", async () => {
    const user = await createUser();
    const gateway = await startGateway();
    try {
      const response = await getRoute(gateway, "/v1/account", user);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { plan: string; credits: Record<string, unknown> };
      assert.equal(body.plan, "free");
      assert.equal(body.credits.limit, 30);
      assert.equal(body.credits.used, 0);
      assert.equal(body.credits.remaining, 30);
      // The refill instant a request would be checked against is the 1st of the next month, UTC.
      assert.equal(body.credits.resets_at, allowanceResetAt(new Date()).toISOString());
      assert.match(String(body.credits.resets_at), /^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    } finally {
      await gateway.close();
    }
  });

  it("refuses a prompt the remaining credits cannot pay for, before the provider hears about it", async () => {
    const spent = await createUser();
    const almost = await createUser();
    await seedAccount(spent.uid, { plan: "free", creditsLimit: 30, creditsUsed: 30, creditsResetAt: nextMonthReset() });
    await seedAccount(almost.uid, { plan: "free", creditsLimit: 30, creditsUsed: 29.5, creditsResetAt: nextMonthReset() });

    await withStubUpstream(answerWith("never sent", null), async (stub, gateway) => {
      const response = await postCompletion(gateway, spent, clientBody());
      assert.equal(response.status, 402);
      const refusal = await errorOf(response);
      assert.equal(refusal.type, "insufficient_credits");
      assert.equal(refusal.code, "allowance_exhausted");
      // The message has to name the model, what it costs and when the allowance comes back, because
      // "out of credits" without a date is a dead end for the person reading it.
      assert.match(refusal.message, /deepseek-v4-flash/);
      assert.match(refusal.message, /0\.5 credits per prompt/);
      assert.match(refusal.message, /refill on 1 \w+ \d{4} at 00:00 UTC/);
      assert.match(refusal.message, /T00:00:00\.000Z/);

      // Half a credit is not enough for a two-credit model, even though the account is not empty.
      const short = await postCompletion(gateway, almost, clientBody({ model: "qwen3.8-max" }));
      assert.equal(short.status, 402);
      assert.match((await errorOf(short)).message, /2 credits per prompt/);

      assert.equal(stub.calls.length, 0);
    });
  });

  it("serves a prompt the remaining credits exactly cover", async () => {
    const user = await createUser();
    await seedAccount(user.uid, { plan: "free", creditsLimit: 30, creditsUsed: 29.5, creditsResetAt: nextMonthReset() });
    await withStubUpstream(
      answerWith("exactly enough", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      async (stub, gateway) => {
        const response = await postCompletion(gateway, user, clientBody());
        assert.equal(response.status, 200);
        await response.text();
        const account = await waitForAccount(user.uid, (data) => data.creditsUsed === 30);
        assert.equal(account.creditsUsed, 30);
        assert.equal(stub.calls.length, 1);
      },
    );
  });

  it("charges exactly the model's cost, once, for a non-streamed prompt", WAITING_TEST, async () => {
    const user = await createUser();
    await seedAccount(user.uid, { plan: "free", creditsLimit: 30, creditsUsed: 0, creditsResetAt: nextMonthReset() });
    await withStubUpstream(
      answerWith("the plan", { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 }),
      async (_stub, gateway) => {
        const cheap = await postCompletion(gateway, user, clientBody());
        assert.equal(cheap.status, 200);
        await cheap.text();
        const afterCheap = await waitForAccount(user.uid, (data) => data.creditsUsed === 0.5);
        // Tokens still move exactly as they did before credits existed: this is an addition.
        assert.equal(afterCheap.tokensUsed, 52);

        const dear = await postCompletion(gateway, user, clientBody({ model: "qwen3.8-max" }));
        assert.equal(dear.status, 200);
        await dear.text();
        const afterDear = await waitForAccount(user.uid, (data) => data.creditsUsed === 2.5);
        assert.equal(afterDear.creditsUsed, 2.5);

        const records = await usageRecords(user.uid);
        assert.equal(records.length, 2);
        assert.deepEqual(
          records.map((record) => record.credits).sort((a, b) => Number(a) - Number(b)),
          [0.5, 2],
        );
      },
    );
  });

  it("charges one prompt's cost for a streamed completion, whatever it contains", WAITING_TEST, async () => {
    const user = await createUser();
    await seedAccount(user.uid, { plan: "free", creditsLimit: 30, creditsUsed: 0, creditsResetAt: nextMonthReset() });
    const frames = [
      `data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "one " } }] })}\n\n`,
      `data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "two" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    await withStubUpstream(
      (_body, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(Buffer.from(frames, "utf8"));
      },
      async (_stub, gateway) => {
        const response = await postCompletion(gateway, user, clientBody({ model: "glm-5.3", stream: true }));
        assert.equal(await response.text(), frames);
        const account = await waitForAccount(user.uid, (data) => data.creditsUsed === 1);
        // glm-5.3 is a one-credit model: a forty-token completion is still one prompt.
        assert.equal(account.creditsUsed, 1);
        assert.equal(account.tokensUsed, 40);
      },
    );
  });

  it("charges nothing for a prompt the upstream refused", WAITING_TEST, async () => {
    const user = await createUser();
    await withStubUpstream(
      (body, response) => {
        if (body.model === "glm-5.1") {
          sendJson(response, 500, { error: { message: "the provider gave up" } });
          return;
        }
        sendJson(response, 200, completion("delivered", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
      },
      async (_stub, gateway) => {
        const failed = await postCompletion(gateway, user, clientBody({ model: "glm-5.1" }));
        assert.equal(failed.status, 502);
        await failed.text();

        // The only way to prove a counter did *not* move is to move it afterwards and check the
        // figure: this prompt costs two, so a total of three would mean the failure was charged.
        const served = await postCompletion(gateway, user, clientBody({ model: "qwen3.8-max" }));
        assert.equal(served.status, 200);
        await served.text();
        const account = await waitForAccount(user.uid, (data) => data.creditsUsed === 2);
        assert.equal(account.creditsUsed, 2);
        assert.equal((await usageRecords(user.uid)).length, 1);
      },
    );
  });

  it("zeroes the month's usage once, and not again, on the first read past the refill", async () => {
    const user = await createUser();
    const lastMonth = Math.floor(Date.now() / 1000) - 60;
    await seedAccount(user.uid, {
      plan: "free",
      creditsLimit: 30,
      creditsUsed: 30,
      creditsResetAt: lastMonth,
    });
    const expectedReset = allowanceResetAt(new Date());

    const gateway = await startGateway();
    try {
      const first = await getRoute(gateway, "/v1/account", user);
      assert.equal(first.status, 200);
      const body = (await first.json()) as { credits: Record<string, unknown> };
      assert.equal(body.credits.used, 0);
      assert.equal(body.credits.remaining, 30);
      assert.equal(body.credits.resets_at, expectedReset.toISOString());
      assert.match(String(body.credits.resets_at), /^\d{4}-\d{2}-01T00:00:00\.000Z$/);

      // The reset is a write, so the period the next request reads is the one this read started.
      const reset = await readAccountDocument(user.uid);
      assert.equal(reset.creditsUsed, 0);
      assert.equal(reset.creditsResetAt, Math.floor(expectedReset.getTime() / 1000));

      // Idempotent: usage that accumulated inside the new period is not zeroed by reading again.
      await updateAccount(user.uid, { creditsUsed: 7 });
      const second = await getRoute(gateway, "/v1/account", user);
      const after = (await second.json()) as { credits: Record<string, unknown> };
      assert.equal(after.credits.used, 7);
      assert.equal(after.credits.remaining, 23);
      assert.equal(after.credits.resets_at, expectedReset.toISOString());
    } finally {
      await gateway.close();
    }
  });

  it("lists every catalogue model with the tier it costs", async () => {
    const user = await createUser();
    const gateway = await startGateway();
    try {
      const response = await getRoute(gateway, "/v1/models", user);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: { id: string; credits_per_prompt: number }[] };
      const costs = Object.fromEntries(body.data.map((entry) => [entry.id, entry.credits_per_prompt]));
      assert.deepEqual(costs, EXPECTED_COSTS);
      assert.equal(body.data.length, CATALOGUE.length);
    } finally {
      await gateway.close();
    }
  });
});

/**
 * The paid-only gate, which no seeded model is behind yet: the mechanism has to work while the plan
 * that uses it does not exist. A paid-only model and a plan that includes them are added to the two
 * tables for the length of this test and removed again, so what is exercised is the real code over
 * the real tables rather than a copy of the decision.
 */
describe("the paid-only gate", () => {
  it("hides a paid-only model from the free plan, and refuses a prompt for it there", WAITING_TEST, async () => {
    const catalogue = CATALOGUE as CatalogueEntry[];
    const plans = PLANS as Record<string, PlanDefinition>;
    const originalLength = catalogue.length;
    const paidOnly: CatalogueEntry = {
      id: "orbital-paid-only",
      ownedBy: "orbital",
      upstream: "orbital-paid-only",
      creditsPerPrompt: 2,
      paidOnly: true,
    };
    catalogue.push(paidOnly);
    plans["pro"] = { creditsLimit: 1000, monthlyRefill: false, includesPaidOnlyModels: true };

    const free = await createUser();
    const paid = await createUser();
    await seedAccount(paid.uid, {
      plan: "pro",
      creditsLimit: 1000,
      creditsUsed: 0,
      creditsResetAt: nextMonthReset(),
    });

    try {
      await withStubUpstream(answerWith("paid for", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }), async (stub, gateway) => {
        const freeList = (await (await getRoute(gateway, "/v1/models", free)).json()) as {
          data: { id: string }[];
        };
        assert.equal(freeList.data.some((entry) => entry.id === paidOnly.id), false);

        const paidList = (await (await getRoute(gateway, "/v1/models", paid)).json()) as {
          data: { id: string; credits_per_prompt: number }[];
        };
        assert.deepEqual(
          paidList.data.find((entry) => entry.id === paidOnly.id),
          { id: paidOnly.id, object: "model", owned_by: "orbital", credits_per_prompt: 2 },
        );

        const refused = await postCompletion(gateway, free, clientBody({ model: paidOnly.id }));
        assert.equal(refused.status, 403);
        assert.equal((await errorOf(refused)).code, "model_not_available_on_plan");
        assert.equal(stub.calls.length, 0, "a plan that may not use the model never spends the key on it");

        const served = await postCompletion(gateway, paid, clientBody({ model: paidOnly.id }));
        assert.equal(served.status, 200);
        await served.text();
        const account = await waitForAccount(paid.uid, (data) => data.creditsUsed === 2);
        assert.equal(account.creditsUsed, 2);
        assert.equal(stub.calls.length, 1);
      });
    } finally {
      catalogue.length = originalLength;
      delete plans["pro"];
    }
  });
});
