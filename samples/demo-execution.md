# Example mock execution

This transcript is a representative local mock run. Provider labels remain `mock`; it does not show real Vapi, Google Calendar, HighLevel, or Make activity.

1. `GET /healthz` returns `{"ok":true,"service":"knailab-ai-voice-receptionist"}`.
2. A valid `tool-calls` webhook for `demo-call-100` returns future synthetic availability slots derived from the configured business hours. Booking one returns `mode=mock` and `status=simulated`; the same call and slot reuse the same simulated appointment ID, and the booked slot is removed from subsequent availability. Posting an identical tool event again returns `{"accepted":true,"duplicate":true,"status":"completed"}`.
3. A valid `end-of-call-report` for `demo-call-200` is encrypted and recorded, then immediately acknowledged with HTTP `202` and `{"accepted":true,"queued":true,"eventId":"demo-call-200:end-of-call-report"}`.
4. When started with `MOCK_FAIL_ONCE=make`, the event is eventually recorded as `failed`. No caller transcript or phone is printed to logs.
5. `POST /admin/replay/demo-call-200%3Aend-of-call-report` with the admin bearer key returns HTTP `202`; the event then reaches `completed` with two processing attempts.

Run the automated integration tests to reproduce the calendar-tool and failure-replay paths. Mock slots are calculated from the business-hours settings; they are not live calendar availability.
