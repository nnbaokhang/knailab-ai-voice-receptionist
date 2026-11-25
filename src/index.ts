import { createReceptionistServer } from "./service.ts";
import { log } from "./logger.ts";

const { server, store } = createReceptionistServer();
await store.load();
const port = Number(process.env.PORT ?? 8080);
server.listen(port, "0.0.0.0", () => log("info", "server_started", { port, mode: process.env.MOCK_INTEGRATIONS === "false" ? "live" : "mock" }));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
