# Integration notes

## Vapi and OpenAI

The assistant configuration sets `model.provider` to `openai` and uses `gpt-4o-mini`. Vapi sends `tool-calls` and `end-of-call-report` server messages to `/webhooks/vapi`. Function-call tools return the Vapi `results` envelope; call reports are summarized with OpenAI Structured Outputs when `OPENAI_API_KEY` is configured.

Use a Vapi Server URL credential to send `Authorization: Bearer <VAPI_WEBHOOK_SECRET>`. The service checks the token with a constant-time comparison. Do not put the Vapi private API key in this webhook service.

## Twilio

Import a Twilio number into Vapi using Vapi's supported phone-number import flow. In this architecture, Twilio routes the inbound call to Vapi; Twilio does not post the call directly to this Node service. Vapi delivers the configured server messages to this app. If the architecture is changed so Twilio posts directly to an app endpoint, use Twilio's official SDK request validator and the exact externally visible webhook URL; this project does not implement a second, unused Twilio webhook path.

## GoHighLevel / HighLevel

The live adapter calls `POST /contacts/upsert` with `Version: v3` and a location ID. When both pipeline IDs are configured, it calls `POST /opportunities/upsert` to associate the call lead with a pipeline. Use an OAuth or Private Integration token with the minimum contact and opportunity scopes required for the chosen endpoints. Configure contact duplicate matching in the location. Provider response bodies and credentials are not written to logs.

If the HighLevel request fails, the encrypted event is marked failed. Use the authenticated replay route after correcting the integration. The upsert endpoints are used to reduce duplicate contact and opportunity creation on retries; confirm your location's duplicate policies in a sandbox first.

## Make.com

Set `MAKE_POST_CALL_WEBHOOK_URL` to a Make Custom Webhook URL. Make receives an event after CRM sync succeeds, with an `eventId` idempotency key and a structured summary. The checked-in `make/scenario-spec.json` is a mapping spec, not an importable Make blueprint. Create the custom webhook and account connections in Make, then export the official blueprint from Make after configuration. The app cannot verify a Make scenario without the user's Make workspace and credentials.

## Mock versus live

| Integration | Mock mode | Live mode | Verified live here? |
|---|---|---|---|
| Vapi webhook | Sample HTTP requests | Public Server URL and Vapi credential required | No |
| Twilio number | Not connected | Import an owned number into Vapi | No |
| OpenAI | Deterministic fallback summary | OpenAI API Structured Outputs | No |
| HighLevel | Synthetic contact ID | Contact upsert; opportunity upsert when pipeline IDs exist | No |
| Make.com | In-process delivery simulation | Make Custom Webhook URL | No |

Live mode is an integration path in the source code, not proof that provider credentials or tenant settings have been tested. Live mode fails closed when required HighLevel or Make credentials are missing; it never silently substitutes the mock adapter. A successful real call, CRM record check, Make run, and replay test are still required before describing the system as production ready.

## Provider documentation checked for this implementation

- [Vapi server events and response formats](https://docs.vapi.ai/server-url/events)
- [Vapi Function tools](https://docs.vapi.ai/tools/custom-tools)
- [Vapi Twilio number import](https://docs.vapi.ai/phone-numbers/import-twilio)
- [Twilio webhook signature security](https://www.twilio.com/docs/usage/webhooks/webhooks-security)
- [OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- [HighLevel contact upsert](https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact/)
- [HighLevel opportunity upsert](https://marketplace.gohighlevel.com/docs/ghl/opportunities/upsert-opportunity/)
- [Make scenario API and blueprint handling](https://developers.make.com/api-documentation/api-reference/scenarios)
