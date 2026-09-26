import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrationFiles } from "../apps/api/dist/migrations.js";

test("migrations 007 and 008 backfill open and closed household occupancy history", async () => {
  const db = new PGlite();
  try {
    const migrations = migrationFiles(new URL("../database/migrations/", import.meta.url));
    for (const migration of migrations.filter(
      (file) => file.version < "007_property_occupancies.sql",
    ))
      await db.exec(migration.sql);

    const organizationId = randomUUID();
    const activePropertyId = randomUUID();
    const closedPropertyId = randomUUID();
    const userId = randomUUID();
    const activeMembershipId = randomUUID();
    const closedMembershipId = activeMembershipId;
    const activeVehicleId = randomUUID();
    const closedVehicleId = randomUUID();
    const activeCredentialId = randomUUID();
    const closedCredentialId = randomUUID();
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Occupancy migration test')", [
      organizationId,
    ]);
    await db.query(
      "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$3,'Active home','Current Resident'),($2,$3,'Closed home','Former Resident')",
      [activePropertyId, closedPropertyId, organizationId],
    );
    await db.query(
      "INSERT INTO users(id,email,name,password_hash,status) VALUES($1,'occupancy@example.com','Resident','fixture','active')",
      [userId],
    );
    await db.query(
      "INSERT INTO organization_memberships(id,organization_id,user_id,role,status) VALUES($1,$2,$3,'resident','active')",
      [activeMembershipId, organizationId, userId],
    );
    await db.query(
      `INSERT INTO property_memberships(id,organization_id,property_id,membership_id,relationship,started_at,ended_at)
       VALUES($1,$2,$3,$4,'owner','2023-01-01T00:00:00Z',NULL),
             ($5,$2,$6,$7,'owner','2021-01-01T00:00:00Z','2022-01-01T00:00:00Z')`,
      [
        randomUUID(),
        organizationId,
        activePropertyId,
        activeMembershipId,
        randomUUID(),
        closedPropertyId,
        closedMembershipId,
      ],
    );
    await db.query(
      `INSERT INTO vehicles(id,organization_id,property_id,plate,make,color,active)
       VALUES($1,$3,$4,'ACTIVE 1','Toyota','White',true),($2,$3,$5,'CLOSED 1','Honda','Blue',false)`,
      [activeVehicleId, closedVehicleId, organizationId, activePropertyId, closedPropertyId],
    );
    await db.query(
      `INSERT INTO credentials(id,organization_id,format,value,status,valid_from)
       VALUES($1,$3,'epc','AABBCCDD','active','2024-01-01T00:00:00Z'),
             ($2,$3,'epc','11223344','revoked','2021-01-01T00:00:00Z')`,
      [activeCredentialId, closedCredentialId, organizationId],
    );
    await db.query(
      `INSERT INTO assignments(id,organization_id,credential_id,vehicle_id,started_at,ended_at)
       VALUES($1,$2,$3,$4,'2024-01-01T00:00:00Z',NULL),
             ($5,$2,$6,$7,'2021-01-01T00:00:00Z','2022-02-01T00:00:00Z')`,
      [
        randomUUID(),
        organizationId,
        activeCredentialId,
        activeVehicleId,
        randomUUID(),
        closedCredentialId,
        closedVehicleId,
      ],
    );

    const occupancyMigration = migrations.find(
      (file) => file.version === "007_property_occupancies.sql",
    );
    assert.ok(occupancyMigration);
    await db.exec(occupancyMigration.sql);
    const occupancyGuardMigration = migrations.find(
      (file) => file.version === "008_occupancy_history_guard.sql",
    );
    assert.ok(occupancyGuardMigration);
    await db.exec(occupancyGuardMigration.sql);

    const rows = (
      await db.query(
        `SELECT o.property_id,o.started_at,o.ended_at,v.occupancy_id AS vehicle_occupancy_id,
                pm.occupancy_id AS membership_occupancy_id
         FROM property_occupancies o
         LEFT JOIN vehicles v ON v.property_id=o.property_id
         LEFT JOIN property_memberships pm ON pm.property_id=o.property_id
         WHERE o.organization_id=$1 ORDER BY o.property_id`,
        [organizationId],
      )
    ).rows;
    assert.equal(rows.length, 2);
    const active = rows.find((row) => row.property_id === activePropertyId);
    const closed = rows.find((row) => row.property_id === closedPropertyId);
    assert.ok(active);
    assert.ok(closed);
    assert.equal(active.ended_at, null);
    assert.equal(new Date(active.started_at).toISOString(), "2023-01-01T00:00:00.000Z");
    assert.equal(active.vehicle_occupancy_id, active.membership_occupancy_id);
    assert.ok(closed.ended_at);
    assert.ok(new Date(closed.ended_at) > new Date(closed.started_at));
    assert.equal(new Date(closed.ended_at).toISOString(), "2022-02-01T00:00:00.000Z");
    assert.equal(closed.vehicle_occupancy_id, closed.membership_occupancy_id);
  } finally {
    await db.close();
  }
});

