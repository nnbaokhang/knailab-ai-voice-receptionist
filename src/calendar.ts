import { createHash } from "node:crypto";
import { fetchWithRetry } from "./retry.ts";
import type { CallSummary } from "./types.ts";

type BusyInterval = { start: string; end: string };
type CalendarConfig = {
  calendarId: string;
  timeZone: string;
  openHour: number;
  closeHour: number;
  slotMinutes: number;
  daysAhead: number;
  minNoticeMinutes: number;
};

const retryOptions = () => ({
  attempts: Number(process.env.RETRY_MAX_ATTEMPTS ?? 3),
  timeoutMs: Number(process.env.HTTP_TIMEOUT_MS ?? 8000),
});

function config(): CalendarConfig {
  const result = {
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? "primary",
    timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE ?? "America/Denver",
    openHour: Number(process.env.GOOGLE_BUSINESS_START_HOUR ?? 9),
    closeHour: Number(process.env.GOOGLE_BUSINESS_END_HOUR ?? 17),
    slotMinutes: Number(process.env.GOOGLE_SLOT_DURATION_MINUTES ?? 60),
    daysAhead: Number(process.env.GOOGLE_DAYS_AHEAD ?? 7),
    minNoticeMinutes: Number(process.env.GOOGLE_MIN_NOTICE_MINUTES ?? 120),
  };
  if (!Number.isInteger(result.openHour) || result.openHour < 0 || result.openHour > 23 ||
      !Number.isInteger(result.closeHour) || result.closeHour < 1 || result.closeHour > 24 ||
      result.openHour >= result.closeHour || !Number.isInteger(result.slotMinutes) || result.slotMinutes < 15 ||
      result.slotMinutes > 240 || !Number.isInteger(result.daysAhead) || result.daysAhead < 1 ||
      result.daysAhead > 31 || !Number.isFinite(result.minNoticeMinutes) || result.minNoticeMinutes < 0) {
    throw new Error("Invalid Google Calendar business-hours configuration");
  }
  return result;
}

