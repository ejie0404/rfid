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
test("a second vehicle can be enrolled to an existing household without creating another property", async () => {
  const original = (await call("GET", "/snapshot")).json();
  const property = original.properties.find((row) => row.id === IDS.property);
  assert.ok(property);
  const result = await call("POST", "/enrollments", {
    property_id: property.id,
    plate: "SECOND 1",
    make: "Honda City",
    color: "Blue",
    format: "epc",
    value: "ABCDEF12",
  });
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.json().property_id, property.id);
  const after = (await call("GET", "/snapshot")).json();
  assert.equal(after.properties.length, original.properties.length);
  assert.equal(after.vehicles.filter((vehicle) => vehicle.property_id === property.id).length, 2);
  const otherVillage = await call(
    "POST",
    "/enrollments",
    {
      ...{
        property_id: property.id,
        plate: "FOREIGN 1",
        make: "Honda City",
        color: "Blue",
        format: "epc",
        value: "ABCDEF13",
      },
    },
    "other",
  );
  assert.equal(otherVillage.statusCode, 404);
});
test("suspension increments configuration version and reaches protocol output", async () => {
  const config = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
  assert.ok(validateProtocol("configuration", config));
  // Lane policy reaches the controller, and a credential with no recorded policy is authorized at
  // every lane in the village, so the controller always receives a usable list.
  assert.ok(config.credentials[0].lane_ids.length > 0, "a credential must name at least one lane");
  assert.ok(config.credentials[0].lane_ids.includes(IDS.lane));
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

test("village administrators can create organization-scoped sites and lanes", async () => {
  const before = (await call("GET", "/snapshot")).json().organization.config_version;
  const siteResponse = await call("POST", "/sites", { name: "West Gate", code: "WEST" });
  assert.equal(siteResponse.statusCode, 201, siteResponse.body);
  const site = siteResponse.json();
  const laneResponse = await call("POST", "/sites/" + site.site_id + "/lanes", {
    name: "Resident entry",
    direction: "entry",
  });
  assert.equal(laneResponse.statusCode, 201, laneResponse.body);
  const lane = laneResponse.json();
  const snapshot = (await call("GET", "/snapshot")).json();
  assert.ok(snapshot.sites.some((row) => row.id === site.site_id));
  assert.ok(snapshot.lanes.some((row) => row.id === lane.lane_id && row.site_id === site.site_id));
  assert.equal(snapshot.organization.config_version, before + 2);
  const crossVillage = await call(
    "POST",
    "/sites/" + site.site_id + "/lanes",
    { name: "Invalid cross village", direction: "entry" },
    "other",
  );
  assert.equal(crossVillage.statusCode, 404);
});

test("controller enrollment is one-time, lane-scoped, auditable, and revocable", async () => {
  const grantResponse = await call("POST", "/controllers/enrollment-grants", {
    name: "Palm Grove entry controller",
    site_id: IDS.site,
    lane_ids: [IDS.lane],
    expires_in_minutes: 15,
  });
  assert.equal(grantResponse.statusCode, 201, grantResponse.body);
  const grant = grantResponse.json();
  assert.match(grant.enrollment_code, /^sge_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(grant.enrollment_code, "smartgate-local-simulator-only");

  const installationId = randomUUID();
  const claimResponse = await app.inject({
    method: "POST",
    url: "/edge/v1/enrollment/claim",
    headers: { host: "localhost" },
    payload: {
      schema_version: 1,
      enrollment_code: grant.enrollment_code,
      installation_id: installationId,
      protocol_version: 1,
      software_version: "0.1.0",
    },
  });
  assert.equal(claimResponse.statusCode, 201, claimResponse.body);
  const enrollment = claimResponse.json();
  assert.equal(validateProtocol("controller-enrollment-response", enrollment), true);
  assert.equal(enrollment.organization_id, IDS.organization);
  assert.equal(enrollment.site_id, IDS.site);
  assert.deepEqual(enrollment.lane_ids, [IDS.lane]);

  const deviceCall = (method, url, payload) =>
    app.inject({
      method,
      url,
      headers: { host: "localhost", authorization: "Bearer " + enrollment.credential },
      ...(payload === undefined ? {} : { payload }),
    });
  const configurationResponse = await deviceCall("GET", "/edge/v1/configuration");
  assert.equal(configurationResponse.statusCode, 200, configurationResponse.body);
  const configuration = configurationResponse.json();
  assert.equal(validateProtocol("configuration", configuration), true);
  assert.equal(configuration.edge_id, enrollment.controller_id);
  assert.deepEqual(configuration.lane_ids, [IDS.lane]);
  assert.ok(
    configuration.credentials.every((credential) => credential.lane_ids.includes(IDS.lane)),
  );

  const otherGrantResponse = await call(
    "POST",
    "/controllers/enrollment-grants",
    { name: "Cedar Heights controller", site_id: IDS.otherSite, lane_ids: [IDS.otherLane] },
    "other",
  );
  assert.equal(otherGrantResponse.statusCode, 201, otherGrantResponse.body);
  const otherGrant = otherGrantResponse.json();
  const otherEnrollmentResponse = await app.inject({
    method: "POST",
    url: "/edge/v1/enrollment/claim",
    headers: { host: "localhost" },
    payload: {
      schema_version: 1,
      enrollment_code: otherGrant.enrollment_code,
      installation_id: randomUUID(),
      protocol_version: 1,
    },
  });
  assert.equal(otherEnrollmentResponse.statusCode, 201, otherEnrollmentResponse.body);
  const otherEnrollment = otherEnrollmentResponse.json();
  const otherConfigurationResponse = await app.inject({
    method: "GET",
    url: "/edge/v1/configuration",
    headers: { host: "localhost", authorization: "Bearer " + otherEnrollment.credential },
  });
  assert.equal(otherConfigurationResponse.statusCode, 200, otherConfigurationResponse.body);
  const otherConfiguration = otherConfigurationResponse.json();
  assert.equal(otherConfiguration.organization_id, IDS.otherOrganization);
  assert.equal(otherConfiguration.edge_id, otherEnrollment.controller_id);
  assert.deepEqual(otherConfiguration.lane_ids, [IDS.otherLane]);

  const storedCredential = await store.query(
    "SELECT credential_hash FROM controllers WHERE id=$1",
    [enrollment.controller_id],
  );
  assert.notEqual(storedCredential.rows[0].credential_hash, enrollment.credential);
  assert.equal(storedCredential.rows[0].credential_hash.length, 64);

  const vehicle = (await call("GET", "/snapshot")).json().vehicles[0];
  const event = {
    schema_version: 1,
    event_id: randomUUID(),
    organization_id: IDS.organization,
    edge_id: enrollment.controller_id,
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
    config_version: configuration.version,
    offline: false,
  };
  const eventResponse = await deviceCall("POST", "/edge/v1/events", { events: [event] });
  assert.equal(eventResponse.statusCode, 201, eventResponse.body);
  assert.deepEqual(eventResponse.json().acknowledged, [event.event_id]);
  const spoofedEvent = await app.inject({
    method: "POST",
    url: "/edge/v1/events",
    headers: { host: "localhost", authorization: "Bearer " + otherEnrollment.credential },
    payload: { events: [event] },
  });
  assert.equal(spoofedEvent.statusCode, 400);
  const crossOrganizationEvent = await deviceCall("POST", "/edge/v1/events", {
    events: [{ ...event, event_id: randomUUID(), organization_id: IDS.otherOrganization }],
  });
  assert.equal(crossOrganizationEvent.statusCode, 400);
  const crossLaneEvent = await deviceCall("POST", "/edge/v1/events", {
    events: [{ ...event, event_id: randomUUID(), lane_id: IDS.serviceLane }],
  });
  assert.equal(crossLaneEvent.statusCode, 400);

  const heartbeatResponse = await deviceCall("POST", "/edge/v1/heartbeat", {
    schema_version: 1,
    edge_id: enrollment.controller_id,
    organization_id: IDS.organization,
    reported_at: new Date().toISOString(),
    config_version: configuration.version,
    pending_events: 0,
    hardware_mode: "simulator",
    protocol_version: 1,
    software_version: "0.1.0",
  });
  assert.equal(heartbeatResponse.statusCode, 201, heartbeatResponse.body);
  const [controller] = (await call("GET", "/controllers")).json();
  assert.equal(controller.id, enrollment.controller_id);
  assert.equal(controller.protocol_version, 1);
  assert.equal(controller.software_version, "0.1.0");
  assert.equal(controller.pending_events, 0);
  assert.ok(controller.last_reported_at);

  const replay = await app.inject({
    method: "POST",
    url: "/edge/v1/enrollment/claim",
    headers: { host: "localhost" },
    payload: {
      schema_version: 1,
      enrollment_code: grant.enrollment_code,
      installation_id: randomUUID(),
      protocol_version: 1,
    },
  });
  assert.equal(replay.statusCode, 403);

  const rotation = await call(
    "POST",
    "/controllers/" + enrollment.controller_id + "/rotate-credential",
    {},
  );
  assert.equal(rotation.statusCode, 201, rotation.body);
  assert.equal((await deviceCall("GET", "/edge/v1/configuration")).statusCode, 401);
  const renewedCall = (method, url) =>
    app.inject({
      method,
      url,
      headers: { host: "localhost", authorization: "Bearer " + rotation.json().credential },
    });
  assert.equal((await renewedCall("GET", "/edge/v1/configuration")).statusCode, 200);
  const revoked = await call("POST", "/controllers/" + enrollment.controller_id + "/revoke", {
    reason: "pilot stopped",
  });
  assert.equal(revoked.statusCode, 201, revoked.body);
  assert.equal((await renewedCall("GET", "/edge/v1/configuration")).statusCode, 401);
  assert.ok(
    (
      await store.query(
        "SELECT id FROM audit_events WHERE action IN ('controller.enrollment_grant_created','controller.enrolled','controller.credential_rotated','controller.revoked')",
      )
    ).rows.length >= 4,
  );
});