test("migration 008 isolates a former household's vehicles and events", async () => {
  const db = new PGlite();
  try {
    const migrations = migrationFiles(new URL("../database/migrations/", import.meta.url));
    for (const migration of migrations.filter(
      (file) => file.version < "007_property_occupancies.sql",
    ))
      await db.exec(migration.sql);

    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const formerUserId = randomUUID();
    const currentUserId = randomUUID();
    const laterUserId = randomUUID();
    const formerMembershipId = randomUUID();
    const currentMembershipId = randomUUID();
    const laterMembershipId = randomUUID();
    const formerPropertyMembershipId = randomUUID();
    const currentPropertyMembershipId = randomUUID();
    const laterPropertyMembershipId = randomUUID();
    const formerVehicleId = randomUUID();
    const currentVehicleId = randomUUID();
    const formerCredentialId = randomUUID();
    const currentCredentialId = randomUUID();
    const formerEventId = randomUUID();
    const edgeId = randomUUID();

    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Reused property test')", [
      organizationId,
    ]);
    await db.query(
      "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,'Reused home','Current Household')",
      [propertyId, organizationId],
    );
    await db.query(
      `INSERT INTO users(id,email,name,password_hash,status)
       VALUES($1,'former@example.com','Former Household','fixture','active'),
             ($2,'current@example.com','Current Household','fixture','active'),
             ($3,'later@example.com','Later Member','fixture','active')`,
      [formerUserId, currentUserId, laterUserId],
    );
    await db.query(
      `INSERT INTO organization_memberships(id,organization_id,user_id,role,status)
       VALUES($1,$3,$4,'resident','active'),($2,$3,$5,'resident','active'),
             ($6,$3,$7,'resident','active')`,
      [
        formerMembershipId,
        currentMembershipId,
        organizationId,
        formerUserId,
        currentUserId,
        laterMembershipId,
        laterUserId,
      ],
    );
    await db.query(
      `INSERT INTO property_memberships(id,organization_id,property_id,membership_id,relationship,started_at,ended_at)
       VALUES($1,$3,$4,$5,'owner','2021-01-01T00:00:00Z','2022-12-31T00:00:00Z'),
             ($2,$3,$4,$6,'owner','2023-01-01T00:00:00Z',NULL),
             ($7,$3,$4,$8,'family_member','2024-01-01T00:00:00Z',NULL)`,
      [
        formerPropertyMembershipId,
        currentPropertyMembershipId,
        organizationId,
        propertyId,
        formerMembershipId,
        currentMembershipId,
        laterPropertyMembershipId,
        laterMembershipId,
      ],
    );
    await db.query(
      `INSERT INTO vehicles(id,organization_id,property_id,plate,make,color,active)
       VALUES($1,$3,$4,'FORMER 1','Toyota','White',false),
             ($2,$3,$4,'CURRENT 1','Honda','Blue',true)`,
      [formerVehicleId, currentVehicleId, organizationId, propertyId],
    );
    await db.query(
      `INSERT INTO credentials(id,organization_id,format,value,status,valid_from)
       VALUES($1,$3,'epc','AABBCC01','revoked','2021-01-01T00:00:00Z'),
             ($2,$3,'epc','AABBCC02','active','2023-01-01T00:00:00Z')`,
      [formerCredentialId, currentCredentialId, organizationId],
    );
    await db.query(
      `INSERT INTO assignments(id,organization_id,credential_id,vehicle_id,started_at,ended_at)
       VALUES($1,$2,$3,$4,'2021-01-01T00:00:00Z','2022-12-31T00:00:00Z'),
             ($5,$2,$6,$7,'2023-01-01T00:00:00Z',NULL)`,
      [
        randomUUID(),
        organizationId,
        formerCredentialId,
        formerVehicleId,
        randomUUID(),
        currentCredentialId,
        currentVehicleId,
      ],
    );
    await db.query(
      `INSERT INTO access_events(event_id,organization_id,edge_id,vehicle_id,payload,received_at)
       VALUES($1,$2,$3,$4,$5,'2022-06-01T00:00:00Z'),
             ($6,$2,$3,$7,$8,'2023-06-01T00:00:00Z')`,
      [
        formerEventId,
        organizationId,
        edgeId,
        formerVehicleId,
        JSON.stringify({ event_id: formerEventId }),
        randomUUID(),
        currentVehicleId,
        JSON.stringify({ current: true }),
      ],
    );

    const occupancyMigration = migrations.find(
      (file) => file.version === "007_property_occupancies.sql",
    );
    const occupancyGuardMigration = migrations.find(
      (file) => file.version === "008_occupancy_history_guard.sql",
    );
    assert.ok(occupancyMigration);
    assert.ok(occupancyGuardMigration);
    await db.exec(occupancyMigration.sql);
    await db.exec(occupancyGuardMigration.sql);

    const ownership = (
      await db.query(
        `SELECT former_pm.occupancy_id AS former_membership_occupancy,
                former_v.occupancy_id AS former_vehicle_occupancy,
                current_pm.occupancy_id AS current_membership_occupancy,
                current_v.occupancy_id AS current_vehicle_occupancy,
                former_o.ended_at AS former_occupancy_ended_at,
                former_o.started_at AS former_occupancy_started_at,
                current_o.resident_name_at_start AS current_household_name,
                current_o.started_at AS current_household_started_at
         FROM property_memberships former_pm
         JOIN vehicles former_v ON former_v.id=$1
         JOIN property_memberships current_pm ON current_pm.id=$2
         JOIN vehicles current_v ON current_v.id=$3
         JOIN property_occupancies former_o ON former_o.id=former_pm.occupancy_id
         JOIN property_occupancies current_o ON current_o.id=current_pm.occupancy_id
         WHERE former_pm.id=$4`,
        [
          formerVehicleId,
          currentPropertyMembershipId,
          currentVehicleId,
          formerPropertyMembershipId,
        ],
      )
    ).rows[0];
    assert.ok(ownership.former_occupancy_ended_at);
    assert.equal(
      new Date(ownership.former_occupancy_started_at).toISOString(),
      "2021-01-01T00:00:00.000Z",
    );
    assert.equal(
      new Date(ownership.former_occupancy_ended_at).toISOString(),
      "2022-12-31T00:00:00.000Z",
    );
    assert.notEqual(ownership.former_membership_occupancy, ownership.current_membership_occupancy);
    assert.equal(ownership.former_membership_occupancy, ownership.former_vehicle_occupancy);
    assert.equal(ownership.current_membership_occupancy, ownership.current_vehicle_occupancy);
    assert.equal(ownership.current_household_name, "Current Household");
    assert.equal(
      new Date(ownership.current_household_started_at).toISOString(),
      "2023-01-01T00:00:00.000Z",
    );

    const visibleFormerEvents = await db.query(
      `SELECT e.event_id
       FROM access_events e
       JOIN vehicles v ON v.id=e.vehicle_id AND v.organization_id=e.organization_id
       WHERE e.organization_id=$1 AND v.property_id=$2
         AND e.event_id=$4
         AND EXISTS (SELECT 1 FROM property_memberships pm
                     WHERE pm.occupancy_id=v.occupancy_id
                       AND pm.membership_id=$3 AND pm.ended_at IS NULL)`,
      [organizationId, propertyId, currentMembershipId, formerEventId],
    );
    assert.deepEqual(visibleFormerEvents.rows, []);
  } finally {
    await db.close();
  }
});

