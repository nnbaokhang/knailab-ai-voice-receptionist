import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateSlots, GoogleCalendar } from "../src/calendar.ts";

test("calendar candidates follow configured Denver business hours across daylight saving time", () => {
  process.env.GOOGLE_CALENDAR_TIMEZONE = "America/Denver";
  process.env.GOOGLE_BUSINESS_START_HOUR = "9";
  process.env.GOOGLE_BUSINESS_END_HOUR = "11";
  process.env.GOOGLE_SLOT_DURATION_MINUTES = "60";
  process.env.GOOGLE_DAYS_AHEAD = "7";
  process.env.GOOGLE_MIN_NOTICE_MINUTES = "0";
  const winter = buildCandidateSlots(new Date("2026-11-23T15:00:00.000Z"));
  assert.equal(winter[0]?.start, "2026-11-23T16:00:00.000Z");
  const summer = buildCandidateSlots(new Date("2026-03-09T14:00:00.000Z"));
  assert.equal(summer[0]?.start, "2026-03-09T15:00:00.000Z");
  assert.equal(winter.length, 10);
});

test("live availability filters busy slots and live booking creates a deterministic event", async () => {
  const original = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE,
    startHour: process.env.GOOGLE_BUSINESS_START_HOUR,
    endHour: process.env.GOOGLE_BUSINESS_END_HOUR,
    slotMinutes: process.env.GOOGLE_SLOT_DURATION_MINUTES,
    daysAhead: process.env.GOOGLE_DAYS_AHEAD,
    notice: process.env.GOOGLE_MIN_NOTICE_MINUTES,
    mock: process.env.MOCK_INTEGRATIONS,
  };
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REFRESH_TOKEN: "refresh-token",
    GOOGLE_CALENDAR_ID: "primary",
    GOOGLE_CALENDAR_TIMEZONE: "America/Denver",
    GOOGLE_BUSINESS_START_HOUR: "9",
    GOOGLE_BUSINESS_END_HOUR: "17",
    GOOGLE_SLOT_DURATION_MINUTES: "60",
    GOOGLE_DAYS_AHEAD: "7",
    GOOGLE_MIN_NOTICE_MINUTES: "0",
    MOCK_INTEGRATIONS: "false",
  });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let freeBusyCount = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), { status: 200 });
    if (url.endsWith("/freeBusy")) {
      freeBusyCount++;
      const request = JSON.parse(String(init?.body)) as { timeMin: string };
      if (freeBusyCount > 1) return new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }), { status: 200 });
      const firstStart = buildCandidateSlots(new Date(Date.parse(request.timeMin) - 60_000))[0]?.start ?? request.timeMin;
      return new Response(JSON.stringify({ calendars: { primary: { busy: [{ start: firstStart, end: new Date(Date.parse(firstStart) + 60 * 60_000).toISOString() }] } } }), { status: 200 });
    }
    if (url.includes("/events")) {
      const event = JSON.parse(String(init?.body)) as { id: string };
      return new Response(JSON.stringify({ id: event.id }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const calendar = new GoogleCalendar(fetcher);
    const availability = await calendar.availability(new Date("2026-11-23T15:00:00.000Z"));
    assert.equal(availability.timeZone, "America/Denver");
    assert.ok(availability.availableSlots.length > 0);
    assert.ok(!availability.availableSlots.includes("2026-11-23T16:00:00.000Z"));

    const requestedStart = buildCandidateSlots(new Date(Date.now() - 1_000)).find((slot) => Date.parse(slot.start) > Date.now())?.start;
    assert.ok(requestedStart);
    const booking = await calendar.book({ requestedStart, callId: "call-test-1", phone: "+13035550101", callerName: "Alex Example", summary: { serviceRequested: "roof inspection", propertyAddress: "100 Example St" } });
    assert.equal(booking.booked, true);
    assert.equal(booking.status, "confirmed");
    assert.match(booking.appointmentId, /^[a-f0-9]{40}$/);
    assert.equal(calls.filter((call) => call.url.includes("/events")).length, 1);
    const sameRequest = await calendar.book({ requestedStart, callId: "call-test-1", phone: "+13035550101", callerName: "Alex Example" });
    assert.equal(sameRequest.idempotent, true);
    await assert.rejects(calendar.book({ requestedStart, callId: "call-test-2", phone: "+13035550102", callerName: "Jamie Example" }), /no longer available/);
    assert.equal(calls.filter((call) => call.url.includes("/events")).length, 1);
  } finally {
    const restore = (key: string, value: string | undefined) => value === undefined ? delete process.env[key] : process.env[key] = value;
    restore("GOOGLE_CLIENT_ID", original.clientId);
    restore("GOOGLE_CLIENT_SECRET", original.clientSecret);
    restore("GOOGLE_REFRESH_TOKEN", original.refreshToken);
    restore("GOOGLE_CALENDAR_ID", original.calendarId);
    restore("GOOGLE_CALENDAR_TIMEZONE", original.timeZone);
    restore("GOOGLE_BUSINESS_START_HOUR", original.startHour);
    restore("GOOGLE_BUSINESS_END_HOUR", original.endHour);
    restore("GOOGLE_SLOT_DURATION_MINUTES", original.slotMinutes);
    restore("GOOGLE_DAYS_AHEAD", original.daysAhead);
    restore("GOOGLE_MIN_NOTICE_MINUTES", original.notice);
    restore("MOCK_INTEGRATIONS", original.mock);
  }
});
