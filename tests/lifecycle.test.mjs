import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import { DEMO_EDGE_TOKEN, IDS } from "@smartgate/contracts";

test("vehicle retirement, scheduled move-out, and scoped cursor pages preserve lifecycle boundaries", async () => {
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
    const original = (await call("GET", "/snapshot", undefined, "resident")).json().vehicles[0];
    const additional = await call(
      "POST",
      "/enrollments",
      {
        property_id: IDS.property,
        plate: "NCR 9321",
        make: "Honda City",
        color: "Silver",
        format: "epc",
        value: "F20000000000000000000001",
      },
      "admin",
    );
    assert.equal(additional.statusCode, 201, additional.body);
    const secondVehicleId = additional.json().vehicle_id;

    const thirdVehicle = await call(
      "POST",
      "/enrollments",
      {
        property_id: IDS.property,
        plate: "NCR 9322",
        make: "Toyota Vios",
        color: "Blue",
        format: "epc",
        value: "F20000000000000000000002",
      },
      "admin",
    );
    assert.equal(thirdVehicle.statusCode, 201, thirdVehicle.body);
    const thirdVehicleId = thirdVehicle.json().vehicle_id;

    const retirement = await call(
      "POST",
      "/vehicle-retirement-requests",
      { vehicle_id: original.id, reason: "Sold to another owner" },
      "resident",
    );
    assert.equal(retirement.statusCode, 201, retirement.body);
    assert.equal(retirement.json().status, "pending");
    const versionBeforeRetirement = (
      await store.query("SELECT config_version FROM organizations WHERE id=$1", [IDS.organization])
    ).rows[0].config_version;
    const approvedRetirement = await call(
      "POST",
      `/vehicle-retirement-requests/${retirement.json().request_id}/approve`,
      { decision_note: "Sale verified" },
      "admin",
    );
    assert.equal(approvedRetirement.statusCode, 201, approvedRetirement.body);
    assert.equal(approvedRetirement.json().status, "approved");
    assert.equal(
      (
        await store.query("SELECT config_version FROM organizations WHERE id=$1", [
          IDS.organization,
        ])
      ).rows[0].config_version,
      versionBeforeRetirement + 1,
      "approval increments the organization configuration exactly once",
    );
    assert.ok(
      (await call("GET", "/snapshot", undefined, "admin"))
        .json()
        .properties.find((property) => property.id === IDS.property).occupancy_id,
      "retiring one vehicle leaves the household active",
    );
    assert.equal(
      (await store.query("SELECT active FROM vehicles WHERE id=$1", [secondVehicleId])).rows[0]
        .active,
      true,
    );
    assert.equal(
      (
        await call(
          "POST",
          `/vehicle-retirement-requests/${retirement.json().request_id}/approve`,
          {},
          "admin",
        )
      ).statusCode,
      400,
      "a repeated decision cannot retire or version the vehicle twice",
    );
    const residentVehicleB = (await call("GET", "/snapshot", undefined, "resident"))
      .json()
      .vehicles.find((vehicle) => vehicle.id === secondVehicleId);
    const withdrawn = await call(
      "POST",
      "/vehicle-retirement-requests",
      { vehicle_id: residentVehicleB.id, reason: "Submitted by mistake" },
      "resident",
    );
    assert.equal(withdrawn.statusCode, 201, withdrawn.body);
    const withdrawnRequest = await call(
      "POST",
      `/vehicle-retirement-requests/${withdrawn.json().request_id}/cancel`,
      {},
      "resident",
    );
    assert.equal(withdrawnRequest.statusCode, 201, withdrawnRequest.body);
    const directRetirement = await call(
      "POST",
      `/vehicles/${secondVehicleId}/retire`,
      { reason: "Confirmed vehicle sale" },
      "admin",
    );
    assert.equal(directRetirement.statusCode, 201, directRetirement.body);
    assert.equal(directRetirement.json().status, "approved");
    const stillActive = (await call("GET", "/snapshot", undefined, "resident"))
      .json()
      .vehicles.filter((vehicle) => vehicle.active);
    assert.deepEqual(
      stillActive.map((vehicle) => vehicle.id),
      [thirdVehicleId],
    );

    const initialSchedule = new Date(Date.now() + 20 * 60_000);
    const scheduled = await call(
      "POST",
      `/properties/${IDS.property}/move-out-schedule`,
      { effective_at: initialSchedule.toISOString(), reason: "Lease ends" },
      "admin",
    );
    assert.equal(scheduled.statusCode, 201, scheduled.body);
    assert.equal(scheduled.json().revision, 1);
    const laterSchedule = new Date(Date.now() + 30 * 60_000);
    const rescheduled = await call(
      "POST",
      `/properties/${IDS.property}/move-out-schedule`,
      { effective_at: laterSchedule.toISOString(), reason: "Updated lease end" },
      "admin",
    );
    assert.equal(rescheduled.statusCode, 201, rescheduled.body);
    assert.equal(rescheduled.json().schedule_id, scheduled.json().schedule_id);
    assert.equal(rescheduled.json().revision, 2);
    const cached = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
    assert.equal(cached.credentials.length, 1);
    for (const credential of cached.credentials)
      assert.equal(new Date(credential.valid_until).toISOString(), laterSchedule.toISOString());

    const cancellation = await call(
      "POST",
      `/properties/${IDS.property}/move-out-schedule/cancel`,
      {},
      "admin",
    );
    assert.equal(cancellation.statusCode, 201, cancellation.body);
    assert.equal(cancellation.json().status, "cancelled");
    const afterCancellation = (
      await call("GET", "/edge/v1/configuration", undefined, "edge")
    ).json();
    assert.ok(afterCancellation.credentials.every((credential) => credential.valid_until === null));

    const cutoff = new Date(Date.now() + 20 * 60_000);
    const finalSchedule = await call(
      "POST",
      `/properties/${IDS.property}/move-out-schedule`,
      { effective_at: cutoff.toISOString(), reason: "Household move-out" },
      "admin",
    );
    assert.equal(finalSchedule.statusCode, 201, finalSchedule.body);
    const staleInvite = await call(
      "POST",
      "/invitations",
      { email: "after-cutoff@example.test", role: "resident", property_id: IDS.property },
      "admin",
    );
    assert.equal(staleInvite.statusCode, 201, staleInvite.body);
    await store.query(
      "UPDATE property_occupancies SET started_at=now()-interval '10 minutes' WHERE id=$1",
      [finalSchedule.json().occupancy_id],
    );
    await store.query(
      "UPDATE scheduled_move_outs SET effective_at=now()-interval '1 second' WHERE id=$1",
      [finalSchedule.json().schedule_id],
    );
    assert.deepEqual(
      (await call("GET", "/auth/session", undefined, "resident")).json().principal.properties,
      [],
      "resident scope closes at the cutoff even before worker housekeeping",
    );
    const dueConfig = (await call("GET", "/edge/v1/configuration", undefined, "edge")).json();
    assert.ok(
      dueConfig.credentials.every((credential) => new Date(credential.valid_until) <= new Date()),
    );
    const staleAcceptance = await call("POST", "/auth/invitations/accept", {
      token: staleInvite.json().token,
      name: "Late Resident",
      password: "correct-horse-battery",
    });
    assert.equal(
      staleAcceptance.statusCode,
      409,
      "a due occupancy cannot accept an old invitation",
    );
    const blockedEnrollment = await call(
      "POST",
      "/enrollments",
      {
        property_id: IDS.property,
        plate: "NCR 9999",
        make: "Honda Civic",
        color: "White",
        format: "epc",
        value: "F20000000000000000000003",
      },
      "admin",
    );
    assert.equal(blockedEnrollment.statusCode, 400, "enrollment cannot bypass a due cutoff");
    const workerResults = await Promise.all([
      store.processDueScheduledMoveOuts(),
      store.processDueScheduledMoveOuts(),
    ]);
    const processed = workerResults.flat();
    assert.equal(
      processed.filter((result) => result.status === "ended").length,
      1,
      "concurrent workers close the occupancy once",
    );
    assert.ok(
      processed.every((result) => ["ended", "already_processed"].includes(result.status)),
      "a concurrent retry converges without a failed transition",
    );
    assert.deepEqual(await store.processDueScheduledMoveOuts(), [], "worker retry is idempotent");
    const ended = (
      await store.query(
        "SELECT o.ended_at,o.ended_by,s.effective_at,s.status,s.executed_by,s.completed_configuration_version FROM property_occupancies o JOIN scheduled_move_outs s ON s.occupancy_id=o.id WHERE s.id=$1",
        [finalSchedule.json().schedule_id],
      )
    ).rows[0];
    assert.equal(ended.status, "completed");
    assert.equal(
      new Date(ended.ended_at).toISOString(),
      new Date(ended.effective_at).toISOString(),
    );
    assert.equal(ended.ended_by, "a0000000-0000-4000-8000-000000000001");
    assert.equal(ended.executed_by, "system:scheduled-move-out");
    assert.ok(ended.completed_configuration_version > finalSchedule.json().configuration_version);
    const residentAfterMoveOut = (await call("GET", "/snapshot", undefined, "resident")).json();
    assert.equal(residentAfterMoveOut.properties.length, 0);
    const movedVehicles = (
      await store.query("SELECT id,active FROM vehicles WHERE id=ANY($1::uuid[])", [
        [original.id, secondVehicleId, thirdVehicleId],
      ])
    ).rows;
    assert.ok(movedVehicles.every((vehicle) => !vehicle.active));

    const nextHouseholdInvite = await call(
      "POST",
      "/invitations",
      { email: "next-household@example.test", role: "resident", property_id: IDS.property },
      "admin",
    );
    assert.equal(nextHouseholdInvite.statusCode, 201, nextHouseholdInvite.body);
    const nextResident = await call("POST", "/auth/invitations/accept", {
      token: nextHouseholdInvite.json().token,
      name: "Next Household",
      password: "correct-horse-battery",
    });
    assert.equal(nextResident.statusCode, 201, nextResident.body);
    const reenrolledPlate = await call(
      "POST",
      "/enrollments",
      {
        property_id: IDS.property,
        plate: original.plate,
        make: original.make,
        color: original.color,
        format: "epc",
        value: "F20000000000000000000004",
      },
      "admin",
    );
    assert.equal(reenrolledPlate.statusCode, 201, reenrolledPlate.body);
    const plateHistory = (
      await store.query(
        "SELECT id,occupancy_id,active FROM vehicles WHERE organization_id=$1 AND plate=$2",
        [IDS.organization, original.plate],
      )
    ).rows;
    assert.equal(plateHistory.length, 2);
    const historicalPlate = plateHistory.find((vehicle) => vehicle.id === original.id);
    const currentPlate = plateHistory.find(
      (vehicle) => vehicle.id === reenrolledPlate.json().vehicle_id,
    );
    assert.equal(historicalPlate.active, false);
    assert.equal(currentPlate.active, true);
    assert.notEqual(historicalPlate.occupancy_id, currentPlate.occupancy_id);

    // Establish that pages reach records beyond the old 300-member and 100-request snapshots.
    const userIds = Array.from({ length: 301 }, () => randomUUID());
    const membershipIds = userIds.map(() => randomUUID());
    const propertyMemberIds = userIds.map(() => randomUUID());
    const pagePropertyId = randomUUID();
    const pageOccupancyId = randomUUID();
    await store.query(
      "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,'Lot 999','Paging Household')",
      [pagePropertyId, IDS.organization],
    );
    await store.query(
      "INSERT INTO property_occupancies(id,organization_id,property_id,started_at,resident_name_at_start,created_by) VALUES($1,$2,$3,now(),'Paging Household',NULL)",
      [pageOccupancyId, IDS.organization, pagePropertyId],
    );
    const demoPasswordHash = (
      await store.query("SELECT password_hash FROM users WHERE id=$1", [
        "a0000000-0000-4000-8000-000000000003",
      ])
    ).rows[0].password_hash;
    const values = [];
    const groups = [];
    for (let index = 0; index < userIds.length; index++) {
      const offset = values.length;
      values.push(
        userIds[index],
        `page-${index}@example.test`,
        `Page Member ${index}`,
        demoPasswordHash,
      );
      groups.push(`($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},'active')`);
    }
    await store.query(
      `INSERT INTO users(id,email,name,password_hash,status) VALUES ${groups.join(",")}`,
      values,
    );
    values.length = 0;
    groups.length = 0;
    for (let index = 0; index < userIds.length; index++) {
      const offset = values.length;
      values.push(membershipIds[index], IDS.organization, userIds[index]);
      groups.push(`($${offset + 1},$${offset + 2},$${offset + 3},'resident','active')`);
    }
    await store.query(
      `INSERT INTO organization_memberships(id,organization_id,user_id,role,status) VALUES ${groups.join(",")}`,
      values,
    );
    values.length = 0;
    groups.length = 0;
    for (let index = 0; index < userIds.length; index++) {
      const offset = values.length;
      values.push(
        propertyMemberIds[index],
        IDS.organization,
        pagePropertyId,
        membershipIds[index],
        pageOccupancyId,
      );
      groups.push(
        `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},'family_member',false)`,
      );
    }
    await store.query(
      `INSERT INTO property_memberships(id,organization_id,property_id,membership_id,occupancy_id,relationship,is_primary_contact) VALUES ${groups.join(",")}`,
      values,
    );
    const memberIds = new Set();
    let memberCursor;
    do {
      const pageUrl = new URL(`http://localhost/properties/${pagePropertyId}/members`);
      pageUrl.searchParams.set("limit", "100");
      if (memberCursor) pageUrl.searchParams.set("cursor", memberCursor);
      const page = await call("GET", pageUrl.pathname + pageUrl.search, undefined, "admin");
      assert.equal(page.statusCode, 200, page.body);
      for (const member of page.json().items) memberIds.add(member.id);
      memberCursor = page.json().next_cursor;
    } while (memberCursor);
    assert.equal(memberIds.size, 301);

    for (let index = 0; index < 101; index++)
      await store.query(
        `INSERT INTO vehicle_retirement_requests(
           id,organization_id,property_id,occupancy_id,vehicle_id,requested_by,source,reason,
           status,decision_note,decided_by,resolved_at
         ) VALUES($1,$2,$3,$4,$5,$6,'resident','history fixture','rejected','closed',$6,now())`,
        [
          randomUUID(),
          IDS.organization,
          IDS.property,
          (
            await store.query(
              "SELECT id FROM property_occupancies WHERE property_id=$1 ORDER BY started_at LIMIT 1",
              [IDS.property],
            )
          ).rows[0].id,
          original.id,
          "fixture:retirement-history",
        ],
      );
    const retirementIds = new Set();
    let retirementCursor;
    do {
      const query = new URLSearchParams({
        kind: "vehicle_retirements",
        status: "rejected",
        property_id: IDS.property,
        limit: "50",
      });
      if (retirementCursor) query.set("cursor", retirementCursor);
      const page = await call("GET", `/lifecycle-requests?${query}`, undefined, "admin");
      assert.equal(page.statusCode, 200, page.body);
      for (const request of page.json().items) retirementIds.add(request.id);
      retirementCursor = page.json().next_cursor;
    } while (retirementCursor);
    assert.equal(retirementIds.size, 101);

    const householdPage = await call("GET", "/households?limit=1", undefined, "admin");
    assert.equal(householdPage.statusCode, 200, householdPage.body);
    assert.ok(householdPage.json().next_cursor);
    const reusedCursor = await call(
      "GET",
      `/households?limit=1&search=does-not-match&cursor=${encodeURIComponent(householdPage.json().next_cursor)}`,
      undefined,
      "admin",
    );
    assert.equal(reusedCursor.statusCode, 400, "cursors are bound to their selected filters");
    const foreignCursor = await call(
      "GET",
      `/households?limit=1&cursor=${encodeURIComponent(householdPage.json().next_cursor)}`,
      undefined,
      "other",
    );
    assert.equal(foreignCursor.statusCode, 400, "another organization cannot reuse a cursor");
  } finally {
    await app.close();
    await store.close();
  }
});
