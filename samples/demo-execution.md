# Example mock execution

This transcript is a representative local mock run. Provider labels remain `mock`; it does not show real Vapi, HighLevel, or Make account activity.

1. `GET /healthz` returns `{"ok":true,"service":"knailab-ai-voice-receptionist"}`.
2. A valid `tool-calls` webhook for `demo-call-100` returns three synthetic availability slots. Posting the same payload again returns `{"accepted":true,"duplicate":true,"status":"completed"}`.
3. A valid `end-of-call-report` for `demo-call-200` is encrypted and recorded, then immediately acknowledged with HTTP `202` and `{"accepted":true,"queued":true,"eventId":"demo-call-200:end-of-call-report"}`.
4. When started with `MOCK_FAIL_ONCE=make`, the event is eventually recorded as `failed`. No caller transcript or phone is printed to logs.
5. `POST /admin/replay/demo-call-200%3Aend-of-call-report` with the admin bearer key returns HTTP `202`; the event then reaches `completed` with two processing attempts.

Run the automated integration test to reproduce the failure and replay path. The exact synthetic slots are declared in `src/service.ts` and are demo data, not calendar availability.
