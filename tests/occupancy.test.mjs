import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import { DEMO_EDGE_TOKEN, IDS } from "@smartgate/contracts";

test("HOA move-out closes access, preserves history, and scopes a new household to a new occupancy", async () => {
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
    const residentSnapshot = (await call("GET", "/snapshot", undefined, "resident")).json();
    const property = residentSnapshot.properties.find((row) => row.id === IDS.property);
    const oldVehicle = residentSnapshot.vehicles.find((row) => row.property_id === IDS.property);
    const propertyId = property.id;
    const oldOccupancyId = property.occupancy_id;
    assert.ok(oldVehicle?.credential_id);
    assert.ok(oldOccupancyId);

    // A resident can retain access to another home after moving out of this one.
    const secondaryPropertyId = randomUUID();
    const secondaryOccupancyId = randomUUID();
    const secondaryVehicleId = randomUUID();
    const secondaryCredentialId = randomUUID();
    const residentMembershipId = (
      await store.query(
        "SELECT membership_id FROM property_memberships WHERE property_id=$1 AND ended_at IS NULL",
        [propertyId],
      )
    ).rows[0].membership_id;
    await store.query(
      "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,'Second home','Second Household')",
      [secondaryPropertyId, IDS.organization],
    );
    await store.query(
      "INSERT INTO property_occupancies(id,organization_id,property_id,started_at,resident_name_at_start) VALUES($1,$2,$3,now(),'Second Household')",
      [secondaryOccupancyId, IDS.organization, secondaryPropertyId],
    );
    await store.query(
      "INSERT INTO property_memberships(id,organization_id,property_id,membership_id,occupancy_id,relationship,is_primary_contact) VALUES($1,$2,$3,$4,$5,'owner',true)",
      [
        randomUUID(),
        IDS.organization,
        secondaryPropertyId,
        residentMembershipId,
        secondaryOccupancyId,
      ],
    );
    await store.query(
      "INSERT INTO vehicles(id,organization_id,property_id,occupancy_id,plate,make,color) VALUES($1,$2,$3,$4,'SECOND 2','Honda','Blue')",
      [secondaryVehicleId, IDS.organization, secondaryPropertyId, secondaryOccupancyId],
    );
    await store.query(
      "INSERT INTO credentials(id,organization_id,format,value,status,valid_from) VALUES($1,$2,'epc','AABBCC99','active',now())",
      [secondaryCredentialId, IDS.organization],
    );
    await store.query(
      "INSERT INTO assignments(id,organization_id,credential_id,vehicle_id) VALUES($1,$2,$3,$4)",
      [randomUUID(), IDS.organization, secondaryCredentialId, secondaryVehicleId],
    );

    const controllerId = randomUUID();
    await store.query(
      "INSERT INTO controllers(id,installation_id,organization_id,site_id,name,credential_hash) VALUES($1,$2,$3,$4,'Move-out test gate',$5)",
      [controllerId, randomUUID(), IDS.organization, IDS.site, "c".repeat(64)],
    );
    await store.query(
      "INSERT INTO controller_lanes(organization_id,controller_id,lane_id) VALUES($1,$2,$3)",
      [IDS.organization, controllerId, IDS.lane],
    );

    const oldEventId = randomUUID();
    const oldEvent = {
      event_id: oldEventId,
      vehicle_id: oldVehicle.id,
      vehicle_plate: oldVehicle.plate,
      observed_at: new Date().toISOString(),
    };
    await store.query(
      "INSERT INTO access_events(event_id,organization_id,edge_id,vehicle_id,payload) VALUES($1,$2,$3,$4,$5)",
      [oldEventId, IDS.organization, IDS.edge, oldVehicle.id, JSON.stringify(oldEvent)],
    );
    assert.equal((await call("GET", "/snapshot", undefined, "resident")).json().events.length, 1);

    const lossRequest = await call(
      "POST",
      "/credential-requests",
      { credential_id: oldVehicle.credential_id },
      "resident",
    );
    assert.equal(lossRequest.statusCode, 201, lossRequest.body);
    const staleInvite = await call(
      "POST",
      "/invitations",
      { email: "stale-resident@example.com", role: "resident", property_id: propertyId },
      "admin",
    );
    assert.equal(staleInvite.statusCode, 201, staleInvite.body);
    const configurationBefore = (
      await call("GET", "/edge/v1/configuration", undefined, "edge")
    ).json();
    assert.ok(
      configurationBefore.credentials.some(
        (credential) => credential.id === oldVehicle.credential_id,
      ),
    );
    assert.equal(
      (await call("POST", `/properties/${propertyId}/move-out`, {}, "resident")).statusCode,
      403,
    );
    assert.equal(
      (await call("POST", `/properties/${propertyId}/move-out`, {}, "other")).statusCode,
      404,
    );

    const movedOut = await call(
      "POST",
      `/properties/${propertyId}/move-out`,
      { reason: "Household moved out" },
      "admin",
    );
    assert.equal(movedOut.statusCode, 201, movedOut.body);
    assert.equal(movedOut.json().vehicle_count, 1);
    assert.equal(movedOut.json().credential_count, 1);
    assert.equal(movedOut.json().canceled_request_count, 1);
    assert.equal(movedOut.json().revoked_invitation_count, 1);
    assert.equal(movedOut.json().expected_controllers, 1);
    assert.equal(movedOut.json().acknowledged_controllers, 0);
    assert.equal(movedOut.json().configuration_version, configurationBefore.version + 1);
    const staleInvitation = await store.query("SELECT revoked_at FROM invitations WHERE id=$1", [
      staleInvite.json().invitation_id,
    ]);
    assert.ok(staleInvitation.rows[0].revoked_at);
    const staleInvitationAudit = await store.query(
      "SELECT detail FROM audit_events WHERE action='invitation.revoked' AND entity_id=$1",
      [staleInvite.json().invitation_id],
    );
    assert.equal(staleInvitationAudit.rows.length, 1);
    assert.equal(staleInvitationAudit.rows[0].detail.reason, "move_out");
    const staleAcceptance = await call("POST", "/auth/invitations/accept", {
      token: staleInvite.json().token,
      name: "Stale Invite",
      password: "correct-horse-battery",
    });
    assert.equal(staleAcceptance.statusCode, 401, staleAcceptance.body);

    const newConfiguration = (
      await call("GET", "/edge/v1/configuration", undefined, "edge")
    ).json();
    assert.equal(newConfiguration.version, movedOut.json().configuration_version);
    assert.equal(
      newConfiguration.credentials.some((credential) => credential.id === oldVehicle.credential_id),
      false,
    );
    assert.equal(
      newConfiguration.credentials.some((credential) => credential.id === secondaryCredentialId),
      true,
    );
    const formerResidentAfterMoveOut = (
      await call("GET", "/snapshot", undefined, "resident")
    ).json();
    assert.equal(
      formerResidentAfterMoveOut.properties.some((row) => row.id === propertyId),
      false,
    );
    assert.equal(
      formerResidentAfterMoveOut.properties.some((row) => row.id === secondaryPropertyId),
      true,
    );
    assert.equal(formerResidentAfterMoveOut.vehicles.length, 1);
    assert.equal(formerResidentAfterMoveOut.vehicles[0].id, secondaryVehicleId);
    assert.equal(formerResidentAfterMoveOut.events.length, 0);

    const adminSnapshot = (await call("GET", "/snapshot", undefined, "admin")).json();
    const formerOccupancy = adminSnapshot.occupancies.find((row) => row.id === oldOccupancyId);
    assert.ok(formerOccupancy?.ended_at);
    assert.equal(formerOccupancy.end_reason, "Household moved out");
    assert.equal(formerOccupancy.required_config_version, movedOut.json().configuration_version);
    assert.equal(formerOccupancy.expected_controllers, 1);
    assert.equal(formerOccupancy.acknowledged_controllers, 0);
    assert.equal(
      adminSnapshot.events.some((event) => event.event_id === oldEventId),
      true,
    );
    assert.equal(
      adminSnapshot.credential_requests.find(
        (request) => request.id === lossRequest.json().request_id,
      ).status,
      "rejected",
    );
    const formerVehicle = await store.query(
      "SELECT active,occupancy_id FROM vehicles WHERE id=$1",
      [oldVehicle.id],
    );
    assert.equal(formerVehicle.rows[0].active, false);
    assert.equal(formerVehicle.rows[0].occupancy_id, oldOccupancyId);
    const oldAssignment = await store.query(
      "SELECT ended_at FROM assignments WHERE credential_id=$1 AND ended_at IS NOT NULL",
      [oldVehicle.credential_id],
    );
    assert.equal(oldAssignment.rows.length, 1);

    await store.query("UPDATE controllers SET config_version=$1 WHERE id=$2", [
      movedOut.json().configuration_version,
      controllerId,
    ]);
    const acknowledged = (await call("GET", "/snapshot", undefined, "admin"))
      .json()
      .occupancies.find((row) => row.id === oldOccupancyId);
    assert.equal(acknowledged.acknowledged_controllers, 1);

    assert.equal(
      (await call("POST", `/properties/${propertyId}/move-out`, {}, "admin")).statusCode,
      400,
    );
    assert.equal(
      (
        await call(
          "POST",
          `/credential-requests/${lossRequest.json().request_id}/issue`,
          { format: "epc", value: "BEEF0001" },
          "admin",
        )
      ).statusCode,
      400,
    );
    const invite = await call(
      "POST",
      "/invitations",
      { email: "incoming-resident@example.com", role: "resident", property_id: propertyId },
      "admin",
    );
    assert.equal(invite.statusCode, 201, invite.body);
    const accepted = await call("POST", "/auth/invitations/accept", {
      token: invite.json().token,
      name: "Incoming Resident",
      password: "correct-horse-battery",
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    tokens.incoming = accepted.json().token;
    const incoming = (await call("GET", "/snapshot", undefined, "incoming")).json();
    assert.equal(incoming.vehicles.length, 0, "the new occupant must not inherit prior vehicles");
    assert.equal(incoming.events.length, 0, "the new occupant must not see prior occupancy events");
    assert.notEqual(incoming.properties[0].occupancy_id, oldOccupancyId);
    assert.equal(incoming.properties[0].resident_name, "Incoming Resident");
    await store.query("UPDATE vehicles SET active=true WHERE id=$1", [oldVehicle.id]);
    assert.equal(
      (await call("GET", "/snapshot", undefined, "incoming")).json().vehicles.length,
      0,
      "a legacy active flag must not expose a previous occupancy's vehicle",
    );
    await store.query("UPDATE vehicles SET active=false WHERE id=$1", [oldVehicle.id]);
    const formerOccupancyAfterReoccupancy = (await call("GET", "/snapshot", undefined, "admin"))
      .json()
      .occupancies.find((row) => row.id === oldOccupancyId);
    assert.equal(formerOccupancyAfterReoccupancy.resident_name, "Andrea Santos");

    const enrolled = await call(
      "POST",
      "/enrollments",
      {
        property_id: propertyId,
        plate: oldVehicle.plate,
        make: "Toyota Fortuner",
        color: "Pearl white",
        format: "epc",
        value: "FACEFEED",
      },
      "admin",
    );
    assert.equal(enrolled.statusCode, 201, enrolled.body);
    const incomingAfterEnrollment = (await call("GET", "/snapshot", undefined, "incoming")).json();
    assert.deepEqual(
      incomingAfterEnrollment.vehicles.map((vehicle) => vehicle.plate),
      [oldVehicle.plate],
    );
    const secondInvite = await call(
      "POST",
      "/invitations",
      { email: "incoming-family@example.com", role: "resident", property_id: propertyId },
      "admin",
    );
    assert.equal(secondInvite.statusCode, 201, secondInvite.body);
    const secondAccepted = await call("POST", "/auth/invitations/accept", {
      token: secondInvite.json().token,
      name: "Incoming Family Member",
      password: "correct-horse-battery",
    });
    assert.equal(secondAccepted.statusCode, 201, secondAccepted.body);
    tokens.incomingFamily = secondAccepted.json().token;
    const currentEventId = randomUUID();
    await store.query(
      "INSERT INTO access_events(event_id,organization_id,edge_id,vehicle_id,payload) VALUES($1,$2,$3,$4,$5)",
      [
        currentEventId,
        IDS.organization,
        IDS.edge,
        enrolled.json().vehicle_id,
        JSON.stringify({ event_id: currentEventId, vehicle_id: enrolled.json().vehicle_id }),
      ],
    );
    for (const profile of ["incoming", "incomingFamily"]) {
      const householdView = (await call("GET", "/snapshot", undefined, profile)).json();
      assert.deepEqual(
        householdView.events.map((event) => event.event_id),
        [currentEventId],
      );
      assert.equal(householdView.credential_requests.length, 0);
    }

    const raceInvite = await call(
      "POST",
      "/invitations",
      { email: "moveout-race@example.com", role: "resident", property_id: propertyId },
      "admin",
    );
    assert.equal(raceInvite.statusCode, 201, raceInvite.body);
    const [raceAcceptance, raceMoveOut] = await Promise.all([
      call("POST", "/auth/invitations/accept", {
        token: raceInvite.json().token,
        name: "Move-out Race Resident",
        password: "correct-horse-battery",
      }),
      call(
        "POST",
        `/properties/${propertyId}/move-out`,
        { reason: "Concurrent move-out" },
        "admin",
      ),
    ]);
    assert.equal(raceMoveOut.statusCode, 201, raceMoveOut.body);
    assert.ok([201, 401].includes(raceAcceptance.statusCode), raceAcceptance.body);
    const raceAccess = await store.query(
      `SELECT count(*)::int AS active_links
       FROM users u
       JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=$1
       JOIN property_memberships pm ON pm.membership_id=m.id
       WHERE u.email='moveout-race@example.com' AND pm.property_id=$2 AND pm.ended_at IS NULL`,
      [IDS.organization, propertyId],
    );
    assert.equal(raceAccess.rows[0].active_links, 0);
  } finally {
    await app.close();
    await store.close();
  }
});