test("migration 008 refuses active vehicle events from before the current household", async () => {
  const db = new PGlite();
  try {
    const migrations = migrationFiles(new URL("../database/migrations/", import.meta.url));
    for (const migration of migrations.filter(
      (file) => file.version < "007_property_occupancies.sql",
    ))
      await db.exec(migration.sql);

    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    const propertyMembershipId = randomUUID();
    const vehicleId = randomUUID();
    const credentialId = randomUUID();
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Ambiguous history test')", [
      organizationId,
    ]);
    await db.query(
      "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,'Ambiguous home','Current Resident')",
      [propertyId, organizationId],
    );
    await db.query(
      "INSERT INTO users(id,email,name,password_hash,status) VALUES($1,'current@example.com','Current Resident','fixture','active')",
      [userId],
    );
    await db.query(
      "INSERT INTO organization_memberships(id,organization_id,user_id,role,status) VALUES($1,$2,$3,'resident','active')",
      [membershipId, organizationId, userId],
    );
    await db.query(
      `INSERT INTO property_memberships(id,organization_id,property_id,membership_id,relationship,started_at)
       VALUES($1,$2,$3,$4,'owner','2023-01-01T00:00:00Z')`,
      [propertyMembershipId, organizationId, propertyId, membershipId],
    );
    await db.query(
      `INSERT INTO vehicles(id,organization_id,property_id,plate,make,color,active)
       VALUES($1,$2,$3,'UNKNOWN 1','Toyota','White',true)`,
      [vehicleId, organizationId, propertyId],
    );
    await db.query(
      `INSERT INTO credentials(id,organization_id,format,value,status,valid_from)
       VALUES($1,$2,'epc','AABBCC03','active','2021-01-01T00:00:00Z')`,
      [credentialId, organizationId],
    );
    await db.query(
      `INSERT INTO assignments(id,organization_id,credential_id,vehicle_id,started_at)
       VALUES($1,$2,$3,$4,'2021-01-01T00:00:00Z')`,
      [randomUUID(), organizationId, credentialId, vehicleId],
    );
    await db.query(
      `INSERT INTO access_events(event_id,organization_id,edge_id,vehicle_id,payload,received_at)
       VALUES($1,$2,$3,$4,$5,'2022-06-01T00:00:00Z')`,
      [randomUUID(), organizationId, randomUUID(), vehicleId, JSON.stringify({ legacy: true })],
    );

    const occupancyMigration = migrations.find(
      (file) => file.version === "007_property_occupancies.sql",
    );
    const occupancyGuardMigration = migrations.find(
      (file) => file.version === "008_occupancy_history_guard.sql",
    );
    assert.ok(occupancyMigration);
    assert.ok(occupancyGuardMigration);
    await db.exec(occupancyMigration.sql);
    await assert.rejects(db.exec(occupancyGuardMigration.sql), /Occupancy history is ambiguous/);
  } finally {
    await db.close();
  }
});

