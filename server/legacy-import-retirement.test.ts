import test from "node:test";
import assert from "node:assert/strict";
import { importScheduleData } from "./import-schedule";

test("retired fixture importer cannot reach a database through any direct caller", async () => {
  await assert.rejects(importScheduleData(), (error: any) => error.code === "LEGACY_IMPORT_RETIRED");
});

test("the old HTTP import endpoint is authenticated and retired before database access", async () => {
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/isolated";
  const express = (await import("express")).default;
  const { registerSchoolRoutes } = await import("./modules/school.routes");
  const { env } = await import("./config/env");
  const app = express();
  registerSchoolRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const anonymous = await fetch(`${base}/api/admin/import-schedule/synthetic`, { method: "POST" });
    assert.equal(anonymous.status, 401);
    const authorized = await fetch(`${base}/api/admin/import-schedule/synthetic`, { method: "POST", headers: { "x-admin-password": env.adminPassword } });
    assert.equal(authorized.status, 410);
    assert.equal((await authorized.json() as any).code, "LEGACY_IMPORT_RETIRED");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
