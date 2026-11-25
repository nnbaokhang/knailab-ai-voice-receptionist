import test from "node:test";
import assert from "node:assert/strict";
import { Providers } from "../src/providers.ts";

test("live mode refuses missing Make and HighLevel settings instead of returning mock success", async () => {
  process.env.MOCK_INTEGRATIONS = "false";
  const old = {
    make: process.env.MAKE_POST_CALL_WEBHOOK_URL,
    token: process.env.GHL_ACCESS_TOKEN,
    location: process.env.GHL_LOCATION_ID,
  };
  delete process.env.MAKE_POST_CALL_WEBHOOK_URL;
  delete process.env.GHL_ACCESS_TOKEN;
  delete process.env.GHL_LOCATION_ID;
  try {
    const providers = new Providers();
    await assert.rejects(providers.makePostCall({ eventId: "e-1" }), /MAKE_POST_CALL_WEBHOOK_URL/);
    await assert.rejects(providers.syncHighLevel({} as never, "call-1"), /GHL_ACCESS_TOKEN and GHL_LOCATION_ID/);
  } finally {
    process.env.MOCK_INTEGRATIONS = "true";
    if (old.make) process.env.MAKE_POST_CALL_WEBHOOK_URL = old.make; else delete process.env.MAKE_POST_CALL_WEBHOOK_URL;
    if (old.token) process.env.GHL_ACCESS_TOKEN = old.token; else delete process.env.GHL_ACCESS_TOKEN;
    if (old.location) process.env.GHL_LOCATION_ID = old.location; else delete process.env.GHL_LOCATION_ID;
  }
});
