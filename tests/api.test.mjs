import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import { loadRuntimeConfig } from "../apps/api/dist/runtime-config.js";
import { attemptRule, RequestAttemptLimiter } from "../apps/api/dist/request-limiter.js";
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
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/snapshot",
    headers: {
      host: "localhost",
      origin: "http://localhost:3000",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "http://localhost:3000");
  assert.match(preflight.headers["access-control-allow-headers"], /authorization/i);
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
test("production runtime configuration requires external PostgreSQL and exact deployment settings", () => {
  const production = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://smartgate:secret@db.example.test:5432/smartgate",
    SMARTGATE_DEMO: "false",
    SMARTGATE_SKIP_MIGRATIONS: "true",
    HOST: "0.0.0.0",
    PORT: "4100",
    SMARTGATE_ALLOWED_ORIGINS: "https://control.example.test,https://guard.example.test",
    SMARTGATE_ALLOWED_HOSTS: "api.example.test",
    SMARTGATE_TRUSTED_PROXIES: "10.0.0.10",
  };
  const config = loadRuntimeConfig(production);
  assert.equal(config.production, true);
  assert.equal(config.demo, false);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 4100);
  assert.deepEqual(config.allowedOrigins, [
    "https://control.example.test",
    "https://guard.example.test",
  ]);
  assert.deepEqual(config.allowedHosts, ["api.example.test"]);
  assert.deepEqual(config.trustedProxies, ["10.0.0.10"]);

  assert.throws(
    () => loadRuntimeConfig({ ...production, DATABASE_URL: undefined }),
    /DATABASE_URL is required/,
  );
  assert.throws(
    () => loadRuntimeConfig({ ...production, SMARTGATE_DEMO: "true" }),
    /must be explicitly set to false/,
  );
  assert.throws(
    () => loadRuntimeConfig({ ...production, SMARTGATE_SKIP_MIGRATIONS: "false" }),
    /must be true in production/,
  );
  assert.throws(
    () =>
      loadRuntimeConfig({
        ...production,
        SMARTGATE_ALLOWED_ORIGINS: "https://*.vercel.app",
      }),
    /exact origins/,
  );
  assert.throws(
    () =>
      loadRuntimeConfig({
        ...production,
        SMARTGATE_ALLOWED_ORIGINS: "http://control.example.test",
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadRuntimeConfig({ ...production, SMARTGATE_ALLOWED_HOSTS: "*" }),
    /not wildcards/,
  );
  assert.throws(
    () => loadRuntimeConfig({ ...production, SMARTGATE_TRUSTED_PROXIES: "10.0.0.0/8" }),
    /individual IP addresses/,
  );
});

test("health readiness checks database connectivity and schema without leaking failures", async () => {
  const originalQuery = store.query;
  store.query = async () => {
    throw new Error("private database connection detail");
  };
  try {
    const live = await call("GET", "/health/live", undefined, null);
    const unavailable = await call("GET", "/health/ready", undefined, null);
    assert.equal(live.statusCode, 200);
    assert.equal(unavailable.statusCode, 503);
    assert.doesNotMatch(unavailable.body, /private database connection detail|DATABASE_URL/);
  } finally {
    store.query = originalQuery;
  }

  const migration = (
    await store.query("SELECT version,checksum FROM schema_migrations ORDER BY version LIMIT 1")
  ).rows[0];
  assert.ok(migration);
  await store.query("UPDATE schema_migrations SET checksum='mismatch' WHERE version=$1", [
    migration.version,
  ]);
  try {
    const mismatched = await call("GET", "/health/ready", undefined, null);
    assert.equal(mismatched.statusCode, 503);
    assert.doesNotMatch(mismatched.body, /checksum|migration|DATABASE_URL/);
  } finally {
    await store.query("UPDATE schema_migrations SET checksum=$2 WHERE version=$1", [
      migration.version,
      migration.checksum,
    ]);
  }
});

