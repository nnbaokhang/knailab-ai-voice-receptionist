import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "../src/retry.ts";

test("retries 429 responses then returns success", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls++;
    return new Response("{}", { status: calls === 1 ? 429 : 200, headers: calls === 1 ? { "retry-after": "0" } : {} });
  };
  const response = await fetchWithRetry(fakeFetch, "https://example.invalid", {}, { attempts: 3, timeoutMs: 100, baseDelayMs: 1 });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test("does not retry non-transient 4xx responses", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return new Response("no", { status: 400 }); };
  const response = await fetchWithRetry(fakeFetch, "https://example.invalid", {}, { attempts: 3, timeoutMs: 100, baseDelayMs: 1 });
  assert.equal(response.status, 400);
  assert.equal(calls, 1);
});
