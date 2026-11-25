import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { EventStore, unseal } from "./event-store.ts";
import { log } from "./logger.ts";
import { Providers } from "./providers.ts";
import type { CallSummary, JsonObject, VapiMessage, VapiToolCall } from "./types.ts";

type ServiceOptions = { store?: EventStore; providers?: Providers };
const appointmentSlots = ["2026-11-26T16:00:00Z", "2026-11-27T18:30:00Z", "2026-11-28T17:00:00Z"];
const appointments = new Map<string, JsonObject>();

function safeEqual(received: string, expected: string | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: JsonObject): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body exceeds 1 MiB limit");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as JsonObject;
}

function messageOf(body: JsonObject): VapiMessage {
  return (body.message && typeof body.message === "object" ? body.message : body) as VapiMessage;
}

function callIdOf(message: VapiMessage): string {
  const call = message.call as JsonObject | undefined;
  return String(call?.id ?? message.callId ?? "unknown-call");
}

function eventIdOf(message: VapiMessage): string {
  const type = String(message.type ?? "unknown");
  const callId = callIdOf(message);
  if (type === "tool-calls") {
    const calls = (message.toolCallList ?? []) as VapiToolCall[];
    return `${callId}:tool:${calls.map((c) => c.id ?? c.toolCallId ?? "missing-id").join(",")}`;
  }
  const id = (message.call as JsonObject | undefined)?.id;
  return `${String(id ?? callId)}:${type}`;
}

function parseArgs(call: VapiToolCall): JsonObject {
  const value = call.function?.arguments ?? call.arguments ?? {};
  if (typeof value === "string") return JSON.parse(value) as JsonObject;
  return value as JsonObject;
}

function callToolResult(call: VapiToolCall, result: unknown): JsonObject {
  return { toolCallId: call.id ?? call.toolCallId ?? "unknown-tool-call", result };
}

function fallbackSummary(message: VapiMessage): CallSummary {
  const call = message.call as JsonObject | undefined;
  const customer = call?.customer as JsonObject | undefined;
  const artifact = message.artifact as JsonObject | undefined;
  const artifactMessages = artifact?.messages as Array<JsonObject> | undefined;
  const text = String(artifact?.transcript ?? artifactMessages?.map((item) => item.message ?? item.content ?? "").join(" ") ?? "");
  const phone = customer?.number ?? call?.customerNumber ?? call?.from;
  return {
    callerName: null,
    phone: typeof phone === "string" ? phone : null,
    email: null,
    serviceRequested: /leak/i.test(text) ? "Roof leak inspection" : (/roof|shingle|gutter/i.test(text) ? "Roofing service" : null),
    propertyAddress: null,
    urgency: /active leak|water coming in|storm damage|emergency/i.test(text) ? "urgent" : "unknown",
    appointmentRequested: /appointment|inspection|schedule|book/i.test(text),
    appointmentAt: null,
    qualified: Boolean(phone || /roof|gutter|shingle|leak/i.test(text)),
    summary: text.slice(0, 600) || "Call completed. Review the Vapi report for details.",
    nextAction: "Review the call summary and contact the caller if follow-up is needed.",
  };
}

function transcriptOf(message: VapiMessage): string {
  const artifact = message.artifact as JsonObject | undefined;
  if (typeof artifact?.transcript === "string") return artifact.transcript;
  const messages = artifact?.messages as Array<JsonObject> | undefined;
  return messages?.map((entry) => String(entry.message ?? entry.content ?? "")).join("\n") ?? "";
}

async function runTool(message: VapiMessage, call: VapiToolCall): Promise<JsonObject> {
  const name = String(call.function?.name ?? call.name ?? "");
  const args = parseArgs(call);
  if (name === "check_appointment_availability") {
    return callToolResult(call, { availableSlots: appointmentSlots, timezone: "America/Denver" });
  }
  if (name === "book_appointment") {
    const requested = String(args.requestedStart ?? "");
    const contactPhone = String(args.phone ?? "");
    if (!appointmentSlots.includes(requested)) return callToolResult(call, { booked: false, reason: "That slot is not available. Offer one of the listed times." });
    if (!/^\+[1-9]\d{7,14}$/.test(contactPhone)) return callToolResult(call, { booked: false, reason: "A valid phone number is required to reserve an appointment." });
    const appointmentId = randomUUID();
    appointments.set(appointmentId, { appointmentId, requestedStart: requested, phone: contactPhone, status: "pending_human_confirmation" });
    return callToolResult(call, { booked: true, appointmentId, requestedStart: requested, status: "pending_human_confirmation" });
  }
  if (name === "prepare_human_transfer") {
    return callToolResult(call, { transferRequested: true, instruction: "Use the configured Vapi Transfer Call tool now. If no destination is configured, take a message and promise a callback." });
  }
  return callToolResult(call, { error: `Unsupported function: ${name}` });
}

