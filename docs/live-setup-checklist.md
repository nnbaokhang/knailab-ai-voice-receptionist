# Live demo setup checklist

Use a dedicated demo tenant and synthetic contacts. Do not use a real customer's caller data until the business has approved data retention, call recording, and downstream access.

## 1. Public service deployment

- Deploy the Node service behind HTTPS at a stable public URL. Vapi will not send webhooks to localhost or private network addresses.
- Set `MOCK_INTEGRATIONS=false` only after every required live setting is present.
- Set a unique `VAPI_WEBHOOK_SECRET`, a separate `ADMIN_API_KEY`, and a generated `EVENT_STORE_ENCRYPTION_KEY` (`openssl rand -base64 32`). Keep all three in the host's secret manager.
- Use durable encrypted storage and a persistent volume. The checked-in JSON event store is single-process only; for multiple instances use a transactional shared database/queue before production traffic.
- Confirm `GET /healthz` and `GET /readyz` after deployment. Readiness should not show missing configuration.

## 2. Vapi and OpenAI

- In Vapi, configure an OpenAI provider/model for the assistant in `config/vapi-assistant.json`.
- Create the function tools in `config/vapi-tools.json`. Set each server URL to `https://<your-host>/webhooks/vapi`, attach the assistant, and create a Vapi custom credential that sends `Authorization: Bearer <VAPI_WEBHOOK_SECRET>`.
- Enable only the Vapi server messages needed here: `tool-calls` and `end-of-call-report`.
- Configure the Vapi Transfer Call tool separately with a tested, reachable human destination. The repo deliberately has no real transfer number.
- If OpenAI call-summary generation should run from this service, set `OPENAI_API_KEY` and `OPENAI_MODEL` in the deployment secret manager. Otherwise, the service uses a deterministic fallback summary; the Vapi assistant still uses its configured OpenAI model.
- Publish the assistant only after checking the webhook URL, credential, functions, and transfer route in Vapi's test panel.

## 3. Twilio number

- The Twilio credential connection has been added and verified in Make for the `Create a Message` module. The current scenario does not send messages. Do not use the shared credential in source code, local `.env`, or a blueprint; rotate it if exposed outside the provider's credential manager.
- Use a Twilio number reserved for the demo. Import it into Vapi and assign it to the assistant. The Node service does not need the Twilio Auth Token for this routing design.
- Place an inbound test call from an authorized test phone. Verify call answer, tool invocation, transfer behavior, and end-of-call report delivery.
- If changing to a direct Twilio-to-Node webhook, add Twilio SDK signature validation at that endpoint using the exact external URL. Do not reuse the Vapi bearer-secret check as Twilio signature verification.

## 4. HighLevel / GoHighLevel

- Use a sandbox or dedicated demo location, not a customer's live sub-account.
- Create an OAuth or Private Integration token with only the scopes required for contact and opportunity upsert. Store the token in the deployment secret manager as `GHL_ACCESS_TOKEN`.
- Set `GHL_LOCATION_ID`, `GHL_PIPELINE_ID`, and `GHL_PIPELINE_STAGE_ID`. Confirm duplicate-contact and opportunity policies in the demo location.
- Make one synthetic test call and verify exactly one contact and one open opportunity are created with the expected source and tags.

## 5. Google Calendar

- The Google Calendar connection has been added and verified in Make for free/busy, search, and event creation modules. The Node service requires a separate Google OAuth client and refresh token; it cannot read Make's stored credentials.
- Create a dedicated demo calendar and provide the service OAuth credentials through the deployment secret manager. Grant the minimum required Calendar scopes for free/busy and event creation.
- Configure `GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_TIMEZONE`, business hours, slot duration, days ahead, and minimum notice. Verify the configured time zone against the roofing team's real schedule.
- Test availability and confirmed event creation using synthetic caller details. Check the calendar event before using the tool with a real number.

## 6. Make.com scenario

- Create a Make Custom Webhook named for the roofing demo. Configure its scenario from `make/scenario-spec.json`; it receives the call ID, summary, and HighLevel contact ID after CRM sync.
- The intended flow is webhook intake → deduplication by `eventId` → urgent/routine router → an approved dispatcher notification action. The current repository contains a mapping specification, not an importable blueprint, and no scenario has been created in the Make workspace.
- Copy the generated webhook URL directly into the deployment secret manager as `MAKE_POST_CALL_WEBHOOK_URL`. Treat it as a secret because anyone holding it may be able to trigger the scenario.
- The checked-in mapping file is not an importable blueprint. After configuring the scenario and its account connections in Make, export its blueprint and replace the mapping spec only after importing and running that export in a clean demo team.
- Replay the same `eventId` twice and confirm only one downstream notification. Test Make's error handler and the app's `/admin/replay/{eventId}` recovery.

## 7. Acceptance run before the customer demo

- Real inbound test call answers through the imported Twilio number.
- Available appointment slots are fetched from the selected calendar and a booking is actually written. This code path is implemented, but live Node-to-Calendar credentials and the live booking test are still pending.
- Human transfer reaches the configured test destination after caller consent.
- A real HighLevel contact and opportunity appear once.
- A real Make scenario run appears once; duplicate webhook and replay tests do not send duplicate notifications.
- A simulated provider outage is recovered, and no secrets or full transcript appear in application logs.
- The team approves call recording/transcription settings, retention, and the destination of call summaries before using anything beyond synthetic test data.

Do not call the workflow production-ready until every required acceptance item above passes with the actual provider accounts and the intended hosting environment.
