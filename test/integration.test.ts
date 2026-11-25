import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceptionistServer } from "../src/service.ts";
import { EventStore } from "../src/event-store.ts";
import { Providers } from "../src/providers.ts";

test("webhook authenticates, handles function calls, and deduplicates retries", async () => {
  process.env.MOCK_INTEGRATIONS = "true";
  process.env.NODE_ENV = "test";
  process.env.VAPI_WEBHOOK_SECRET = "test-vapi-secret";
  process.env.ADMIN_API_KEY = "test-admin-secret";
  process.env.EVENT_STORE_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  const dir = await mkdtemp(join(tmpdir(), "voice-agent-integration-"));
  const { server, store } = createReceptionistServer({ store: new EventStore(join(dir, "events.json")) });
  await store.load();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  try {
    const denied = await fetch(`${baseUrl}/webhooks/vapi`, { method: "POST", body: "{}" });
    assert.equal(denied.status, 401);
    const body = { message: { type: "tool-calls", call: { id: "demo-call-100" }, toolCallList: [{ id: "tool-1", function: { name: "check_appointment_availability", arguments: "{}" } }] } };
    const headers = { authorization: "Bearer test-vapi-secret", "content-type": "application/json" };
    const first = await fetch(`${baseUrl}/webhooks/vapi`, { method: "POST", headers, body: JSON.stringify(body) });
    const firstJson = await first.json() as { results: Array<{ result: { availableSlots: string[] } }> };
    assert.equal(first.status, 200);
    assert.equal(firstJson.results[0].result.availableSlots.length, 3);
    const duplicate = await fetch(`${baseUrl}/webhooks/vapi`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.deepEqual(await duplicate.json(), { accepted: true, duplicate: true, status: "completed" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed post-call webhook is stored and replayed successfully", async () => {
  process.env.MOCK_INTEGRATIONS = "true";
  process.env.NODE_ENV = "test";
  process.env.VAPI_WEBHOOK_SECRET = "test-vapi-secret";
  process.env.ADMIN_API_KEY = "test-admin-secret";
  process.env.MOCK_FAIL_ONCE = "make";
  const dir = await mkdtemp(join(tmpdir(), "voice-agent-replay-"));
  const store = new EventStore(join(dir, "events.json"));
  const { server } = createReceptionistServer({ store, providers: new Providers() });
  await store.load();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const body = { message: { type: "end-of-call-report", call: { id: "demo-call-200", customer: { number: "+13035550101" } }, artifact: { transcript: "Caller Alex needs a routine roof inspection and asked to schedule an appointment." } } };
  try {
    const headers = { authorization: "Bearer test-vapi-secret", "content-type": "application/json" };
    const first = await fetch(`${baseUrl}/webhooks/vapi`, { method: "POST", headers, body: JSON.stringify(body) });
    const queued = await first.json() as { accepted: boolean; queued: boolean };
    assert.equal(first.status, 202);
    assert.equal(queued.accepted, true);
    assert.equal(queued.queued, true);
    for (let attempt = 0; attempt < 100 && store.get("demo-call-200:end-of-call-report")?.status === "processing"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(store.get("demo-call-200:end-of-call-report")?.status, "failed");
    const replay = await fetch(`${baseUrl}/admin/replay/demo-call-200%3Aend-of-call-report`, { method: "POST", headers: { authorization: "Bearer test-admin-secret" } });
    assert.equal(replay.status, 202);
    assert.equal(store.get("demo-call-200:end-of-call-report")?.status, "completed");
    assert.equal(store.get("demo-call-200:end-of-call-report")?.attempts, 2);
  } finally {
    delete process.env.MOCK_FAIL_ONCE;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
