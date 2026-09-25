import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import { IDS, DEMO_EDGE_TOKEN, validateProtocol } from "@smartgate/contracts";
let app, store;
const token = {};
async function call(method, url, body, profile = "admin") {
  return app.inject({
    method,
    url,
    headers: {
      host: "localhost",
      ...(profile ? { authorization: "Bearer " + token[profile] } : {}),
    },
    ...(body === undefined ? {} : { payload: body }),
  });
}
before(async () => {
  ({ app, store } = await createApp({ test: true }));
  for (const profile of ["admin", "guard", "resident", "other"]) {
    const r = await call("POST", "/demo/session", { profile }, null);
    assert.equal(r.statusCode, 201);
    token[profile] = r.json().token;
  }
  token.edge = DEMO_EDGE_TOKEN;
});
after(async () => {
  await app?.close();
  await store?.close();
});
test("authentication and permissions are enforced by API", async () => {
  assert.equal((await call("GET", "/snapshot", undefined, null)).statusCode, 401);
  assert.equal((await call("POST", "/enrollments", {}, "guard")).statusCode, 403);
  assert.equal((await call("POST", "/enrollments", {}, "resident")).statusCode, 403);
  const rebinding = await app.inject({
    method: "GET",
    url: "/health",
    headers: { host: "attacker.example" },
  });
  assert.equal(rebinding.statusCode, 403);
  const origin = await app.inject({
    method: "POST",
    url: "/demo/session",
    headers: { host: "localhost", origin: "https://attacker.example" },
    payload: { profile: "admin" },
  });
  assert.equal(origin.statusCode, 403);
});
test("another village cannot retrieve or mutate this village's credentials", async () => {
  const first = (await call("GET", "/snapshot")).json();
  const other = (await call("GET", "/snapshot", undefined, "other")).json();
  assert.equal(other.vehicles.length, 0);
  assert.equal(other.organization.id, IDS.otherOrganization);
  assert.equal(
    (
      await call(
        "POST",
        "/credentials/" + first.vehicles[0].credential_id + "/status",
        { status: "suspended" },
        "other",
      )
    ).statusCode,
    404,
  );
});
test("enrollment is atomic, audited and scoped; invalid and duplicate identities are rejected", async () => {
  const payload = {
    resident: "Mia Cruz",
    property: "Lot 18",
    plate: "XYZ 5678",
    make: "Honda City",
    color: "Blue",
    format: "epc",
    value: "AABBCCDD",
  };
  const result = await call("POST", "/enrollments", payload);
  assert.equal(result.statusCode, 201, result.body);
  const duplicate = await call("POST", "/enrollments", payload);
  assert.equal(duplicate.statusCode, 400);
  const malformed = await call("POST", "/enrollments", {
    ...payload,
    format: "wiegand26",
    value: "E200",
  });
  assert.equal(malformed.statusCode, 400);
  const props = await store.query(
    "SELECT count(*)::int AS count FROM properties WHERE organization_id=$1",
    [IDS.organization],
  );
  assert.equal(props.rows[0].count, 2);
  const audit = await store.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE action='credential.enrolled'",
  );
  assert.equal(audit.rows[0].count, 1);
  const resident = (await call("GET", "/snapshot", undefined, "resident")).json();
  assert.equal(resident.vehicles.length, 1);
  const unauthorized = await call(
    "POST",
    "/credentials/" + result.json().credential_id + "/status",
    { status: "lost" },
    "resident",
  );
  assert.equal(unauthorized.statusCode, 404);
});
test("suspension increments configuration version and reaches protocol output", async () => {
  const config = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
  assert.ok(validateProtocol("configuration", config));
  const id = config.credentials[0].id;
  assert.equal(
    (await call("POST", "/credentials/" + id + "/status", { status: "suspended" })).statusCode,
    201,
  );
  const next = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
  assert.equal(next.version, config.version + 1);
  assert.equal(next.credentials.find((v) => v.id === id).status, "suspended");
});
test("20 deliveries produce one event; UUID collisions and device scope mismatches fail", async () => {
  const vehicle = (await call("GET", "/snapshot")).json().vehicles[0];
  const event = {
    schema_version: 1,
    event_id: randomUUID(),
    organization_id: IDS.organization,
    edge_id: IDS.edge,
    lane_id: IDS.lane,
    observed_at: new Date().toISOString(),
    edge_sequence: 1,
    format: "epc",
    value: vehicle.credential_value,
    credential_id: vehicle.credential_id,
    vehicle_id: vehicle.id,
    vehicle_plate: vehicle.plate,
    decision: "granted",
    reason: "VALID_CREDENTIAL",
    barrier_outcome: "simulated_open",
    passage_confirmed: false,
    config_version: 1,
    offline: false,
  };
  const deliveries = await Promise.all(
    Array.from({ length: 20 }, () => call("POST", "/edge/v1/events", { events: [event] }, "edge")),
  );
  for (const r of deliveries) assert.equal(r.statusCode, 201, r.body);
  const count = await store.query("SELECT count(*)::int AS count FROM access_events");
  assert.equal(count.rows[0].count, 1);
  assert.equal(
    (await call("POST", "/edge/v1/events", { events: [{ ...event, decision: "denied" }] }, "edge"))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/edge/v1/events",
        { events: [{ ...event, event_id: randomUUID(), organization_id: IDS.otherOrganization }] },
        "edge",
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/edge/v1/events",
        { events: [{ ...event, event_id: randomUUID(), passage_confirmed: true }] },
        "edge",
      )
    ).statusCode,
    400,
  );
  assert.equal((await call("GET", "/snapshot", undefined, "other")).json().events.length, 0);
});
test("resident can report own tag lost but cannot reactivate it", async () => {
  const vehicle = (await call("GET", "/snapshot", undefined, "resident")).json().vehicles[0];
  assert.equal(
    (
      await call(
        "POST",
        "/credentials/" + vehicle.credential_id + "/status",
        { status: "lost" },
        "resident",
      )
    ).statusCode,
    201,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/credentials/" + vehicle.credential_id + "/status",
        { status: "active" },
        "resident",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/credentials/" + vehicle.credential_id + "/status",
        { status: "active" },
        "admin",
      )
    ).statusCode,
    400,
  );
});
test("production mode refuses demonstration authentication", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(() => createApp(), /refuses production mode/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
