import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventRecord, JsonObject } from "./types.ts";

function encryptionKey(): Buffer {
  const configured = process.env.EVENT_STORE_ENCRYPTION_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("EVENT_STORE_ENCRYPTION_KEY must decode to exactly 32 bytes");
    return key;
  }
  if (process.env.MOCK_INTEGRATIONS === "false") throw new Error("EVENT_STORE_ENCRYPTION_KEY is required in live mode");
  return localEphemeralKey;
}

const localEphemeralKey = randomBytes(32);

function seal(payload: JsonObject): EventRecord["encryptedPayload"] {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function unseal(value: EventRecord["encryptedPayload"]): JsonObject {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const data = Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]);
  return JSON.parse(data.toString("utf8")) as JsonObject;
}

export class EventStore {
  private records = new Map<string, EventRecord>();
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) { this.path = path; }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const records = JSON.parse(raw) as EventRecord[];
      for (const record of records) this.records.set(record.eventId, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(eventId: string): EventRecord | undefined { return this.records.get(eventId); }
  list(): EventRecord[] { return [...this.records.values()]; }

  async begin(eventId: string, type: string, payload: JsonObject, correlationId: string): Promise<{ duplicate: boolean; record: EventRecord }> {
    const prior = this.records.get(eventId);
    if (prior) return { duplicate: true, record: prior };
    const now = new Date().toISOString();
    const record: EventRecord = {
      eventId, type, status: "processing", attempts: 0, receivedAt: now, updatedAt: now,
      correlationId, encryptedPayload: seal(payload),
    };
    this.records.set(eventId, record);
    await this.persist();
    return { duplicate: false, record };
  }

  async update(eventId: string, patch: Partial<Pick<EventRecord, "status" | "attempts" | "lastError">>): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, { ...record, ...patch, updatedAt: new Date().toISOString() });
    await this.persist();
  }

  async incrementAttempts(eventId: string): Promise<number> {
    const record = this.records.get(eventId);
    const attempts = (record?.attempts ?? 0) + 1;
    await this.update(eventId, { attempts });
    return attempts;
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(this.list(), null, 2), { mode: 0o600 });
      await rename(temp, this.path);
    });
    return this.writeQueue;
  }
}
