import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceptionistServer } from "../src/service.ts";
import { EventStore } from "../src/event-store.ts";
import { Providers } from "../src/providers.ts";

test("webhook authenticates, handles availability and idempotent booking, and deduplicates retries", async () => {
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
    const firstJson = await first.json() as { results: Array<{ result: string }> };
    assert.equal(first.status, 200);
    const availability = JSON.parse(firstJson.results[0].result) as { availableSlots: string[]; mode: string };
    assert.equal(availability.mode, "mock");
    assert.ok(availability.availableSlots.length > 0);
    assert.ok(availability.availableSlots.every((slot) => Number.isFinite(Date.parse(slot))));
    const requestedStart = availability.availableSlots[0];
    const bookingBody = (toolId: string) => ({ message: { type: "tool-calls", call: { id: "demo-call-100" }, toolCallList: [{ id: toolId, function: { name: "book_appointment", arguments: JSON.stringify({ requestedStart, phone: "+13035550101", callerName: "Alex Example", serviceRequested: "roof inspection", propertyAddress: "100 Example St" }) } }] } });
    const book1 = await fetch(`${baseUrl}/webhooks/vapi`, { method: "POST", headers, body: JSON.stringify(bookingBody("tool-book-1")) });
    const book1Body = await book1.json() as { results: Array<{ result: string }> };
    const booked = JSON.parse(book1Body.results[0].result) as { booked: boolean; status: string; mode: string; appointmentId: string };
    assert.equal(book1.status, 200);
    assert.deepEqual({ booked: booked.booked, status: booked.status, mode: booked.mode }, { booked: true, status: "simulated", mode: "mock" });
    const book2 = await fetch(`${baseUrl}/webhooks/vapi`, { method: "POST", headers, body: JSON.stringify(bookingBody("tool-book-2")) });
    const book2Body = await book2.json() as { results: Array<{ result: string }> };
    const duplicateBooking = JSON.parse(book2Body.results[0].result) as { appointmentId: string; idempotent: boolean };
    assert.equal(duplicateBooking.appointmentId, booked.appointmentId);
    assert.equal(duplicateBooking.idempotent, true);
    const updatedAvailabilityBody = { message: { type: "tool-calls", call: { id: "demo-call-100" }, toolCallList: [{ id: "tool-2", function: { name: "check_appointment_availability", arguments: "{}" } }] } };
    const updatedAvailabilityResponse = await fetch(`${baseUrl}/webhooks/vapi`, { method: "POST", headers, body: JSON.stringify(updatedAvailabilityBody) });
    const updatedAvailabilityResult = await updatedAvailabilityResponse.json() as { results: Array<{ result: string }> };
    const updatedAvailability = JSON.parse(updatedAvailabilityResult.results[0].result) as { availableSlots: string[] };
    assert.ok(!updatedAvailability.availableSlots.includes(requestedStart));
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
