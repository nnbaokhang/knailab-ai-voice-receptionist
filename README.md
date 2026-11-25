# Knailab AI Voice Receptionist

TypeScript and Node.js demo backend for a fictional roofing company's inbound voice receptionist. Vapi handles the conversation, an OpenAI model powers the assistant, and Twilio provides the phone number. This service handles Vapi function calls and end-of-call reports, then syncs leads to HighLevel and sends a post-call event to Make.com.

> **Status:** portfolio prototype. Local mock mode and automated tests are intended to be runnable. Live Vapi, Twilio, OpenAI, HighLevel, and Make.com accounts have not been connected or tested. Do not describe this project as production ready until live acceptance testing is complete.

## Architecture

```mermaid
flowchart TD
  Caller --> Twilio["Twilio number"]
  Twilio --> Vapi["Vapi assistant · OpenAI"]
  Vapi --> Service["Node.js webhook service"]
  Service --> Store["Encrypted failed-event store"]
  Service --> GHL["HighLevel CRM"]
  Service --> Make["Make.com webhook"]
```

The Twilio number is imported into Vapi and assigned to the assistant. Vapi sends function calls and call reports to the public service URL. HighLevel contacts use the documented v3 upsert API; opportunity upsert is enabled when pipeline IDs are configured. Make receives the post-call event only after the CRM sync step succeeds.

## Included

- Vapi assistant and function-tool configuration examples for an OpenAI model.
- Appointment availability and pending booking tools. These use demo slots and do not create a real calendar event.
- Vapi Transfer Call is configured separately in Vapi with a real, reachable E.164 destination. The tool configuration intentionally leaves the destination unset.
- Structured post-call summary, optionally generated with OpenAI Structured Outputs.
- HighLevel contact upsert and optional pipeline opportunity upsert.
- Make Custom Webhook integration and scenario mapping specification.
- Bearer-protected Vapi webhooks and event replay route; timing-safe secret comparison.
- Event deduplication, transient HTTP retry with `Retry-After`, encrypted failed-event payload storage, redacted logs, and health checks.
- Docker, GitHub Actions, mock mode, synthetic payloads, and unit/integration tests.

## Local setup

Requires Node.js 24 or later. No provider credentials are required in mock mode.

```bash
cp .env.example .env
# Set VAPI_WEBHOOK_SECRET and ADMIN_API_KEY to distinct random values.
# Set EVENT_STORE_ENCRYPTION_KEY to base64 of 32 random bytes for durable encrypted replay.
# Example generator: openssl rand -base64 32
npm ci
npm test
npm run typecheck
npm start
```

Health endpoints:

- `GET /healthz` — process health.
- `GET /readyz` — mode and missing required configuration.
- `GET /demo/state` — event status summary in non-production environments; caller phone numbers are excluded.
- `POST /webhooks/vapi` — authenticated Vapi function calls and end-of-call reports.
- `POST /admin/replay/{eventId}` — replay a failed event with the admin bearer key.

Run in Docker:

```bash
docker compose up --build
```

Do not commit `.env` or `data/`. The event payload is encrypted with AES-256-GCM at rest. In mock mode, if no encryption key is supplied, a temporary process key is generated; encrypted events from that run cannot be replayed after a restart. Live mode requires `EVENT_STORE_ENCRYPTION_KEY`. Back up and rotate that key using a deliberate migration plan, or old event payloads become unreadable.

## Mock demonstration

Send a Vapi tool-call sample:

```bash
curl -sS http://localhost:8080/webhooks/vapi \
  -H 'Authorization: Bearer replace-with-a-long-random-secret' \
  -H 'Content-Type: application/json' \
  --data-binary @samples/vapi-tool-calls.json
```

Then post `samples/vapi-end-of-call-report.json` the same way. Responses identify `highLevel` and `make` as `mock`; the server does not claim that a real contact, opportunity, or Make run was created.

To simulate a Make outage and demonstrate event replay, start the service with `MOCK_FAIL_ONCE=make`. Post the end-of-call sample; the event is marked failed. Replay it:

```bash
curl -i -X POST \
  -H 'Authorization: Bearer replace-with-a-different-long-random-secret' \
  http://localhost:8080/admin/replay/demo-call-200%3Aend-of-call-report
```

This demo-only failure injection is used by the automated integration test. `MOCK_FAIL_ONCE` should not be set in a live deployment.

## Vapi, Twilio, and provider setup

See [`docs/integrations.md`](docs/integrations.md) for integration boundaries and API details. In brief:

1. Configure an OpenAI model for the Vapi assistant using [`config/vapi-assistant.json`](config/vapi-assistant.json).
2. Create the function tools represented by [`config/vapi-tools.json`](config/vapi-tools.json), set each tool's server URL to the deployed `/webhooks/vapi`, and attach the returned tool IDs to the assistant. Configure a Vapi Server URL credential to send `Authorization: Bearer <VAPI_WEBHOOK_SECRET>`.
3. Add a Vapi Transfer Call tool in the dashboard with the real human destination, set a caller-consent rule in its description, then attach it to the assistant. The app's `prepare_human_transfer` function only returns a handoff instruction; Vapi performs the phone transfer.
4. Import an owned Twilio number into Vapi. Test inbound calls only after the number, Vapi assistant, credential, and public HTTPS URL are configured.
5. Configure HighLevel scopes and location/pipeline IDs, then set the Make Custom Webhook URL. Build Make from [`make/scenario-spec.json`](make/scenario-spec.json). That file is a mapping spec, not an importable scenario export; export the actual blueprint from Make after creating its account-specific webhook and connections.

## Reliability and security notes

- Vapi call reports are encrypted and durably recorded before the webhook is acknowledged; CRM and Make work then runs asynchronously so provider latency does not block Vapi. Repeated completed/in-progress IDs do not rerun downstream work. Pending records are retried on process startup.
- Failed events can be replayed with `POST /admin/replay/{eventId}` and the admin bearer key. Only failed events are replayable.
- Failed-event payloads are encrypted before disk persistence. Logs use allowlisted fields and exclude common secret and PII fields.
- Outbound provider calls retry timeouts, HTTP 408/425/429, and 5xx using exponential backoff. Non-transient 4xx errors fail and are stored for operator replay.
- The JSON file event store is a single-process demo adapter. For multiple replicas or higher-volume deployment, replace it with a transactional database and shared locking/idempotency store before production.
- The appointment slots are fixed synthetic demo data. Human confirmation is required; no calendar service is integrated.
- `MOCK_INTEGRATIONS=true` is the default. Set `MOCK_INTEGRATIONS=false` only after supplying and validating real credentials. Live mode requires the secret, encryption key, HighLevel token/location, and Make webhook URL.
- Secrets must come from the deployment secret manager. Keep provider credentials out of GitHub, logs, frontend code, and screenshots.

## Test and CI

```bash
npm test
npm run typecheck
```

Tests cover retry behavior, encrypted storage, webhook authentication, deduplication, synthetic appointment lookup, failed-event capture, and replay recovery. GitHub Actions runs tests and type checking on pushes and pull requests.

## Demo materials

- Two-minute walkthrough: [`docs/demo-script.md`](docs/demo-script.md)
- Example mock execution: [`samples/demo-execution.md`](samples/demo-execution.md)
- Upwork portfolio blurb: [`docs/upwork-description.md`](docs/upwork-description.md)
- Sample Vapi payloads and synthetic contacts: [`samples/`](samples/)

## Acceptance checklist

| Criterion | Local result | Live status |
|---|---|---|
| End-to-end workflow | Automated mock test exercises event intake, summary, CRM/Make adapters | Pending provider accounts |
| Simulated API failure and recovery | Make mock failure is stored, then replayed successfully | Pending live failure drill |
| Duplicate webhook prevention | Same event ID returns duplicate acknowledgement; no second workflow run | Pending Vapi retry drill |
| Credential handling | `.env.example`, bearer secrets, encrypted event payloads, redacted logs | Pending secret-manager review |
| Automated tests | `npm test` | Run in CI after push |
| Reproduction instructions | README and demo script | Complete for mock mode |
