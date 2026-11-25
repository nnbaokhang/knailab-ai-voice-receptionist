# Two-minute demo script

**0:00–0:20 — Introduce the flow.** Show the Mermaid architecture in the README. Explain that the demo uses a fictional roofing company, synthetic customer data, and mock provider adapters.

**0:20–0:45 — Run locally.** Run `npm run demo` to execute the complete mock flow, or start the container and open `/healthz` and `/readyz`. Point out that no real provider credentials are used by the demo command.

**0:45–1:10 — Simulate a call.** POST `samples/vapi-tool-calls.json` to `/webhooks/vapi` with the local bearer secret. Show the future mock slots generated from the configured business hours. Then book one slot with a synthetic phone number and show `status=simulated`; no real appointment is created. Submit the same payload again and show that it is acknowledged as a duplicate.

**1:10–1:40 — Simulate a completed call and outage.** Start with `MOCK_FAIL_ONCE=make`, POST `samples/vapi-end-of-call-report.json`, and show that failure is recorded without printing caller data. Use the admin replay endpoint with the demo API key, then show the event state is completed.

**1:40–2:00 — Close with integrations and boundaries.** Show the Vapi, Calendar, HighLevel, and Make setup notes. State clearly that local tests use mocks. The Make Google Calendar and Twilio credential connections are verified, but no Make scenario or live call workflow has been validated.