test("migration 008 refuses an active legacy vehicle without a current resident", async () => {
  const db = new PGlite();
  try {
    const migrations = migrationFiles(new URL("../database/migrations/", import.meta.url));
    for (const migration of migrations.filter(
      (file) => file.version < "007_property_occupancies.sql",
    ))
      await db.exec(migration.sql);

    const organizationId = randomUUID();
    const propertyId = randomUUID();
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Unclaimed vehicle test')", [
      organizationId,
    ]);
    await db.query(
      "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,'Unclaimed home','Former Household')",
      [propertyId, organizationId],
    );
    await db.query(
      "INSERT INTO vehicles(id,organization_id,property_id,plate,make,color) VALUES($1,$2,$3,'UNCLAIMED 1','Toyota','White')",
      [randomUUID(), organizationId, propertyId],
    );

    const occupancyMigration = migrations.find(
      (file) => file.version === "007_property_occupancies.sql",
    );
    const occupancyGuardMigration = migrations.find(
      (file) => file.version === "008_occupancy_history_guard.sql",
    );
    assert.ok(occupancyMigration);
    assert.ok(occupancyGuardMigration);
    await db.exec(occupancyMigration.sql);
    await assert.rejects(db.exec(occupancyGuardMigration.sql), /Occupancy history is ambiguous/);
  } finally {
    await db.close();
  }
});
