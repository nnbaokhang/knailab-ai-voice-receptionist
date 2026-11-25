import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore, unseal } from "../src/event-store.ts";

test("persists event state while encrypting payload at rest", async () => {
  process.env.EVENT_STORE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const dir = await mkdtemp(join(tmpdir(), "voice-agent-store-"));
  const path = join(dir, "events.json");
  try {
    const store = new EventStore(path);
    await store.load();
    const payload = { message: { type: "end-of-call-report", caller: "Synthetic Name" } };
    await store.begin("call-1:end-of-call-report", "end-of-call-report", payload, "corr-1");
    await store.update("call-1:end-of-call-report", { status: "failed", lastError: "mock failure" });
    const persisted = await readFile(path, "utf8");
    assert.equal(persisted.includes("Synthetic Name"), false);
    const loaded = new EventStore(path);
    await loaded.load();
    const record = loaded.get("call-1:end-of-call-report");
    assert.equal(record?.status, "failed");
    assert.deepEqual(unseal(record!.encryptedPayload), payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
