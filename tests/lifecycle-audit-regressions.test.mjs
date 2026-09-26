import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import { IDS } from "@smartgate/contracts";

test(
  "cutoff is rechecked after a blocked configuration update",
  { skip: process.env.SMARTGATE_TEST_POSTGRES !== "true", timeout: 20_000 },
  async () => {
    const { app, store, call } = await createFixture();
    try {
      for (const [index, action] of ["reschedule", "cancel"].entries()) {
        const propertyId = await createHousehold(store, call, `${index + 80}`);
        const scheduled = await schedule(call, propertyId, "Lock deadline regression");
        const cutoff = (
          await store.query(
            "UPDATE scheduled_move_outs SET effective_at=clock_timestamp()+interval '3 seconds' WHERE id=$1 RETURNING effective_at",
            [scheduled.schedule_id],
          )
        ).rows[0].effective_at;
        const version = (
          await store.query("SELECT config_version FROM organizations WHERE id=$1", [
            IDS.organization,
          ])
        ).rows[0].config_version;
        const controllerId = randomUUID();
        await store.query(
          "INSERT INTO controllers(id,installation_id,organization_id,site_id,name,credential_hash) VALUES($1,$2,$3,$4,'Lock regression controller',$5)",
          [
            controllerId,
            randomUUID(),
            IDS.organization,
            IDS.site,
            randomUUID().replaceAll("-", "").repeat(2),
          ],
        );
        const blocker = await store.pool.connect();
        let pending;
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [
            IDS.organization,
          ]);
          pending = call(
            "POST",
            `/properties/${propertyId}/move-out-schedule${action === "cancel" ? "/cancel" : ""}`,
            action === "cancel"
              ? {}
              : {
                  effective_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                  reason: "Cannot extend after waiting past the cutoff",
                },
          ).then((response) => response);
          let waiting = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            waiting =
              (
                await store.query(
                  "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND wait_event_type='Lock' AND query LIKE 'UPDATE organizations SET config_version=config_version+1%'",
                )
              ).rows.length > 0;
            if (waiting) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.ok(waiting, "the request must actually wait for the organization's lock");
          // Controller enrollment holds this organization lock before adding its schedule target.
          // Its FK lock must remain compatible with the waiting lifecycle edit's schedule lock.
          await blocker.query("SET LOCAL lock_timeout='500ms'");
          await blocker.query(
            "INSERT INTO scheduled_move_out_controller_targets(organization_id,schedule_id,revision,controller_id,configuration_version) VALUES($1,$2,1,$3,$4)",
            [IDS.organization, scheduled.schedule_id, controllerId, version],
          );
          await store.query(
            "SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.05)",
            [cutoff],
          );
          await blocker.query("COMMIT");
          const response = await pending;
          assert.equal(response.statusCode, 400, response.body);
          const unchanged = (
            await store.query(
              "SELECT status,revision,effective_at FROM scheduled_move_outs WHERE id=$1",
              [scheduled.schedule_id],
            )
          ).rows[0];
          assert.equal(unchanged.status, "scheduled");
          assert.equal(Number(unchanged.revision), 1);
          assert.equal(
            new Date(unchanged.effective_at).toISOString(),
            new Date(cutoff).toISOString(),
          );
          assert.equal(
            (
              await store.query("SELECT config_version FROM organizations WHERE id=$1", [
                IDS.organization,
              ])
            ).rows[0].config_version,
            version,
            "a rejected change must also roll back its configuration increment",
          );
        } finally {
          await blocker.query("ROLLBACK").catch(() => {});
          blocker.release();
          await pending?.catch(() => {});
        }
        const completed = await call("POST", `/properties/${propertyId}/move-out`, {});
        assert.equal(completed.statusCode, 201, completed.body);
        await store.query("UPDATE controllers SET status='revoked' WHERE id=$1", [controllerId]);
      }
    } finally {
      await app.close();
      await store.close();
    }
  },
);

async function createFixture() {
  const { app, store } = await createApp({ test: true });
  const tokens = {};
  for (const profile of ["admin", "resident"]) {
    const response = await app.inject({
      method: "POST",
      url: "/demo/session",
      payload: { profile },
      headers: { host: "localhost" },
    });
    assert.equal(response.statusCode, 201, response.body);
    tokens[profile] = response.json().token;
  }
  const call = (method, url, body, profile = "admin") =>
    app.inject({
      method,
      url,
      headers: { host: "localhost", authorization: `Bearer ${tokens[profile]}` },
      ...(body === undefined ? {} : { payload: body }),
    });
  return { app, store, call };
}