function localParts(date: Date, timeZone: string): Record<string, number> {
  const entries = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(entries.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function zonedLocalToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  // Iterate to account for the requested zone's offset and daylight-saving transitions.
  for (let i = 0; i < 3; i++) {
    const parts = localParts(new Date(guess), timeZone);
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    guess += target - represented;
  }
  const value = new Date(guess);
  const check = localParts(value, timeZone);
  if (check.year !== year || check.month !== month || check.day !== day || check.hour !== hour || check.minute !== minute) {
    throw new Error("Requested local appointment time does not exist in the configured time zone");
  }
  return value;
}

function dateKey(parts: Record<string, number>): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function nextDate(parts: Record<string, number>): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function isWeekday(year: number, month: number, day: number): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

export function buildCandidateSlots(from: Date, settings = config()): Array<{ start: string; end: string }> {
  const today = localParts(from, settings.timeZone);
  let date = { year: today.year, month: today.month, day: today.day };
  const result: Array<{ start: string; end: string }> = [];
  const earliest = from.getTime() + settings.minNoticeMinutes * 60_000;
  for (let offset = 0; offset < settings.daysAhead; offset++) {
    if (isWeekday(date.year, date.month, date.day)) {
      for (let minute = settings.openHour * 60; minute + settings.slotMinutes <= settings.closeHour * 60; minute += settings.slotMinutes) {
        const start = zonedLocalToUtc(date.year, date.month, date.day, Math.floor(minute / 60), minute % 60, settings.timeZone);
        const end = new Date(start.getTime() + settings.slotMinutes * 60_000);
        if (start.getTime() >= earliest) result.push({ start: start.toISOString(), end: end.toISOString() });
      }
    }
    date = nextDate(date);
  }
  return result;
}

export class GoogleCalendar {
  private readonly fetcher: typeof fetch;
  private token?: { value: string; expiresAt: number };
  private bookingTail: Promise<void> = Promise.resolve();
  private localBookings = new Map<string, string>();

  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }

  async availability(now = new Date()): Promise<{ availableSlots: string[]; timeZone: string }> {
    const settings = config();
    const candidates = buildCandidateSlots(now, settings);
    if (!candidates.length) return { availableSlots: [], timeZone: settings.timeZone };
    const busy = await this.busyIntervals(new Date(candidates[0].start), new Date(candidates[candidates.length - 1].end), settings);
    const free = candidates.filter((slot) => !this.localBookings.has(slot.start) && !busy.some((interval) => new Date(slot.start) < new Date(interval.end) && new Date(slot.end) > new Date(interval.start)));
    return { availableSlots: free.slice(0, 8).map((slot) => slot.start), timeZone: settings.timeZone };
  }

  async book(input: { requestedStart: string; callId: string; phone: string; callerName: string; summary?: Pick<CallSummary, "serviceRequested" | "propertyAddress"> }): Promise<{ booked: true; appointmentId: string; requestedStart: string; status: "confirmed"; idempotent?: boolean }> {
    const prior = this.bookingTail;
    let release!: () => void;
    this.bookingTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await this.bookExclusive(input);
    } finally {
      release();
    }
  }

  private async bookExclusive(input: { requestedStart: string; callId: string; phone: string; callerName: string; summary?: Pick<CallSummary, "serviceRequested" | "propertyAddress"> }): Promise<{ booked: true; appointmentId: string; requestedStart: string; status: "confirmed"; idempotent?: boolean }> {
    const settings = config();
    const start = new Date(input.requestedStart);
    if (!Number.isFinite(start.getTime()) || start.toISOString() !== input.requestedStart) throw new Error("requestedStart must be a canonical UTC ISO timestamp");
    const slot = buildCandidateSlots(new Date(Date.now() - settings.minNoticeMinutes * 60_000), settings).find((candidate) => candidate.start === input.requestedStart);
    if (!slot) throw new Error("Requested slot is outside configured appointment hours or lead time");
    const appointmentId = createHash("sha256").update(`${input.callId}:${input.requestedStart}`).digest("hex").slice(0, 40);
    const existingLocalBooking = this.localBookings.get(input.requestedStart);
    if (existingLocalBooking) {
      if (existingLocalBooking === appointmentId) return { booked: true, appointmentId, requestedStart: slot.start, status: "confirmed", idempotent: true };
      throw new Error("Requested slot is no longer available");
    }
    const busy = await this.busyIntervals(start, new Date(slot.end), settings);
    if (busy.some((interval) => start < new Date(interval.end) && new Date(slot.end) > new Date(interval.start))) throw new Error("Requested slot is no longer available");

    const base = "https://www.googleapis.com/calendar/v3";
    const url = `${base}/calendars/${encodeURIComponent(settings.calendarId)}/events`;
    const event = {
      id: appointmentId,
      summary: `Roof inspection — ${input.callerName}`.slice(0, 1024),
      description: [
        `Customer: ${input.callerName}`,
        `Phone: ${input.phone}`,
        input.summary?.serviceRequested ? `Service: ${input.summary.serviceRequested}` : "",
        input.summary?.propertyAddress ? `Property: ${input.summary.propertyAddress}` : "",
        `Call ID: ${input.callId}`,
      ].filter(Boolean).join("\n").slice(0, 8192),
      start: { dateTime: slot.start, timeZone: settings.timeZone },
      end: { dateTime: slot.end, timeZone: settings.timeZone },
      extendedProperties: { private: { knailabCallId: input.callId } },
    };
    const token = await this.accessToken();
    const response = await fetchWithRetry(this.fetcher, url, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(event),
    }, retryOptions());
    if (response.status === 409) {
      this.localBookings.set(input.requestedStart, appointmentId);
      return { booked: true, appointmentId, requestedStart: slot.start, status: "confirmed", idempotent: true };
    }
    if (!response.ok) throw new Error(`Google Calendar event insert returned HTTP ${response.status}`);
    const created = await response.json() as { id?: string };
    if (created.id !== appointmentId) throw new Error("Google Calendar returned an unexpected event ID");
    this.localBookings.set(input.requestedStart, appointmentId);
    return { booked: true, appointmentId, requestedStart: slot.start, status: "confirmed" };
  }

  private async busyIntervals(start: Date, end: Date, settings: CalendarConfig): Promise<BusyInterval[]> {
    const token = await this.accessToken();
    const response = await fetchWithRetry(this.fetcher, "https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: settings.timeZone, items: [{ id: settings.calendarId }] }),
    }, retryOptions());
    const text = await response.text();
    if (!response.ok) throw new Error(`Google Calendar freeBusy returned HTTP ${response.status}`);
    const payload = JSON.parse(text) as { calendars?: Record<string, { busy?: BusyInterval[]; errors?: Array<{ reason?: string }> }> };
    const calendar = payload.calendars?.[settings.calendarId];
    if (!calendar || calendar.errors?.length) throw new Error("Google Calendar freeBusy could not read the configured calendar");
    return calendar.busy ?? [];
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (!clientId || !clientSecret || !refreshToken) throw new Error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN are required in live mode");
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
    const response = await fetchWithRetry(this.fetcher, "https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    }, retryOptions());
    const text = await response.text();
    if (!response.ok) throw new Error(`Google OAuth token refresh returned HTTP ${response.status}`);
    const result = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!result.access_token) throw new Error("Google OAuth returned no access token");
    this.token = { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in ?? 3600) * 1000 };
    return result.access_token;
  }
}

export function currentCalendarConfig(): CalendarConfig { return config(); }
