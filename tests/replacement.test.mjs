import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import { DEMO_EDGE_TOKEN, IDS } from "@smartgate/contracts";

test("lost-tag replacement stays scoped, atomic, and visible through controller acknowledgement", async () => {
  const { app, store } = await createApp({ test: true });
  const tokens = {};
  const call = (method, url, body, profile) =>
    app.inject({
      method,
      url,
      headers: {
        host: "localhost",
        ...(profile ? { authorization: "Bearer " + tokens[profile] } : {}),
      },
      ...(body === undefined ? {} : { payload: body }),
    });
  try {
    for (const profile of ["admin", "resident", "guard", "other"]) {
      const session = await call("POST", "/demo/session", { profile });
      assert.equal(session.statusCode, 201, session.body);
      tokens[profile] = session.json().token;
    }
    tokens.edge = DEMO_EDGE_TOKEN;
    const residentBefore = (await call("GET", "/snapshot", undefined, "resident")).json();
    const vehicle = residentBefore.vehicles[0];
    assert.ok(vehicle?.credential_id);
    const oldId = vehicle.credential_id;
    const oldValue = vehicle.credential_value;
    const configBefore = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
    const original = configBefore.credentials.find((credential) => credential.id === oldId);
    assert.ok(original);

    // Give the tag an explicit lane policy. Only one of the two controllers serves that lane.
    await store.query(
      "INSERT INTO credential_lanes(id,organization_id,credential_id,lane_id) VALUES($1,$2,$3,$4)",
      [randomUUID(), IDS.organization, oldId, IDS.lane],
    );
    const relevantController = randomUUID();
    const unrelatedController = randomUUID();
    for (const [id, site, lane, hash] of [
      [relevantController, IDS.site, IDS.lane, "a".repeat(64)],
      [unrelatedController, IDS.serviceSite, IDS.serviceLane, "b".repeat(64)],
    ]) {
      await store.query(
        "INSERT INTO controllers(id,installation_id,organization_id,site_id,name,credential_hash) VALUES($1,$2,$3,$4,'Test controller',$5)",
        [id, randomUUID(), IDS.organization, site, hash],
      );
      await store.query(
        "INSERT INTO controller_lanes(organization_id,controller_id,lane_id) VALUES($1,$2,$3)",
        [IDS.organization, id, lane],
      );
    }

    assert.equal(
      (await call("POST", "/credential-requests", { credential_id: oldId }, "guard")).statusCode,
      403,
    );
    assert.equal(
      (await call("POST", "/credential-requests", { credential_id: oldId }, "admin")).statusCode,
      403,
    );
    const reported = await call(
      "POST",
      "/credential-requests",
      { credential_id: oldId },
      "resident",
    );
    assert.equal(reported.statusCode, 201, reported.body);
    const requestId = reported.json().request_id;
    const lostConfig = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
    assert.equal(lostConfig.version, configBefore.version + 1);
    assert.equal(
      lostConfig.credentials.find((credential) => credential.id === oldId).status,
      "lost",
    );
    const repeated = await call(
      "POST",
      "/credentials/" + oldId + "/status",
      { status: "lost" },
      "resident",
    );
    assert.equal(repeated.statusCode, 201, repeated.body);
    assert.equal(repeated.json().request_id, requestId);
    assert.equal(repeated.json().already_pending, true);
    assert.equal(
      (await call("GET", "/edge/v1/configuration", undefined, "edge")).json().version,
      lostConfig.version,
    );

    const residentRequests = (await call("GET", "/snapshot", undefined, "resident")).json()
      .credential_requests;
    assert.equal(residentRequests.length, 1);
    assert.equal(residentRequests[0].expected_controllers, 1);
    assert.equal(residentRequests[0].acknowledged_controllers, 0);
    assert.equal(
      (await call("GET", "/snapshot", undefined, "guard")).json().credential_requests.length,
      0,
    );
    assert.equal(
      (await call("GET", "/snapshot", undefined, "other")).json().credential_requests.length,
      0,
    );
    assert.equal(
      (
        await call(
          "POST",
          "/credential-requests/" + requestId + "/issue",
          { format: "epc", value: "F00DBA7E" },
          "other",
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await call(
          "POST",
          "/credential-requests/" + requestId + "/issue",
          { format: "epc", value: "F00DBA7E" },
          "resident",
        )
      ).statusCode,
      403,
    );

    const duplicate = await call(
      "POST",
      "/credential-requests/" + requestId + "/issue",
      { format: "epc", value: oldValue },
      "admin",
    );
    assert.equal(duplicate.statusCode, 400, duplicate.body);
    assert.equal(
      (await call("GET", "/edge/v1/configuration", undefined, "edge")).json().version,
      lostConfig.version,
    );
    const stillPending = (await call("GET", "/snapshot", undefined, "admin")).json();
    assert.equal(stillPending.credential_requests[0].status, "pending");
    assert.equal(stillPending.vehicles.find((row) => row.id === vehicle.id).credential_id, oldId);

    const issued = await call(
      "POST",
      "/credential-requests/" + requestId + "/issue",
      { format: "epc", value: "F00DBA7E" },
      "admin",
    );
    assert.equal(issued.statusCode, 201, issued.body);
    const replacementId = issued.json().credential_id;
    const issuedConfig = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
    assert.equal(issuedConfig.version, lostConfig.version + 1);
    assert.equal(
      issuedConfig.credentials.some((credential) => credential.id === oldId),
      false,
    );
    assert.deepEqual(
      issuedConfig.credentials.find((credential) => credential.id === replacementId).lane_ids,
      [IDS.lane],
    );
    assert.equal(
      (await call("GET", "/snapshot", undefined, "admin")).json().credential_requests[0]
        .acknowledged_controllers,
      0,
    );
    await store.query("UPDATE controllers SET config_version=$1 WHERE id=$2", [
      issuedConfig.version,
      relevantController,
    ]);
    const acknowledged = (await call("GET", "/snapshot", undefined, "resident")).json()
      .credential_requests[0];
    assert.equal(acknowledged.status, "issued");
    assert.equal(acknowledged.required_config_version, issuedConfig.version);
    assert.equal(acknowledged.expected_controllers, 1);
    assert.equal(acknowledged.acknowledged_controllers, 1);
    assert.equal(
      (
        await call(
          "POST",
          "/credential-requests/" + requestId + "/issue",
          { format: "epc", value: "DEC0DE00" },
          "admin",
        )
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
    await store.close();
  }
});

test("declining a replacement leaves the lost tag blocked and permits a later request", async () => {
  const { app, store } = await createApp({ test: true });
  const call = (method, url, body, token) =>
    app.inject({
      method,
      url,
      headers: { host: "localhost", ...(token ? { authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { payload: body }),
    });
  try {
    const admin = (await call("POST", "/demo/session", { profile: "admin" })).json().token;
    const resident = (await call("POST", "/demo/session", { profile: "resident" })).json().token;
    const credentialId = (await call("GET", "/snapshot", undefined, resident)).json().vehicles[0]
      .credential_id;
    const first = await call(
      "POST",
      "/credential-requests",
      { credential_id: credentialId },
      resident,
    );
    assert.equal(first.statusCode, 201, first.body);
    const rejected = await call(
      "POST",
      "/credential-requests/" + first.json().request_id + "/reject",
      { decision_note: "Verify ownership at the office" },
      admin,
    );
    assert.equal(rejected.statusCode, 201, rejected.body);
    assert.equal(
      (await call("POST", "/credentials/" + credentialId + "/status", { status: "active" }, admin))
        .statusCode,
      400,
    );
    const snapshot = (await call("GET", "/snapshot", undefined, resident)).json();
    assert.equal(snapshot.vehicles[0].credential_status, "lost");
    assert.equal(snapshot.credential_requests[0].status, "rejected");
    assert.equal(snapshot.credential_requests[0].decision_note, "Verify ownership at the office");
    const reopened = await call(
      "POST",
      "/credential-requests",
      { credential_id: credentialId },
      resident,
    );
    assert.equal(reopened.statusCode, 201, reopened.body);
    assert.notEqual(reopened.json().request_id, first.json().request_id);
    assert.equal(
      (await call("GET", "/snapshot", undefined, resident)).json().credential_requests[0].status,
      "pending",
    );
  } finally {
    await app.close();
    await store.close();
  }
});
