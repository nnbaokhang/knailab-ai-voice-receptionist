# Integration notes

## Vapi and OpenAI

The assistant configuration sets `model.provider` to `openai` and uses `gpt-4o-mini`. Vapi sends `tool-calls` and `end-of-call-report` server messages to `/webhooks/vapi`. Function-call tools return the Vapi `results` envelope, with each `result` serialized as a string; call reports are summarized with OpenAI Structured Outputs when `OPENAI_API_KEY` is configured.

Use a Vapi Server URL credential to send `Authorization: Bearer <VAPI_WEBHOOK_SECRET>`. The service checks the token with a constant-time comparison. Do not put the Vapi private API key in this webhook service.

## Twilio

Import a Twilio number into Vapi using Vapi's supported phone-number import flow. In this architecture, Twilio routes the inbound call to Vapi; Twilio does not post the call directly to this Node service. Vapi delivers the configured server messages to this app. If the architecture is changed so Twilio posts directly to an app endpoint, use Twilio's official SDK request validator and the exact externally visible webhook URL; this project does not implement a second, unused Twilio webhook path.

## GoHighLevel / HighLevel

The live adapter calls `POST /contacts/upsert` with `Version: v3` and a location ID. When both pipeline IDs are configured, it calls `POST /opportunities/upsert` to associate the call lead with a pipeline. Use an OAuth or Private Integration token with the minimum contact and opportunity scopes required for the chosen endpoints. Configure contact duplicate matching in the location. Provider response bodies and credentials are not written to logs.

If the HighLevel request fails, the encrypted event is marked failed. Use the authenticated replay route after correcting the integration. The upsert endpoints are used to reduce duplicate contact and opportunity creation on retries; confirm your location's duplicate policies in a sandbox first.

## Google Calendar

The Vapi availability and booking functions use the Google Calendar API directly. This is separate from the verified Google Calendar connection in Make: Make's OAuth token is not available to this Node service. Configure an OAuth client and refresh token for the service, keep them in the deployment secret manager, and use the Calendar scopes required for free/busy reads and event creation. `freeBusy.query` filters candidate slots; booking checks availability again and inserts an event with a deterministic event ID derived from the Vapi call ID and requested start time. A repeated insert for the same call and slot returns an idempotent success.

Business hours, time zone, slot duration, minimum notice, and days ahead are configurable. Defaults are Monday–Friday, 9:00 a.m.–5:00 p.m. America/Denver, 60-minute slots, 2-hour notice, and a 7-day window. Vapi may claim an appointment is confirmed only when the live calendar tool returns `booked=true`, `status=confirmed`, and `mode=live`. Mock bookings are labeled `simulated`.

Google Calendar does not provide a transactional slot lock for this flow. If multiple booking workers or other schedulers can book the same slot concurrently, use a shared transactional lock/idempotency store and reconcile calendar writes before treating it as production-grade scheduling.

## Twilio connection in Make

The Twilio credential is stored as a Make-managed connection and is not embedded in this source tree or a shareable blueprint. The current scenario does not send SMS or outbound calls; do not add outbound actions until a verified consent policy, message template, and intended destination are configured.

## Make.com

Set `MAKE_POST_CALL_WEBHOOK_URL` to a Make Custom Webhook URL. Make receives an event after CRM sync succeeds, with an `eventId` idempotency key and a structured summary. The checked-in `make/scenario-spec.json` is a mapping spec, not an importable Make blueprint. Create the custom webhook and account connections in Make, then export the official blueprint from Make after configuration. The app cannot verify a Make scenario without the user's Make workspace and credentials.

## Mock versus live

| Integration | Mock mode | Live mode | Verified live here? |
|---|---|---|---|
| Vapi webhook | Sample HTTP requests | Public Server URL and Vapi credential required | No |
| Twilio number | Not connected | Import an owned number into Vapi | No |
| OpenAI | Deterministic fallback summary | OpenAI API Structured Outputs | No |
| HighLevel | Synthetic contact ID | Contact upsert; opportunity upsert when pipeline IDs exist | No |
| Google Calendar in Node | Future business-hour slots; mock booking only | OAuth refresh-token access, FreeBusy query, event insert | No |
| Google Calendar in Make | Synthetic only | Make-managed Calendar connection | Credential connection verified; no workflow execution |
| Twilio in Make | Synthetic only | Make-managed credential connection; no outbound actions configured | Credential connection verified; no workflow execution |
| Make.com | In-process delivery simulation | Make Custom Webhook URL | No |

Live mode is an integration path in the source code, not proof that provider credentials or tenant settings have been tested. Live mode fails closed when required HighLevel or Make credentials are missing; it never silently substitutes the mock adapter. A successful real call, CRM record check, Make run, and replay test are still required before describing the system as production ready.

## Provider documentation checked for this implementation

- [Vapi server events and response formats](https://docs.vapi.ai/server-url/events)
- [Vapi Function tools](https://docs.vapi.ai/tools/custom-tools)
- [Vapi Twilio number import](https://docs.vapi.ai/phone-numbers/import-twilio)
- [Twilio webhook signature security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [Google Calendar FreeBusy query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Google Calendar event insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [HighLevel contact upsert](https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact/)
- [HighLevel opportunity upsert](https://marketplace.gohighlevel.com/docs/ghl/opportunities/upsert-opportunity/)
- [Make scenario API and blueprint handling](https://developers.make.com/api-documentation/api-reference/scenarios)
- [Make scenario blueprint import and export](https://help.make.com/blueprints)
