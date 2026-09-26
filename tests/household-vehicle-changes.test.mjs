import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import { DEMO_EDGE_TOKEN, IDS } from "@smartgate/contracts";

test("household roster changes and vehicle corrections stay scoped and auditable", async () => {
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
    for (const profile of ["admin", "resident", "other", "guard"]) {
      const session = await call("POST", "/demo/session", { profile });
      assert.equal(session.statusCode, 201, session.body);
      tokens[profile] = session.json().token;
    }
    tokens.edge = DEMO_EDGE_TOKEN;

    const householdInvite = await call(
      "POST",
      "/invitations",
      {
        email: "household-member@example.test",
        role: "resident",
        property_id: IDS.property,
        relationship: "tenant",
      },
      "admin",
    );
    assert.equal(householdInvite.statusCode, 201, householdInvite.body);
    const accepted = await call("POST", "/auth/invitations/accept", {
      token: householdInvite.json().token,
      name: "Household Member",
      password: "correct-horse-battery",
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    tokens.member = accepted.json().token;

    const adminRoster = (await call("GET", "/snapshot", undefined, "admin")).json()
      .property_members;
    const householdMember = adminRoster.find(
      (member) => member.email === "household-member@example.test",
    );
    const originalMember = adminRoster.find((member) => member.email === "resident@palmgrove.demo");
    assert.equal(householdMember.relationship, "tenant");
    assert.equal(householdMember.is_primary_contact, false);
    assert.equal(originalMember.is_primary_contact, true);
    const tenantVehicle = (await call("GET", "/snapshot", undefined, "member")).json().vehicles[0];
    const tenantCorrection = await call(
      "POST",
      "/vehicle-change-requests",
      {
        vehicle_id: tenantVehicle.id,
        plate: tenantVehicle.plate,
        make: tenantVehicle.make,
        color: "Black",
      },
      "member",
    );
    assert.equal(tenantCorrection.statusCode, 201, tenantCorrection.body);
    assert.equal(
      (await call("GET", "/snapshot", undefined, "resident")).json().property_members.length,
      0,
      "residents must not receive the HOA household roster",
    );

    assert.equal(
      (
        await call(
          "POST",
          `/properties/${IDS.property}/members/${householdMember.id}/primary`,
          {},
          "admin",
        )
      ).statusCode,
      201,
    );
    const promoted = (await call("GET", "/snapshot", undefined, "admin")).json().property_members;
    assert.equal(
      promoted.find((member) => member.id === householdMember.id).is_primary_contact,
      true,
    );
    assert.equal(
      promoted.find((member) => member.id === originalMember.id).is_primary_contact,
      false,
    );

    const removal = await call(
      "POST",
      `/properties/${IDS.property}/members/${householdMember.id}/end`,
      {},
      "admin",
    );
    assert.equal(removal.statusCode, 201, removal.body);
    assert.equal(removal.json().canceled_vehicle_change_count, 1);
    assert.equal(
      (
        await call(
          "POST",
          `/vehicle-change-requests/${tenantCorrection.json().request_id}/approve`,
          {},
          "admin",
        )
      ).statusCode,
      400,
    );
    const ended = (await call("GET", "/snapshot", undefined, "admin")).json().property_members;
    assert.ok(ended.find((member) => member.id === householdMember.id).ended_at);
    assert.equal(ended.find((member) => member.id === originalMember.id).is_primary_contact, true);
    assert.deepEqual(accepted.json().principal.properties, [IDS.property]);
    assert.deepEqual((await call("GET", "/snapshot", undefined, "member")).json().properties, []);
    assert.equal(
      (await call("GET", "/snapshot", undefined, "admin"))
        .json()
        .vehicle_change_requests.find(
          (request) => request.id === tenantCorrection.json().request_id,
        ).status,
      "cancelled",
    );

    const residentSnapshot = (await call("GET", "/snapshot", undefined, "resident")).json();
    const vehicle = residentSnapshot.vehicles[0];
    assert.ok(vehicle);
    await store.query(
      "INSERT INTO credential_lanes(id,organization_id,credential_id,lane_id) VALUES($1,$2,$3,$4)",
      [randomUUID(), IDS.organization, vehicle.credential_id, IDS.lane],
    );
    const relevantController = randomUUID();
    const unrelatedController = randomUUID();
    for (const [id, siteId, laneId, hash] of [
      [relevantController, IDS.site, IDS.lane, "a".repeat(64)],
      [unrelatedController, IDS.serviceSite, IDS.serviceLane, "b".repeat(64)],
    ]) {
      await store.query(
        "INSERT INTO controllers(id,installation_id,organization_id,site_id,name,credential_hash) VALUES($1,$2,$3,$4,'Correction test gate',$5)",
        [id, randomUUID(), IDS.organization, siteId, hash],
      );
      await store.query(
        "INSERT INTO controller_lanes(organization_id,controller_id,lane_id) VALUES($1,$2,$3)",
        [IDS.organization, id, laneId],
      );
    }

    assert.equal(
      (
        await call(
          "POST",
          "/vehicle-change-requests",
          {
            vehicle_id: vehicle.id,
            plate: vehicle.plate,
            make: vehicle.make,
            color: "Midnight blue",
          },
          "guard",
        )
      ).statusCode,
      403,
    );
    const beforeConfig = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
    const requested = await call(
      "POST",
      "/vehicle-change-requests",
      { vehicle_id: vehicle.id, plate: "NCR 9876", make: "Toyota Fortuner", color: "Pearl white" },
      "resident",
    );
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json().request_id;
    assert.equal(requested.json().status, "pending");
    assert.equal(
      (
        await call(
          "POST",
          "/vehicle-change-requests",
          {
            vehicle_id: vehicle.id,
            plate: "NCR 9877",
            make: "Toyota Fortuner",
            color: "Pearl white",
          },
          "resident",
        )
      ).statusCode,
      400,
      "only one vehicle correction may be pending",
    );
    assert.equal(
      (await call("GET", "/snapshot", undefined, "other")).json().vehicle_change_requests.length,
      0,
    );
    await store.query(
      "UPDATE vehicle_change_requests SET created_at=now()+interval '1 minute' WHERE id=$1",
      [tenantCorrection.json().request_id],
    );
    assert.equal(
      (await call("GET", "/snapshot", undefined, "admin")).json().vehicle_change_requests[0].id,
      requestId,
      "pending requests must appear before newer resolved history",
    );
    await store.query(
      "UPDATE vehicle_change_requests SET created_at=now()-interval '1 minute' WHERE id=$1",
      [tenantCorrection.json().request_id],
    );

    // Removing a separate HOA role must not cancel a request from the still-active resident role.
    const hoaInvite = await call(
      "POST",
      "/invitations",
      { email: "resident@palmgrove.demo", role: "hoa_admin" },
      "admin",
    );
    assert.equal(hoaInvite.statusCode, 201, hoaInvite.body);
    const addedHoaRole = await call(
      "POST",
      "/auth/invitations/accept",
      { token: hoaInvite.json().token },
      "resident",
    );
    assert.equal(addedHoaRole.statusCode, 201, addedHoaRole.body);
    assert.equal(addedHoaRole.json().principal.role, "hoa_admin");
    const memberships = (await call("GET", "/memberships", undefined, "admin")).json();
    const extraHoaRole = memberships.find(
      (membership) =>
        membership.email === "resident@palmgrove.demo" && membership.role === "hoa_admin",
    );
    assert.ok(extraHoaRole);
    const revokedHoaRole = await call(
      "POST",
      `/memberships/${extraHoaRole.id}/revoke`,
      { reason: "Separate HOA duty ended" },
      "admin",
    );
    assert.equal(revokedHoaRole.statusCode, 201, revokedHoaRole.body);
    assert.equal(
      (await call("GET", "/snapshot", undefined, "resident"))
        .json()
        .vehicle_change_requests.find((change) => change.id === requestId).status,
      "pending",
    );

    const approved = await call(
      "POST",
      `/vehicle-change-requests/${requestId}/approve`,
      { decision_note: "Verified against the registration" },
      "admin",
    );
    assert.equal(approved.statusCode, 201, approved.body);
    assert.equal(approved.json().expected_controllers, 1);
    const afterConfig = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
    assert.equal(afterConfig.version, beforeConfig.version + 1);
    assert.equal(
      afterConfig.credentials.find((row) => row.vehicle_id === vehicle.id).vehicle_plate,
      "NCR 9876",
    );
    let change = (await call("GET", "/snapshot", undefined, "resident")).json()
      .vehicle_change_requests[0];
    assert.equal(change.status, "approved");
    assert.equal(change.acknowledged_controllers, 0);
    await store.query("UPDATE controllers SET config_version=$1 WHERE id=$2", [
      afterConfig.version,
      relevantController,
    ]);
    change = (await call("GET", "/snapshot", undefined, "resident")).json()
      .vehicle_change_requests[0];
    assert.equal(change.expected_controllers, 1);
    assert.equal(change.acknowledged_controllers, 1);
    assert.equal(
      (
        await store.query(
          "SELECT controller_id FROM vehicle_change_controller_targets WHERE request_id=$1",
          [requestId],
        )
      ).rows.length,
      1,
    );

    const rejectedRequest = await call(
      "POST",
      "/vehicle-change-requests",
      { vehicle_id: vehicle.id, plate: "NCR 9876", make: "Toyota", color: "Blue" },
      "resident",
    );
    assert.equal(rejectedRequest.statusCode, 201, rejectedRequest.body);
    const rejected = await call(
      "POST",
      `/vehicle-change-requests/${rejectedRequest.json().request_id}/reject`,
      { decision_note: "Please attach the updated registration" },
      "admin",
    );
    assert.equal(rejected.statusCode, 201, rejected.body);
    assert.equal(
      (await call("GET", "/snapshot", undefined, "resident")).json().vehicle_change_requests[0]
        .status,
      "rejected",
    );

    const pendingAtMoveOut = await call(
      "POST",
      "/vehicle-change-requests",
      { vehicle_id: vehicle.id, plate: "NCR 9878", make: "Toyota Fortuner", color: "Pearl white" },
      "resident",
    );
    assert.equal(pendingAtMoveOut.statusCode, 201, pendingAtMoveOut.body);
    const movedOut = await call(
      "POST",
      `/properties/${IDS.property}/move-out`,
      { reason: "Household moved" },
      "admin",
    );
    assert.equal(movedOut.statusCode, 201, movedOut.body);
    assert.equal(movedOut.json().canceled_vehicle_change_count, 1);
    assert.equal(
      (await call("GET", "/snapshot", undefined, "admin"))
        .json()
        .vehicle_change_requests.find((row) => row.id === pendingAtMoveOut.json().request_id)
        .status,
      "cancelled",
    );
  } finally {
    await app.close();
    await store.close();
  }
});