test("production mode refuses incomplete configuration before opening the database", async () => {
  const previous = { ...process.env };
  process.env.NODE_ENV = "production";
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(() => createApp(), /DATABASE_URL is required in production/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

/** Creates an isolated test app whose runtime configuration reads temporary environment values. */
async function createConfiguredApp(overrides) {
  const saved = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]));
  Object.assign(process.env, overrides);
  try {
    return await createApp({ test: true });
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("public controller enrollment attempts are bounded per source IP", async () => {
  const isolated = await createApp({ test: true });
  const attempt = (url, remoteAddress = "127.0.0.1") =>
    isolated.app.inject({
      method: "POST",
      url,
      remoteAddress,
      headers: { host: "localhost" },
      payload: {},
    });
  // The router sends each spelling to the same handler, so they must share one limit.
  const spellings = [
    "/edge/v1/enrollment/claim",
    "/edge/v1/enrollment/cl%61im",
    "/edge/v1/%65nrollment/claim?retry=1",
  ];
  try {
    for (let count = 0; count < 8; count++)
      assert.equal(
        (await attempt(spellings[count % spellings.length])).statusCode,
        400,
        `attempt ${count + 1} reaches the enrollment handler`,
      );
    for (const url of spellings) {
      const limited = await attempt(url);
      assert.equal(limited.statusCode, 429, url);
      assert.ok(Number(limited.headers["retry-after"]) > 0);
      assert.doesNotMatch(limited.body, /credential|DATABASE_URL/);
    }
    assert.equal((await attempt(spellings[1], "127.0.0.2")).statusCode, 400);
  } finally {
    await isolated.app.close();
    await isolated.store.close();
  }
});

test("sign-in attempts share one limit across equivalent request paths", async () => {
  const isolated = await createApp({ test: true });
  const attempt = (url) =>
    isolated.app.inject({
      method: "POST",
      url,
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost" },
      // No account is named, so the handler refuses each attempt without touching lockout state.
      payload: {},
    });
  const spellings = ["/auth/login", "/auth/log%69n", "/auth/%6cogin", "/auth/login?next=/x"];
  try {
    for (let count = 0; count < 30; count++)
      assert.equal(
        (await attempt(spellings[count % spellings.length])).statusCode,
        400,
        `attempt ${count + 1} reaches the sign-in handler`,
      );
    for (const url of spellings) assert.equal((await attempt(url)).statusCode, 429, url);
  } finally {
    await isolated.app.close();
    await isolated.store.close();
  }
});

test("a configured proxy is recognized in every equivalent address spelling", async () => {
  const isolated = await createConfiguredApp({
    SMARTGATE_ALLOWED_HOSTS: "api.example.test",
    // Mapped, plain IPv4, and uppercase expanded IPv6 spellings are all valid configuration.
    SMARTGATE_TRUSTED_PROXIES: "::ffff:10.0.0.10,10.0.0.20,2001:DB8:0:0:0:0:0:1",
  });
  const fromPeer = (remoteAddress) =>
    isolated.app.inject({
      method: "GET",
      url: "/health/live",
      remoteAddress,
      headers: { host: "internal.example.test:4100", "x-forwarded-host": "api.example.test" },
    });
  try {
    // Sockets report IPv4 peers in plain or mapped form and IPv6 peers in compressed form.
    for (const peer of ["10.0.0.10", "::ffff:10.0.0.10", "::ffff:10.0.0.20", "2001:db8::1"])
      assert.equal((await fromPeer(peer)).statusCode, 200, `${peer} is a configured proxy`);
    // Any other peer, including the distinct IPv4-compatible address, cannot set the public Host.
    for (const peer of ["10.0.0.11", "::10.0.0.10", "2001:db8::2", "127.0.0.1"])
      assert.equal((await fromPeer(peer)).statusCode, 403, `${peer} is not a configured proxy`);

    // Client-IP attribution for attempt limits makes the same trust decision.
    const claim = (remoteAddress, client) =>
      isolated.app.inject({
        method: "POST",
        url: "/edge/v1/enrollment/claim",
        remoteAddress,
        headers: { host: "api.example.test", "x-forwarded-for": client },
        payload: {},
      });
    for (let count = 0; count < 9; count++)
      assert.equal(
        (await claim("2001:db8::1", `203.0.113.${count + 1}`)).statusCode,
        400,
        "each client behind a configured proxy has its own budget",
      );
    for (let count = 0; count < 8; count++)
      assert.equal((await claim("::10.0.0.10", `198.51.100.${count + 1}`)).statusCode, 400);
    assert.equal(
      (await claim("::10.0.0.10", "198.51.100.99")).statusCode,
      429,
      "an untrusted peer is limited by its own address whatever it forwards",
    );
  } finally {
    await isolated.app.close();
    await isolated.store.close();
  }
});

test("attempt limiter resets an exhausted bucket when its window ends", () => {
  let now = 1_000;
  const limiter = new RequestAttemptLimiter(() => now);
  assert.deepEqual(limiter.take("login:127.0.0.1", 1, 1_000), { allowed: true });
  assert.deepEqual(limiter.take("login:127.0.0.1", 1, 1_000), {
    allowed: false,
    retryAfterSeconds: 1,
  });
  now += 1_000;
  assert.deepEqual(limiter.take("login:127.0.0.1", 1, 1_000), { allowed: true });
});

test("sensitive public routes share bounded attempt policies", () => {
  assert.equal(attemptRule("POST", "/auth/login")?.name, "identity-login");
  assert.equal(attemptRule("POST", "/auth/mfa/verify")?.name, "identity-mfa");
  assert.equal(attemptRule("POST", "/setup/operator")?.maximum, 5);
  assert.equal(attemptRule("POST", "/auth/invitations/accept")?.maximum, 20);
  assert.equal(attemptRule("POST", "/edge/v1/enrollment/claim")?.maximum, 8);
  assert.equal(attemptRule("POST", "/invitations"), undefined);
  assert.equal(attemptRule("POST", "/enrollments"), undefined);
  assert.equal(attemptRule("GET", "/auth/login"), undefined);
  assert.equal(attemptRule("POST", undefined), undefined, "an unmatched request has no handler");
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