export function createReceptionistServer(options: ServiceOptions = {}): { server: Server; store: EventStore; providers: Providers } {
  const store = options.store ?? new EventStore(process.env.EVENT_STORE_PATH ?? "./data/events.json");
  const providers = options.providers ?? new Providers();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const correlationId = String(req.headers["x-correlation-id"] ?? randomUUID()).slice(0, 100);
    res.setHeader("x-correlation-id", correlationId);
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, service: "knailab-ai-voice-receptionist" });
      if (req.method === "GET" && url.pathname === "/readyz") {
        const mock = process.env.MOCK_INTEGRATIONS !== "false";
        const required = ["VAPI_WEBHOOK_SECRET", "ADMIN_API_KEY"];
        if (!mock) required.push("GHL_ACCESS_TOKEN", "GHL_LOCATION_ID", "MAKE_POST_CALL_WEBHOOK_URL", "EVENT_STORE_ENCRYPTION_KEY");
        const missing = required.filter((key) => !process.env[key]);
        return send(res, missing.length ? 503 : 200, { ok: missing.length === 0, mode: mock ? "mock" : "live", missing });
      }
      if (req.method === "GET" && url.pathname === "/demo/state" && process.env.NODE_ENV !== "production") {
        return send(res, 200, { mode: process.env.MOCK_INTEGRATIONS === "false" ? "live" : "mock", events: store.list().map(({ eventId, type, status, attempts }) => ({ eventId, type, status, attempts })), appointments: [...appointments.values()].map(({ phone: _phone, ...appointment }) => appointment) });
      }
      if (req.method === "POST" && url.pathname.startsWith("/admin/replay/")) {
        if (!safeEqual(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), process.env.ADMIN_API_KEY)) return send(res, 401, { error: "unauthorized" });
        const eventId = decodeURIComponent(url.pathname.slice("/admin/replay/".length));
        const record = store.get(eventId);
        if (!record) return send(res, 404, { error: "event_not_found" });
        if (record.status !== "failed") return send(res, 409, { error: "event_not_failed", status: record.status });
        const payload = unseal(record.encryptedPayload);
        await store.update(eventId, { status: "processing", lastError: undefined });
        await processVapiMessage(messageOf(payload), eventId, correlationId, store, providers);
        return send(res, 202, { replayed: true, eventId });
      }
      if (req.method !== "POST" || url.pathname !== "/webhooks/vapi") return send(res, 404, { error: "not_found" });
      const expected = process.env.VAPI_WEBHOOK_SECRET;
      if (!safeEqual(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), expected)) return send(res, 401, { error: "unauthorized" });
      let body: JsonObject;
      try { body = await readJson(req); }
      catch { return send(res, 400, { error: "invalid_json_or_body_too_large" }); }
      const message = messageOf(body);
      const type = String(message.type ?? "");
      if (!new Set(["tool-calls", "end-of-call-report"]).has(type)) return send(res, 200, { ignored: true, type: type || "unknown" });
      const eventId = eventIdOf(message);
      const begun = await store.begin(eventId, type, body, correlationId);
      if (begun.duplicate && begun.record.status !== "failed") return send(res, 200, { accepted: true, duplicate: true, status: begun.record.status });
      if (begun.duplicate && begun.record.status === "failed") return send(res, 200, { accepted: true, duplicate: true, status: "failed", replay: `/admin/replay/${encodeURIComponent(eventId)}` });
      const result = await processVapiMessage(message, eventId, correlationId, store, providers);
      return send(res, 200, result);
    } catch (error) {
      log("error", "http_request_failed", { correlationId, path: url.pathname, error: error instanceof Error ? error.message : "unknown" });
      return send(res, 500, { error: "internal_error", correlationId });
    }
  });
  return { server, store, providers };
}

async function processVapiMessage(message: VapiMessage, eventId: string, correlationId: string, store: EventStore, providers: Providers): Promise<JsonObject> {
  const type = String(message.type ?? "");
  await store.incrementAttempts(eventId);
  try {
    if (type === "tool-calls") {
      const calls = (message.toolCallList ?? []) as VapiToolCall[];
      const results: JsonObject[] = [];
      for (const call of calls) results.push(await runTool(message, call));
      await store.update(eventId, { status: "completed", lastError: undefined });
      log("info", "vapi_tool_calls_handled", { correlationId, eventId, count: calls.length });
      return { results };
    }
    if (type === "end-of-call-report") {
      const callId = callIdOf(message);
      const fallback = fallbackSummary(message);
      const summary = await providers.summarize(transcriptOf(message), fallback);
      const crm = await providers.syncHighLevel(summary, callId);
      const automation = await providers.makePostCall({ eventId, callId, summary, crmContactId: crm.contactId, source: "vapi-end-of-call-report" });
      await store.update(eventId, { status: "completed", lastError: undefined });
      log("info", "post_call_workflow_completed", { correlationId, eventId, crmMode: crm.mode, makeMode: automation.mode, qualified: summary.qualified });
      return { accepted: true, eventId, summary, integrations: { highLevel: crm.mode, make: automation.mode } };
    }
    await store.update(eventId, { status: "completed" });
    return { accepted: true, ignored: true };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "unknown provider error";
    await store.update(eventId, { status: "failed", lastError: messageText.slice(0, 250) });
    log("error", "vapi_event_failed", { correlationId, eventId, type, error: messageText });
    if (type === "tool-calls") {
      const calls = (message.toolCallList ?? []) as VapiToolCall[];
      return { results: calls.map((call) => callToolResult(call, { error: "The requested action failed. Please offer a callback." })) };
    }
    return { accepted: false, eventId, error: "post_call_processing_failed", replay: `/admin/replay/${encodeURIComponent(eventId)}` };
  }
}