async function createHousehold(store, call, suffix) {
  const enrolled = await call("POST", "/enrollments", {
    property: `Audit household ${suffix}`,
    resident: `Audit resident ${suffix}`,
    plate: `AUDIT ${suffix}`,
    make: "Audit vehicle",
    color: "Blue",
    format: "epc",
    value: `F200000000000000000000${suffix}`,
  });
  assert.equal(enrolled.statusCode, 201, enrolled.body);
  return enrolled.json().property_id;
}

async function schedule(call, propertyId, reason) {
  const response = await call("POST", `/properties/${propertyId}/move-out-schedule`, {
    effective_at: new Date(Date.now() + 20 * 60_000).toISOString(),
    reason,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}

async function markDue(store, scheduleId, minutesOld) {
  await store.query(
    `UPDATE property_occupancies
     SET started_at=clock_timestamp()-interval '2 hours'
     WHERE id=(SELECT occupancy_id FROM scheduled_move_outs WHERE id=$1)`,
    [scheduleId],
  );
  await store.query(
    `UPDATE scheduled_move_outs
     SET effective_at=clock_timestamp()-($2::int*interval '1 minute') WHERE id=$1`,
    [scheduleId, minutesOld],
  );
}

test("due schedules cannot be changed and manual completion preserves the cutoff", async () => {
  const { app, store, call } = await createFixture();
  try {
    const propertyId = await createHousehold(store, call, "91");
    const resident = (await call("GET", "/snapshot", undefined, "resident")).json().principal;
    const occupancy = (
      await store.query(
        "SELECT id FROM property_occupancies WHERE organization_id=$1 AND property_id=$2 AND ended_at IS NULL",
        [IDS.organization, propertyId],
      )
    ).rows[0];
    const vehicle = (
      await store.query(
        "SELECT id FROM vehicles WHERE organization_id=$1 AND property_id=$2 AND active",
        [IDS.organization, propertyId],
      )
    ).rows[0];
    const currentMemberId = randomUUID();
    await store.query(
      `INSERT INTO property_memberships(
         id,organization_id,property_id,membership_id,occupancy_id,relationship,is_primary_contact
       ) VALUES($1,$2,$3,$4,$5,'owner',false)`,
      [currentMemberId, IDS.organization, propertyId, resident.membershipId, occupancy.id],
    );
    await store.query(
      "UPDATE property_memberships SET started_at=clock_timestamp()-interval '2 hours' WHERE id=$1",
      [currentMemberId],
    );
    const endedMemberIds = Array.from({ length: 51 }, () => randomUUID());
    await store.query(
      `INSERT INTO property_memberships(
         id,organization_id,property_id,membership_id,occupancy_id,relationship,
         is_primary_contact,started_at,ended_at
       )
       SELECT member_id,$1,$2,$3,$4,'family_member',false,
              clock_timestamp()-interval '1 hour'+(ordinality*interval '1 second'),
              clock_timestamp()-interval '30 minutes'+(ordinality*interval '1 second')
       FROM unnest($5::uuid[]) WITH ORDINALITY AS history(member_id,ordinality)`,
      [IDS.organization, propertyId, resident.membershipId, occupancy.id, endedMemberIds],
    );
    const memberPage = await call("GET", `/properties/${propertyId}/members?limit=50`);
    assert.equal(memberPage.statusCode, 200, memberPage.body);
    assert.ok(memberPage.json().items.some((member) => member.id === currentMemberId));

    const created = await schedule(call, propertyId, "Lease end");
    const retirement = await call(
      "POST",
      "/vehicle-retirement-requests",
      { vehicle_id: vehicle.id, reason: "Sold" },
      "resident",
    );
    assert.equal(retirement.statusCode, 201, retirement.body);
    await markDue(store, created.schedule_id, 1);

    const pending = await call(
      "GET",
      `/lifecycle-requests?kind=move_outs&status=pending&property_id=${propertyId}`,
    );
    assert.equal(pending.statusCode, 200, pending.body);
    assert.equal(pending.json().items[0].status, "scheduled");

    const rescheduled = await call("POST", `/properties/${propertyId}/move-out-schedule`, {
      effective_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      reason: "Too late to change",
    });
    assert.equal(rescheduled.statusCode, 400, rescheduled.body);
    const cancelled = await call("POST", `/properties/${propertyId}/move-out-schedule/cancel`, {});
    assert.equal(cancelled.statusCode, 400, cancelled.body);
    const retirementCancellation = await call(
      "POST",
      `/vehicle-retirement-requests/${retirement.json().request_id}/cancel`,
      {},
      "resident",
    );
    assert.equal(retirementCancellation.statusCode, 400, retirementCancellation.body);

    const residentSnapshot = await call("GET", "/snapshot", undefined, "resident");
    assert.equal(residentSnapshot.statusCode, 200, residentSnapshot.body);
    assert.ok(!residentSnapshot.json().principal.properties.includes(propertyId));

    const closed = await call("POST", `/properties/${propertyId}/move-out`, {
      reason: "Manual close",
    });
    assert.equal(closed.statusCode, 201, closed.body);
    const ended = (
      await store.query(
        `SELECT s.status,s.effective_at,o.ended_at,s.requested_by,s.executed_by
         FROM scheduled_move_outs s
         JOIN property_occupancies o ON o.id=s.occupancy_id
         WHERE s.id=$1`,
        [created.schedule_id],
      )
    ).rows[0];
    assert.equal(ended.status, "completed");
    assert.equal(
      new Date(ended.ended_at).toISOString(),
      new Date(ended.effective_at).toISOString(),
    );
    assert.ok(ended.executed_by);
  } finally {
    await app.close();
    await store.close();
  }
});

test("new controllers join active schedule targets and failed work does not starve later schedules", async () => {
  const { app, store, call } = await createFixture();
  try {
    const targetProperty = await createHousehold(store, call, "92");
    const targetSchedule = await schedule(call, targetProperty, "Controller target");
    const grant = await call("POST", "/controllers/enrollment-grants", {
      name: "Audit target controller",
      site_id: IDS.site,
      lane_ids: [IDS.lane],
      expires_in_minutes: 15,
    });
    assert.equal(grant.statusCode, 201, grant.body);
    const controller = await store.claimController({
      enrollmentCode: grant.json().enrollment_code,
      installationId: randomUUID(),
      protocolVersion: 1,
    });
    const target = (
      await store.query(
        `SELECT configuration_version FROM scheduled_move_out_controller_targets
         WHERE schedule_id=$1 AND controller_id=$2 AND revision=$3`,
        [targetSchedule.schedule_id, controller.controller_id, targetSchedule.revision],
      )
    ).rows[0];
    assert.ok(target);
    const snapshot = (await call("GET", "/snapshot")).json();
    const property = snapshot.properties.find((row) => row.id === targetProperty);
    assert.equal(Number(property.scheduled_expected_controllers), 1);

    const failingProperty = await createHousehold(store, call, "93");
    const healthyProperty = await createHousehold(store, call, "94");
    const failingSchedule = await schedule(call, failingProperty, "Injected retry");
    const healthySchedule = await schedule(call, healthyProperty, "Fair retry");
    await markDue(store, failingSchedule.schedule_id, 2);
    await markDue(store, healthySchedule.schedule_id, 1);
    const moveOut = store.moveOut.bind(store);
    store.moveOut = async (principal, propertyId, reason, options) => {
      if (options?.scheduleId === failingSchedule.schedule_id)
        throw new Error("Injected persistent failure");
      return moveOut(principal, propertyId, reason, options);
    };
    try {
      const first = await store.processDueScheduledMoveOuts(1);
      assert.equal(first[0].status, "failed");
      const failedRow = (
        await store.query(
          "SELECT retry_count,last_processing_error,next_attempt_at FROM scheduled_move_outs WHERE id=$1",
          [failingSchedule.schedule_id],
        )
      ).rows[0];
      assert.equal(Number(failedRow.retry_count), 1);
      assert.match(failedRow.last_processing_error, /Injected persistent failure/);
      assert.ok(new Date(failedRow.next_attempt_at) > new Date());
      const overdueSnapshot = (await call("GET", "/snapshot")).json();
      const failedSchedule = overdueSnapshot.scheduled_move_outs.find(
        (row) => row.id === failingSchedule.schedule_id,
      );
      assert.equal(Number(failedSchedule.retry_count), 1);
      assert.match(failedSchedule.last_processing_error, /Injected persistent failure/);

      const second = await store.processDueScheduledMoveOuts(1);
      assert.equal(second[0].schedule_id, healthySchedule.schedule_id);
      assert.equal(second[0].status, "ended", JSON.stringify(second));
    } finally {
      store.moveOut = moveOut;
    }
  } finally {
    await app.close();
    await store.close();
  }
});
