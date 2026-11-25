import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceptionistServer } from "../src/service.ts";
import { EventStore } from "../src/event-store.ts";

process.env.NODE_ENV = "test";
process.env.MOCK_INTEGRATIONS = "true";
process.env.VAPI_WEBHOOK_SECRET = "local-demo-vapi-secret";
process.env.ADMIN_API_KEY = "local-demo-admin-secret";
process.env.EVENT_STORE_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.GOOGLE_CALENDAR_TIMEZONE ??= "America/Denver";
process.env.MOCK_FAIL_ONCE = "make";

const tempDir = await mkdtemp(join(tmpdir(), "knailab-voice-demo-"));
process.env.EVENT_STORE_PATH = join(tempDir, "events.json");
const store = new EventStore(process.env.EVENT_STORE_PATH);
const { server, recoverPending } = createReceptionistServer({ store });
await store.load();
await recoverPending();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Demo server did not bind to a TCP port");
const baseUrl = `http://127.0.0.1:${address.port}`;
const authHeaders = { authorization: "Bearer local-demo-vapi-secret", "content-type": "application/json" };

async function post(path: string, body: unknown, authorization = authHeaders.authorization): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { ...authHeaders, authorization }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

try {
  const callId = "codex-demo-call-001";
  const availability = await post("/webhooks/vapi", {
    message: {
      type: "tool-calls", call: { id: callId },
      toolCallList: [{ id: "demo-availability-1", function: { name: "check_appointment_availability", arguments: "{}" } }],
    },
  });
  const availabilityResults = availability.body.results as Array<{ result: string }> | undefined;
  const availabilityResult = JSON.parse(availabilityResults?.[0]?.result ?? "{}") as { availableSlots?: string[]; mode?: string };
  if (availability.status !== 200 || !availabilityResult.availableSlots?.length) throw new Error("Mock availability did not return any future slots");
  const requestedStart = availabilityResult.availableSlots[0];

  const bookingBody = {
    message: {
      type: "tool-calls", call: { id: callId },
      toolCallList: [{
        id: "demo-booking-1",
        function: {
          name: "book_appointment",
          arguments: JSON.stringify({ requestedStart, phone: "+13035550101", callerName: "Alex Example", serviceRequested: "roof inspection", propertyAddress: "100 Example Avenue, Denver, CO" }),
        },
      }],
    },
  };
  const booking = await post("/webhooks/vapi", bookingBody);
  const bookingResults = booking.body.results as Array<{ result: string }> | undefined;
  const bookingResult = JSON.parse(bookingResults?.[0]?.result ?? "{}") as { booked?: boolean; status?: string; mode?: string; appointmentId?: string };
  if (booking.status !== 200 || !bookingResult.booked || bookingResult.status !== "simulated" || bookingResult.mode !== "mock") {
    throw new Error("Mock booking was not clearly labeled as simulated");
  }

  const duplicateBookingBody = structuredClone(bookingBody) as typeof bookingBody;
  duplicateBookingBody.message.toolCallList[0]!.id = "demo-booking-2";
  const duplicateBooking = await post("/webhooks/vapi", duplicateBookingBody);
  const duplicateResults = duplicateBooking.body.results as Array<{ result: string }> | undefined;
  const duplicateResult = JSON.parse(duplicateResults?.[0]?.result ?? "{}") as { appointmentId?: string; idempotent?: boolean };
  if (duplicateResult.appointmentId !== bookingResult.appointmentId || duplicateResult.idempotent !== true) {
    throw new Error("Duplicate booking did not reuse the original simulated appointment");
  }

  const report = await post("/webhooks/vapi", {
    message: {
      type: "end-of-call-report",
      call: { id: "codex-demo-call-002", customer: { number: "+13035550101" } },
      artifact: { transcript: "Caller Alex Example requests a routine roof inspection at 100 Example Avenue in Denver and asks for an appointment next week." },
    },
  });
  if (report.status !== 202) throw new Error("Call report was not queued");
  const eventId = "codex-demo-call-002:end-of-call-report";
  for (let attempt = 0; attempt < 200 && store.get(eventId)?.status === "processing"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const firstStatus = store.get(eventId)?.status;
  if (firstStatus !== "failed") throw new Error(`Expected simulated Make failure, got ${firstStatus ?? "no event"}`);

  const replay = await post(`/admin/replay/${encodeURIComponent(eventId)}`, {}, "Bearer local-demo-admin-secret");
  if (replay.status !== 202 || store.get(eventId)?.status !== "completed") throw new Error("Failed call report did not recover on replay");

  process.stdout.write(`${JSON.stringify({
    mode: "mock",
    availableSlotsReturned: availabilityResult.availableSlots.length,
    booking: { status: bookingResult.status, mode: bookingResult.mode },
    duplicateBookingReusedId: duplicateResult.idempotent,
    simulatedMakeFailure: firstStatus,
    replayedCallReport: store.get(eventId)?.status,
    integrations: "No live provider calls were made.",
  }, null, 2)}\n`);
} finally {
  delete process.env.MOCK_FAIL_ONCE;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tempDir, { recursive: true, force: true });
}
