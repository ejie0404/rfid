import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { mkdirSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { IDS, type Configuration, type AccessEvent } from "@smartgate/contracts";
import type { Principal } from "@smartgate/permissions";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  runMigrations,
  migrationFiles,
  type MigrationDriver,
  type SqlSession,
} from "./migrations.js";
import { hashPassword } from "./crypto.js";
import { resolveDataDirectory } from "./data-directory.js";
import type { DeviceIdentity } from "./session.js";

const migrations = new URL("../../../database/migrations/", import.meta.url);
export type Result = { rows: any[] };
export type Query = (sql: string, values?: any[]) => Promise<Result>;
/** A transaction handle. Multi-statement SQL needs `exec`; parameterized SQL uses the call itself. */
export type Tx = Query & { exec: (sql: string) => Promise<void> };
type DeliveryCounts = { expected_controllers: number; acknowledged_controllers: number };
type DueMoveOut = {
  id: string;
  organization_id: string;
  property_id: string;
  occupancy_id: string;
};
type PageResult<T> = { items: T[]; next_cursor: string | null; has_more: boolean; limit: number };
type CursorPayload = { scope: string; values: string[] };
export interface StartOptions {
  test?: boolean;
  demo?: boolean;
  /** Force the embedded runtime instead of a configured server, for throwaway test state. */
  memory?: boolean;
}
/** The dedicated demonstration accounts. Their password is published and never used in real mode. */
export const DEMO_PASSWORD = "smartgate-demo-2026";
export const DEMO_ACCOUNTS = {
  admin: "admin@palmgrove.demo",
  guard: "guard@palmgrove.demo",
  resident: "resident@palmgrove.demo",
  other: "admin@cedarheights.demo",
  platform: "operator@smartgate.demo",
} as const;
const demoUserIds: Record<keyof typeof DEMO_ACCOUNTS, string> = {
  admin: "a0000000-0000-4000-8000-000000000001",
  guard: "a0000000-0000-4000-8000-000000000002",
  resident: "a0000000-0000-4000-8000-000000000003",
  other: "a0000000-0000-4000-8000-000000000004",
  platform: "a0000000-0000-4000-8000-000000000005",
};
const digestCredential = (credential: string) =>
  createHash("sha256").update(credential, "utf8").digest("hex");
const issueCredential = (prefix: "sge_" | "sgc_", bytes: number) =>
  prefix + randomBytes(bytes).toString("base64url");
type ControllerGrantInput = {
  siteId: string;
  laneIds: string[];
  name: string;
  expiresInMinutes: number;
};
export class Store {
  private memory?: PGlite;
  private pool?: Pool;
  private localMoveOutWorkerLease = false;
  private queue: Promise<unknown> = Promise.resolve();
  private demo = false;
  query!: Query;
  async start(options: StartOptions = {}) {
    this.demo = !!options.demo;
    if (process.env.DATABASE_URL && !options.memory) {
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
      this.query = async (s, v) => this.pool!.query(s, v);
    } else {
      const directory = resolveDataDirectory();
      if (!options.test) mkdirSync(directory, { recursive: true });
      this.memory = new PGlite(options.test ? undefined : directory);
      this.query = (s, v) => this.memory!.query(s, v);
    }
    // The deployable application runs with migration privileges removed, so it verifies the
    // schema instead of changing it. `npm run migrate` applies migrations with its own role.
    if (process.env.SMARTGATE_SKIP_MIGRATIONS === "true") await this.assertMigrated();
    else await this.migrate();
    if (this.demo) await this.seedDemo();
  }
  /**
   * The deployable application verifies the schema instead of changing it. The comparison is
   * against the complete migration set in this build, so a database that is missing a migration
   * (or ahead of the code) is refused at startup rather than failing later during a request.
   */
  private async assertMigrated() {
    const present = (await this.query("SELECT to_regclass('public.schema_migrations') AS name"))
      .rows[0]?.name;
    if (!present)
      throw new Error(
        "This database has no applied migrations. Run `npm run migrate` with migration credentials before starting the application.",
      );
    const recorded = (
      await this.query("SELECT version,checksum FROM schema_migrations ORDER BY version")
    ).rows as Array<{ version: string; checksum: string }>;
    const expected = migrationFiles(migrations);
    const presentVersions = new Set(recorded.map((row) => row.version));
    const missing = expected.filter((file) => !presentVersions.has(file.version));
    if (missing.length)
      throw new Error(
        "This database is missing required migrations: " +
          missing.map((file) => file.version).join(", ") +
          ". Run `npm run migrate` with migration credentials before starting the application.",
      );
    const expectedByVersion = new Map(expected.map((file) => [file.version, file.checksum]));
    const unknown = recorded.filter((row) => !expectedByVersion.has(row.version));
    if (unknown.length)
      throw new Error(
        "This database has migrations this build does not know about: " +
          unknown.map((row) => row.version).join(", ") +
          ". Deploy the matching application version.",
      );
    const changed = recorded.filter((row) => expectedByVersion.get(row.version) !== row.checksum);
    if (changed.length)
      throw new Error(
        "Applied migration checksums do not match this build: " +
          changed.map((row) => row.version).join(", ") +
          ". Restore the matching application version or add a forward migration.",
      );
  }
  /** Confirms that the database is reachable and matches every migration in this build. */
  async checkReady() {
    await this.query("SELECT 1");
    await this.assertMigrated();
  }
  async exec(sql: string) {
    if (this.memory) await this.memory.exec(sql);
    else await this.pool!.query(sql);
  }
  private async migrate() {
    const driver: MigrationDriver = {
      exec: (sql) => this.exec(sql),
      query: (sql, values) => this.query(sql, values),
      transaction: (run) =>
        this.transaction((tx) =>
          run({
            exec: tx.exec,
            query: (sql, values) => tx(sql, values),
          } satisfies SqlSession),
        ),
    };
    return runMigrations(driver, migrations);
  }
  async transaction<T>(run: (q: Tx) => Promise<T>): Promise<T> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const tx = ((sql: string, values?: any[]) => client.query(sql, values)) as unknown as Tx;
        tx.exec = async (sql: string) => {
          await client.query(sql);
        };
        const result = await run(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    const next = this.queue.then(() =>
      this.memory!.transaction(async (inner) => {
        const tx = ((sql: string, values?: any[]) => inner.query(sql, values)) as unknown as Tx;
        tx.exec = async (sql: string) => {
          await inner.exec(sql);
        };
        return run(tx);
      }),
    );
    this.queue = next.catch(() => {});
    return next;
  }
  async close() {
    await this.queue;
    await this.memory?.close();
    await this.pool?.end();
  }
  /**
   * Acquire the process-wide scheduled move-out lease for one processing pass. PostgreSQL keeps
   * this session advisory lock until the returned release callback runs or the connection closes,
   * so a second worker instance skips the same pass instead of incrementing retries concurrently.
   * Production configuration requires PostgreSQL; the local lease only coordinates workers
   * sharing this in-memory Store instance.
   */
  async acquireScheduledMoveOutWorkerLease(): Promise<(() => Promise<void>) | null> {
    if (!this.pool) {
      if (this.localMoveOutWorkerLease) return null;
      this.localMoveOutWorkerLease = true;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        this.localMoveOutWorkerLease = false;
      };
    }

    const client: PoolClient = await this.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [0x5347, 0x4d4f],
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return null;
      }

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await client.query("SELECT pg_advisory_unlock($1, $2)", [0x5347, 0x4d4f]);
        } catch (error) {
          // The session may still hold the lease. Destroying the connection ends that session, so
          // it cannot return to the pool and block later passes until the idle timeout.
          client.release(true);
          throw error;
        }
        client.release();
      };
    } catch (error) {
      // The lock state is unknown after a failed attempt, so discard the session with it.
      client.release(true);
      throw error;
    }
  }
  /**
   * Process due schedules from durable database state. Each move-out re-locks the property,
   * occupancy, and schedule and checks the expected occupancy ID, so multiple API workers and
   * process restarts safely converge on one close operation.
   */
  async processDueScheduledMoveOuts(limit = 20) {
    const due = (
      await this.query(
        `SELECT s.id,s.organization_id,s.property_id,s.occupancy_id
         FROM scheduled_move_outs s
         JOIN property_occupancies o
           ON o.id=s.occupancy_id AND o.organization_id=s.organization_id
         WHERE s.status='scheduled' AND s.effective_at<=clock_timestamp()
           AND COALESCE(s.next_attempt_at,s.effective_at)<=clock_timestamp()
           AND o.ended_at IS NULL
         ORDER BY COALESCE(s.next_attempt_at,s.effective_at),s.effective_at,s.id LIMIT $1`,
        [Math.max(1, Math.min(100, Math.floor(limit)))],
      )
    ).rows as DueMoveOut[];
    const results: Array<{
      schedule_id: string;
      status: string;
      error?: string;
      retry_at?: string;
    }> = [];
    for (const schedule of due) {
      try {
        const principal: Principal = {
          id: "system:scheduled-move-out",
          name: "Scheduled move-out processor",
          email: "system@smartgate.invalid",
          role: "hoa_admin",
          sessionId: "system:scheduled-move-out",
          organizationId: schedule.organization_id,
          membershipId: null,
          properties: [],
          sites: [],
          mfaSatisfied: true,
        };
        const result = await this.moveOut(principal, schedule.property_id, "", {
          scheduleId: schedule.id,
          expectedOccupancyId: schedule.occupancy_id,
        });
        results.push({ schedule_id: schedule.id, status: result.status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown processing error";
        const retry = await this.recordScheduledMoveOutFailure(schedule.id, message);
        results.push({
          schedule_id: schedule.id,
          status: "failed",
          error: message,
          retry_at: retry?.next_attempt_at
            ? new Date(retry.next_attempt_at).toISOString()
            : undefined,
        });
      }
    }
    return results;
  }
  private async recordScheduledMoveOutFailure(scheduleId: string, message: string) {
    try {
      return (
        await this.query(
          `UPDATE scheduled_move_outs
           SET retry_count=retry_count+1,last_attempt_at=clock_timestamp(),
               next_attempt_at=clock_timestamp()+make_interval(
                 secs=>LEAST(300,5*power(2,LEAST(retry_count,6)))),
               last_processing_error=$2,updated_at=clock_timestamp()
           WHERE id=$1 AND status='scheduled'
           RETURNING retry_count,next_attempt_at`,
          [scheduleId, message.slice(0, 1000)],
        )
      ).rows[0];
    } catch {
      return undefined;
    }
  }
  /**
   * Demonstration data only. It is created through the same identity tables the real path uses,
   * so the demonstration exercises real sessions and membership scoping rather than bypassing it.
   */
  private async seedDemo() {
    await this.transaction(async (q) => {
      await q(
        "INSERT INTO organizations(id,name) VALUES($1,'Palm Grove Village'),($2,'Cedar Heights') ON CONFLICT DO NOTHING",
        [IDS.organization, IDS.otherOrganization],
      );
      await q(
        "INSERT INTO sites(id,organization_id,name,code) VALUES($1,$2,'Main entrance','MAIN'),($3,$2,'Service gate','SERVICE'),($4,$5,'Main entrance','MAIN') ON CONFLICT DO NOTHING",
        [IDS.site, IDS.organization, IDS.serviceSite, IDS.otherSite, IDS.otherOrganization],
      );
      await q(
        "INSERT INTO lanes(id,organization_id,site_id,name,direction) VALUES($1,$2,$3,'Entry lane','entry'),($4,$2,$5,'Service entry','entry'),($6,$7,$8,'Entry lane','entry') ON CONFLICT DO NOTHING",
        [
          IDS.lane,
          IDS.organization,
          IDS.site,
          IDS.serviceLane,
          IDS.serviceSite,
          IDS.otherLane,
          IDS.otherOrganization,
          IDS.otherSite,
        ],
      );
      await q(
        "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,'Lot 12 · Acacia Street','Andrea Santos') ON CONFLICT DO NOTHING",
        [IDS.property, IDS.organization],
      );
      let occupancyId = (
        await q(
          "SELECT id FROM property_occupancies WHERE organization_id=$1 AND property_id=$2 AND ended_at IS NULL",
          [IDS.organization, IDS.property],
        )
      ).rows[0]?.id;
      if (!occupancyId) {
        occupancyId = randomUUID();
        await q(
          "INSERT INTO property_occupancies(id,organization_id,property_id,started_at,resident_name_at_start) VALUES($1,$2,$3,now(),'Andrea Santos')",
          [occupancyId, IDS.organization, IDS.property],
        );
      }
      const existing = await q("SELECT id FROM users WHERE id=$1", [demoUserIds.admin]);
      if (!existing.rows.length) {
        const password = await hashPassword(DEMO_PASSWORD);
        const accounts: [keyof typeof DEMO_ACCOUNTS, string, string | null][] = [
          ["admin", "Palm Grove administrator", null],
          ["guard", "Main gate guard", null],
          ["resident", "Andrea Santos", null],
          ["other", "Cedar Heights administrator", null],
          ["platform", "SmartGate operator", "platform_admin"],
        ];
        for (const [profile, name, platformRole] of accounts)
          await q(
            "INSERT INTO users(id,email,name,password_hash,status,platform_role) VALUES($1,$2,$3,$4,'active',$5) ON CONFLICT DO NOTHING",
            [demoUserIds[profile], DEMO_ACCOUNTS[profile], name, password, platformRole],
          );
        const memberships: [keyof typeof DEMO_ACCOUNTS, string, string][] = [
          ["admin", IDS.organization, "hoa_admin"],
          ["guard", IDS.organization, "guard"],
          ["resident", IDS.organization, "resident"],
          ["other", IDS.otherOrganization, "hoa_admin"],
        ];
        for (const [profile, organizationId, role] of memberships) {
          const row = (
            await q(
              "INSERT INTO organization_memberships(id,organization_id,user_id,role,status) VALUES($1,$2,$3,$4,'active') ON CONFLICT DO NOTHING RETURNING id",
              [randomUUID(), organizationId, demoUserIds[profile], role],
            )
          ).rows[0];
          if (!row) continue;
          if (role === "guard")
            await q(
              "INSERT INTO site_assignments(id,organization_id,site_id,membership_id) VALUES($1,$2,$3,$4)",
              [randomUUID(), organizationId, IDS.site, row.id],
            );
          if (role === "resident")
            await q(
              "INSERT INTO property_memberships(id,organization_id,property_id,membership_id,occupancy_id,relationship,is_primary_contact) VALUES($1,$2,$3,$4,$5,'owner',true)",
              [randomUUID(), organizationId, IDS.property, row.id, occupancyId],
            );
        }
      }
      const count = await q("SELECT id FROM vehicles WHERE organization_id=$1 LIMIT 1", [
        IDS.organization,
      ]);
      if (!count.rows.length) {
        const vehicle = randomUUID(),
          credential = randomUUID();
        await q(
          "INSERT INTO vehicles(id,organization_id,property_id,occupancy_id,plate,make,color) VALUES($1,$2,$3,$4,'NCR 2048','Toyota Fortuner','Pearl white')",
          [vehicle, IDS.organization, IDS.property, occupancyId],
        );
        await q(
          "INSERT INTO credentials(id,organization_id,format,value,status,valid_from) VALUES($1,$2,'epc','E2000017221101441890ABCD','active','2020-01-01T00:00:00Z')",
          [credential, IDS.organization],
        );
        await q(
          "INSERT INTO assignments(id,organization_id,credential_id,vehicle_id) VALUES($1,$2,$3,$4)",
          [randomUUID(), IDS.organization, credential, vehicle],
        );
      }
    });
  }
  demoAccount(profile: string) {
    if (!this.demo) throw new BadRequestException("Demonstration accounts are disabled.");
    const email = (DEMO_ACCOUNTS as Record<string, string>)[profile];
    if (!email) throw new BadRequestException("Unknown demonstration profile.");
    return email;
  }
  get isDemo() {
    return this.demo;
  }
  get demoPassword() {
    return DEMO_PASSWORD;
  }
  async createControllerGrant(principal: Principal, input: ControllerGrantInput) {
    const organizationId = principal.organizationId;
    if (!organizationId) throw new ForbiddenException("Select an organization first.");
    const lanes = Array.from(new Set(input.laneIds));
    if (
      !input.name.trim() ||
      input.name.trim().length > 80 ||
      lanes.length === 0 ||
      lanes.length > 64 ||
      !Number.isInteger(input.expiresInMinutes) ||
      input.expiresInMinutes < 5 ||
      input.expiresInMinutes > 60
    )
      throw new BadRequestException("Invalid controller enrollment request.");
    const id = randomUUID();
    const code = issueCredential("sge_", 24);
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);
    await this.transaction(async (q) => {
      const site = await q("SELECT id FROM sites WHERE organization_id=$1 AND id=$2", [
        organizationId,
        input.siteId,
      ]);
      if (!site.rows.length) throw new NotFoundException("Site not found.");
      const validLanes = await q(
        "SELECT id FROM lanes WHERE organization_id=$1 AND site_id=$2 AND id=ANY($3::uuid[])",
        [organizationId, input.siteId, lanes],
      );
      if (validLanes.rows.length !== lanes.length)
        throw new BadRequestException("Every lane must belong to the selected site.");
      await q(
        "INSERT INTO controller_enrollment_grants(id,organization_id,site_id,token_hash,controller_name,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          organizationId,
          input.siteId,
          digestCredential(code),
          input.name.trim(),
          principal.id,
          expiresAt.toISOString(),
        ],
      );
      for (const laneId of lanes)
        await q(
          "INSERT INTO controller_enrollment_grant_lanes(organization_id,grant_id,lane_id) VALUES($1,$2,$3)",
          [organizationId, id, laneId],
        );
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail) VALUES($1,$2,$3,'controller.enrollment_grant_created',$4,$5)",
        [
          randomUUID(),
          organizationId,
          principal.id,
          id,
          JSON.stringify({ name: input.name.trim(), site_id: input.siteId, lane_ids: lanes }),
        ],
      );
    });
    return {
      id,
      name: input.name.trim(),
      site_id: input.siteId,
      lane_ids: lanes,
      enrollment_code: code,
      expires_at: expiresAt.toISOString(),
    };
  }
  async listControllerGrants(principal: Principal) {
    const grants = (
      await this.query(
        `SELECT g.id,g.site_id,g.controller_name AS name,g.expires_at,g.consumed_at,g.revoked_at,g.created_at,
                COALESCE(array_agg(gl.lane_id::text ORDER BY gl.lane_id) FILTER(WHERE gl.lane_id IS NOT NULL),ARRAY[]::text[]) AS lane_ids
         FROM controller_enrollment_grants g
         LEFT JOIN controller_enrollment_grant_lanes gl ON gl.grant_id=g.id
         WHERE g.organization_id=$1 GROUP BY g.id ORDER BY g.created_at DESC LIMIT 100`,
        [principal.organizationId],
      )
    ).rows;
    return grants;
  }
  async revokeControllerGrant(principal: Principal, id: string) {
    await this.transaction(async (q) => {
      const result = await q(
        "UPDATE controller_enrollment_grants SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id",
        [id, principal.organizationId],
      );
      if (!result.rows.length) throw new NotFoundException("Active enrollment grant not found.");
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail) VALUES($1,$2,$3,'controller.enrollment_grant_revoked',$4,'{}'::jsonb)",
        [randomUUID(), principal.organizationId, principal.id, id],
      );
    });
    return { ok: true };
  }
  async claimController(input: {
    enrollmentCode: string;
    installationId: string;
    protocolVersion: number;
    softwareVersion?: string;
  }) {
    const code = input.enrollmentCode;
    const controllerCredential = issueCredential("sgc_", 32);
    const controllerId = randomUUID();
    return this.transaction(async (q) => {
      const grant = (
        await q("SELECT * FROM controller_enrollment_grants WHERE token_hash=$1 FOR UPDATE", [
          digestCredential(code),
        ])
      ).rows[0];
      if (
        !grant ||
        grant.consumed_at ||
        grant.revoked_at ||
        new Date(grant.expires_at).getTime() <= Date.now()
      )
        throw new ForbiddenException("Enrollment code is invalid, expired, or already used.");
      if (input.protocolVersion !== 1)
        throw new BadRequestException("Unsupported controller protocol version.");
      const lanes = (
        await q(
          "SELECT lane_id FROM controller_enrollment_grant_lanes WHERE grant_id=$1 AND organization_id=$2 ORDER BY lane_id",
          [grant.id, grant.organization_id],
        )
      ).rows.map((row) => row.lane_id as string);
      if (!lanes.length) throw new ForbiddenException("Enrollment grant has no lane scope.");
      const duplicate = await q("SELECT id FROM controllers WHERE installation_id=$1", [
        input.installationId,
      ]);
      if (duplicate.rows.length)
        throw new ForbiddenException("This installation is already enrolled.");
      await q(
        "INSERT INTO controllers(id,installation_id,organization_id,site_id,name,credential_hash,protocol_version,software_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          controllerId,
          input.installationId,
          grant.organization_id,
          grant.site_id,
          grant.controller_name,
          digestCredential(controllerCredential),
          input.protocolVersion,
          input.softwareVersion ?? null,
        ],
      );
      for (const laneId of lanes)
        await q(
          "INSERT INTO controller_lanes(organization_id,controller_id,lane_id) VALUES($1,$2,$3)",
          [grant.organization_id, controllerId, laneId],
        );
      const currentConfigVersion = Number(
        (
          await q("SELECT config_version FROM organizations WHERE id=$1 FOR SHARE", [
            grant.organization_id,
          ])
        ).rows[0].config_version,
      );
      const schedules = (
        await q(
          `SELECT s.id,s.revision,s.occupancy_id
           FROM scheduled_move_outs s
           WHERE s.organization_id=$1 AND s.status='scheduled'
             AND EXISTS (
               SELECT 1 FROM vehicles v
               JOIN assignments a ON a.vehicle_id=v.id AND a.organization_id=v.organization_id
                 AND a.ended_at IS NULL
               JOIN credentials credential
                 ON credential.id=a.credential_id AND credential.organization_id=a.organization_id
               WHERE v.organization_id=s.organization_id AND v.occupancy_id=s.occupancy_id
                 AND v.active AND EXISTS (
                   SELECT 1 FROM controller_lanes cl
                   WHERE cl.organization_id=$1 AND cl.controller_id=$2
                     AND (NOT EXISTS (
                       SELECT 1 FROM credential_lanes policy
                       WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                     ) OR EXISTS (
                       SELECT 1 FROM credential_lanes policy
                       WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                         AND policy.lane_id=cl.lane_id
                     ))
                 )
             )`,
          [grant.organization_id, controllerId],
        )
      ).rows;
      for (const schedule of schedules)
        await q(
          `INSERT INTO scheduled_move_out_controller_targets(
             organization_id,schedule_id,revision,controller_id,configuration_version
           ) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(organization_id,schedule_id,revision,controller_id)
           DO UPDATE SET configuration_version=GREATEST(
             scheduled_move_out_controller_targets.configuration_version,EXCLUDED.configuration_version
           )`,
          [
            grant.organization_id,
            schedule.id,
            schedule.revision,
            controllerId,
            currentConfigVersion,
          ],
        );
      await q("UPDATE controller_enrollment_grants SET consumed_at=now() WHERE id=$1", [grant.id]);
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail) VALUES($1,$2,$3,'controller.enrolled',$4,$5)",
        [
          randomUUID(),
          grant.organization_id,
          grant.created_by,
          controllerId,
          JSON.stringify({ site_id: grant.site_id, lane_ids: lanes }),
        ],
      );
      return {
        schema_version: 1,
        controller_id: controllerId,
        credential: controllerCredential,
        organization_id: grant.organization_id,
        site_id: grant.site_id,
        lane_ids: lanes,
        protocol_version: 1,
      };
    });
  }
  async authenticateController(credential: string): Promise<DeviceIdentity> {
    if (!/^sgc_[A-Za-z0-9_-]{43}$/.test(credential)) throw new UnauthorizedException();
    return this.transaction(async (q) => {
      const controller = (
        await q(
          "SELECT id,organization_id,site_id FROM controllers WHERE credential_hash=$1 AND status='active'",
          [digestCredential(credential)],
        )
      ).rows[0];
      if (!controller) throw new UnauthorizedException();
      const laneIds = (
        await q("SELECT lane_id FROM controller_lanes WHERE controller_id=$1 ORDER BY lane_id", [
          controller.id,
        ])
      ).rows.map((row) => row.lane_id as string);
      if (!laneIds.length) throw new UnauthorizedException();
      await q("UPDATE controllers SET last_seen_at=now(),updated_at=now() WHERE id=$1", [
        controller.id,
      ]);
      return {
        id: controller.id,
        organizationId: controller.organization_id,
        siteId: controller.site_id,
        laneIds,
      };
    });
  }
  async listControllers(principal: Principal) {
    return (
      await this.query(
        `SELECT c.id,c.site_id,c.name,c.status,c.protocol_version,c.software_version,c.hardware_mode,c.config_version,c.pending_events,
                c.last_seen_at,c.last_reported_at,c.created_at,
                COALESCE(array_agg(cl.lane_id::text ORDER BY cl.lane_id) FILTER(WHERE cl.lane_id IS NOT NULL),ARRAY[]::text[]) AS lane_ids
         FROM controllers c LEFT JOIN controller_lanes cl ON cl.controller_id=c.id
         WHERE c.organization_id=$1 GROUP BY c.id ORDER BY c.created_at DESC`,
        [principal.organizationId],
      )
    ).rows;
  }
  async revokeController(principal: Principal, id: string, reason = "") {
    await this.transaction(async (q) => {
      const updated = await q(
        "UPDATE controllers SET status='revoked',updated_at=now() WHERE id=$1 AND organization_id=$2 AND status='active' RETURNING id",
        [id, principal.organizationId],
      );
      if (!updated.rows.length) throw new NotFoundException("Active controller not found.");
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail) VALUES($1,$2,$3,'controller.revoked',$4,$5)",
        [randomUUID(), principal.organizationId, principal.id, id, JSON.stringify({ reason })],
      );
    });
    return { ok: true };
  }
  async rotateControllerCredential(principal: Principal, id: string) {
    const credential = issueCredential("sgc_", 32);
    await this.transaction(async (q) => {
      const result = await q(
        "UPDATE controllers SET credential_hash=$1,updated_at=now() WHERE id=$2 AND organization_id=$3 AND status='active' RETURNING id",
        [digestCredential(credential), id, principal.organizationId],
      );
      if (!result.rows.length) throw new NotFoundException("Active controller not found.");
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail) VALUES($1,$2,$3,'controller.credential_rotated',$4,'{}'::jsonb)",
        [randomUUID(), principal.organizationId, principal.id, id],
      );
    });
    return { controller_id: id, credential };
  }
  private pageScope(p: Principal, filters: Record<string, unknown>) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          organization_id: p.organizationId,
          actor_id: p.id,
          role: p.role,
          ...filters,
        }),
      )
      .digest("hex");
  }

  private readPageCursor(
    cursor: string | undefined,
    scope: string,
    count: number,
  ): string[] | null {
    if (!cursor) return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
      if (
        parsed.scope !== scope ||
        !Array.isArray(parsed.values) ||
        parsed.values.length !== count ||
        parsed.values.some((value) => typeof value !== "string")
      )
        throw new Error("scope");
      return parsed.values;
    } catch {
      throw new BadRequestException("This page cursor is invalid or belongs to different filters.");
    }
  }

  private createPage<T extends { __cursor_values: string[] }>(
    rows: T[],
    limit: number,
    scope: string,
  ): PageResult<Omit<T, "__cursor_values">> {
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(({ __cursor_values: _cursor, ...item }) => item),
      next_cursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ scope, values: last.__cursor_values }), "utf8").toString(
              "base64url",
            )
          : null,
      has_more: hasMore,
      limit,
    };
  }

  private checkedPageLimit(input?: number) {
    const limit = input ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException("Page size must be between 1 and 100.");
    return limit;
  }

  async pageHouseholds(
    p: Principal,
    filters: { search?: string; cursor?: string; limit?: number } = {},
  ): Promise<PageResult<any>> {
    if (!p.organizationId || !(p.role === "hoa_admin" || p.role === "resident" || p.supportGrantId))
      throw new ForbiddenException("Household access is not available to this role.");
    const limit = this.checkedPageLimit(filters.limit);
    const search = (filters.search ?? "").trim().slice(0, 120).toLocaleLowerCase();
    const scope = this.pageScope(p, { kind: "households", search });
    const cursor = this.readPageCursor(filters.cursor, scope, 2);
    const values: any[] = [p.organizationId];
    const clauses = ["p.organization_id=$1"];
    if (p.role === "resident") {
      values.push(p.properties);
      clauses.push(`p.id=ANY($${values.length}::uuid[])`);
    }
    if (search) {
      values.push(search);
      clauses.push(
        `(lower(p.label) LIKE $${values.length} || '%' OR lower(p.resident_name) LIKE $${values.length} || '%')`,
      );
    }
    if (cursor) {
      values.push(cursor[0], cursor[1]);
      clauses.push(`(lower(p.label),p.id)>($${values.length - 1},$${values.length}::uuid)`);
    }
    values.push(limit + 1);
    const rows = (
      await this.query(
        `SELECT p.id,p.label,p.resident_name,o.id AS occupancy_id,o.started_at AS occupancy_started_at,
                s.id AS scheduled_move_out_id,s.effective_at AS scheduled_move_out_at,
                s.revision AS scheduled_move_out_revision,
                (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
                 JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                 WHERE t.organization_id=s.organization_id AND t.schedule_id=s.id
                   AND t.revision=s.revision AND c.status='active') AS scheduled_expected_controllers,
                (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
                 JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                 WHERE t.organization_id=s.organization_id AND t.schedule_id=s.id
                   AND t.revision=s.revision AND c.status='active'
                   AND c.config_version>=t.configuration_version) AS scheduled_acknowledged_controllers,
                ARRAY[lower(p.label),p.id::text] AS __cursor_values
         FROM properties p
         LEFT JOIN property_occupancies o
           ON o.organization_id=p.organization_id AND o.property_id=p.id AND o.ended_at IS NULL
         LEFT JOIN scheduled_move_outs s
           ON s.organization_id=o.organization_id AND s.occupancy_id=o.id AND s.status='scheduled'
         WHERE ${clauses.join(" AND ")}
         ORDER BY lower(p.label),p.id LIMIT $${values.length}`,
        values,
      )
    ).rows;
    return this.createPage(rows, limit, scope);
  }

  async pageHouseholdMembers(
    p: Principal,
    propertyId: string,
    filters: { cursor?: string; limit?: number; status?: "active" | "ended" } = {},
  ): Promise<PageResult<any>> {
    if (!p.organizationId || (p.role !== "hoa_admin" && !p.supportGrantId))
      throw new ForbiddenException("Village administrator permission is required.");
    const limit = this.checkedPageLimit(filters.limit);
    const scope = this.pageScope(p, {
      kind: "household_members",
      property_id: propertyId,
      status: filters.status ?? "all",
    });
    const cursor = this.readPageCursor(filters.cursor, scope, 3);
    const values: any[] = [p.organizationId, propertyId];
    const clauses = ["pm.organization_id=$1", "pm.property_id=$2"];
    if (filters.status === "active") clauses.push("pm.ended_at IS NULL");
    if (filters.status === "ended") clauses.push("pm.ended_at IS NOT NULL");
    if (cursor) {
      values.push(cursor[0], cursor[1], cursor[2]);
      const ended = "(pm.ended_at IS NOT NULL)";
      clauses.push(
        `(${ended}>$${values.length - 2}::boolean OR (${ended}=$${values.length - 2}::boolean AND (pm.started_at,pm.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)))`,
      );
    }
    values.push(limit + 1);
    const rows = (
      await this.query(
        `SELECT pm.id,pm.property_id,pm.occupancy_id,pm.relationship,
                pm.is_primary_contact,pm.started_at,pm.ended_at,
                u.name,u.email,m.status AS membership_status,
                ARRAY[(pm.ended_at IS NOT NULL)::text,pm.started_at::text,pm.id::text] AS __cursor_values
         FROM property_memberships pm
         JOIN organization_memberships m ON m.id=pm.membership_id
         JOIN users u ON u.id=m.user_id
         WHERE ${clauses.join(" AND ")}
          ORDER BY (pm.ended_at IS NOT NULL) ASC,pm.started_at DESC,pm.id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    return this.createPage(rows, limit, scope);
  }

  async pageOccupancies(
    p: Principal,
    filters: {
      propertyId?: string;
      status?: "active" | "ended";
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<PageResult<any>> {
    if (!p.organizationId || (p.role !== "hoa_admin" && !p.supportGrantId))
      throw new ForbiddenException("Village administrator permission is required.");
    const limit = this.checkedPageLimit(filters.limit);
    const scope = this.pageScope(p, {
      kind: "occupancies",
      property_id: filters.propertyId ?? "",
      status: filters.status ?? "all",
    });
    const cursor = this.readPageCursor(filters.cursor, scope, 2);
    const values: any[] = [p.organizationId];
    const clauses = ["o.organization_id=$1"];
    if (filters.propertyId) {
      values.push(filters.propertyId);
      clauses.push(`o.property_id=$${values.length}`);
    }
    if (filters.status === "active") clauses.push("o.ended_at IS NULL");
    if (filters.status === "ended") clauses.push("o.ended_at IS NOT NULL");
    if (cursor) {
      values.push(cursor[0], cursor[1]);
      clauses.push(
        `(o.started_at,o.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const rows = (
      await this.query(
        `SELECT o.id,o.property_id,o.started_at,o.ended_at,o.end_reason,o.required_config_version,
                p.label AS property_label,o.resident_name_at_start AS resident_name,
                COALESCE((SELECT array_agg(DISTINCT u.name ORDER BY u.name)
                          FROM property_memberships pm JOIN organization_memberships m ON m.id=pm.membership_id
                          JOIN users u ON u.id=m.user_id WHERE pm.occupancy_id=o.id),ARRAY[]::text[]) AS occupant_names,
                (SELECT count(*)::int FROM occupancy_controller_targets t
                 JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                 WHERE t.organization_id=o.organization_id AND t.occupancy_id=o.id AND c.status='active') AS expected_controllers,
                (SELECT count(*)::int FROM occupancy_controller_targets t
                 JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                 WHERE t.organization_id=o.organization_id AND t.occupancy_id=o.id AND c.status='active'
                   AND o.required_config_version IS NOT NULL AND c.config_version>=o.required_config_version) AS acknowledged_controllers,
                ARRAY[o.started_at::text,o.id::text] AS __cursor_values
         FROM property_occupancies o
         JOIN properties p ON p.id=o.property_id AND p.organization_id=o.organization_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY o.started_at DESC,o.id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    return this.createPage(rows, limit, scope);
  }

  async pageLifecycleRequests(
    p: Principal,
    filters: {
      kind: "vehicle_changes" | "credential_replacements" | "vehicle_retirements" | "move_outs";
      status?: string;
      propertyId?: string;
      search?: string;
      cursor?: string;
      limit?: number;
    },
  ): Promise<PageResult<any>> {
    if (!p.organizationId || !(p.role === "hoa_admin" || p.role === "resident" || p.supportGrantId))
      throw new ForbiddenException("Lifecycle records are not available to this role.");
    const specs = {
      vehicle_changes: {
        table: "vehicle_change_requests",
        time: "r.created_at",
        search: (param: string) =>
          `(lower(r.prior_plate) LIKE ${param} || '%' OR lower(r.proposed_plate) LIKE ${param} || '%' OR lower(r.proposed_make) LIKE ${param} || '%' OR lower(r.proposed_color) LIKE ${param} || '%' OR lower(p.label) LIKE ${param} || '%' OR lower(p.resident_name) LIKE ${param} || '%')`,
        select: `r.*,p.label AS property_label,p.resident_name,v.plate AS current_plate,
          (SELECT count(*)::int FROM vehicle_change_controller_targets t
           JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
           WHERE t.organization_id=r.organization_id AND t.request_id=r.id AND c.status='active') AS expected_controllers,
          (SELECT count(*)::int FROM vehicle_change_controller_targets t
           JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
           WHERE t.organization_id=r.organization_id AND t.request_id=r.id AND c.status='active'
             AND r.required_config_version IS NOT NULL AND c.config_version>=r.required_config_version) AS acknowledged_controllers`,
        join: "JOIN vehicles v ON v.id=r.vehicle_id AND v.organization_id=r.organization_id JOIN properties p ON p.id=r.property_id AND p.organization_id=r.organization_id",
        occupancy: "r.occupancy_id",
        statuses: ["pending", "approved", "rejected", "cancelled"],
      },
      credential_replacements: {
        table: "credential_replacement_requests",
        time: "r.created_at",
        search: (param: string) =>
          `(lower(v.plate) LIKE ${param} || '%' OR lower(v.make) LIKE ${param} || '%' OR lower(p.label) LIKE ${param} || '%' OR lower(p.resident_name) LIKE ${param} || '%')`,
        select: `r.*,p.label AS property_label,p.resident_name,v.plate,v.make,v.occupancy_id,
          (SELECT count(*)::int FROM controllers c WHERE c.organization_id=r.organization_id
           AND c.status='active' AND (NOT EXISTS (SELECT 1 FROM credential_lanes policy
             WHERE policy.organization_id=r.organization_id AND policy.credential_id=r.credential_id)
             OR EXISTS (SELECT 1 FROM credential_lanes policy JOIN controller_lanes assigned
               ON assigned.organization_id=policy.organization_id AND assigned.lane_id=policy.lane_id
               WHERE policy.organization_id=r.organization_id AND policy.credential_id=r.credential_id
                 AND assigned.controller_id=c.id))) AS expected_controllers,
          (SELECT count(*)::int FROM controllers c WHERE c.organization_id=r.organization_id
           AND c.status='active' AND c.config_version>=r.required_config_version
           AND (NOT EXISTS (SELECT 1 FROM credential_lanes policy
             WHERE policy.organization_id=r.organization_id AND policy.credential_id=r.credential_id)
             OR EXISTS (SELECT 1 FROM credential_lanes policy JOIN controller_lanes assigned
               ON assigned.organization_id=policy.organization_id AND assigned.lane_id=policy.lane_id
               WHERE policy.organization_id=r.organization_id AND policy.credential_id=r.credential_id
                 AND assigned.controller_id=c.id))) AS acknowledged_controllers`,
        join: "JOIN vehicles v ON v.id=r.vehicle_id AND v.organization_id=r.organization_id JOIN properties p ON p.id=r.property_id AND p.organization_id=r.organization_id",
        occupancy: "v.occupancy_id",
        statuses: ["pending", "issued", "rejected"],
      },
      vehicle_retirements: {
        table: "vehicle_retirement_requests",
        time: "r.created_at",
        search: (param: string) =>
          `(lower(v.plate) LIKE ${param} || '%' OR lower(v.make) LIKE ${param} || '%' OR lower(p.label) LIKE ${param} || '%' OR lower(p.resident_name) LIKE ${param} || '%' OR lower(r.reason) LIKE ${param} || '%')`,
        select: `r.*,p.label AS property_label,p.resident_name,v.plate,v.make,v.color,
          (SELECT count(*)::int FROM vehicle_retirement_controller_targets t
           JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
           WHERE t.organization_id=r.organization_id AND t.request_id=r.id AND c.status='active') AS expected_controllers,
          (SELECT count(*)::int FROM vehicle_retirement_controller_targets t
           JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
           WHERE t.organization_id=r.organization_id AND t.request_id=r.id AND c.status='active'
             AND r.required_config_version IS NOT NULL AND c.config_version>=r.required_config_version) AS acknowledged_controllers`,
        join: "JOIN vehicles v ON v.id=r.vehicle_id AND v.organization_id=r.organization_id JOIN properties p ON p.id=r.property_id AND p.organization_id=r.organization_id",
        occupancy: "r.occupancy_id",
        statuses: ["pending", "approved", "rejected", "cancelled"],
      },
      move_outs: {
        table: "scheduled_move_outs",
        time: "r.created_at",
        search: (param: string) =>
          `(lower(p.label) LIKE ${param} || '%' OR lower(o.resident_name_at_start) LIKE ${param} || '%' OR lower(r.reason) LIKE ${param} || '%')`,
        select: `r.*,p.label AS property_label,o.resident_name_at_start AS resident_name,
          (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
           JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
           WHERE t.organization_id=r.organization_id AND t.schedule_id=r.id
             AND t.revision=r.revision AND c.status='active') AS expected_controllers,
          (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
           JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
           WHERE t.organization_id=r.organization_id AND t.schedule_id=r.id
             AND t.revision=r.revision AND c.status='active'
             AND c.config_version>=t.configuration_version) AS acknowledged_controllers`,
        join: "JOIN properties p ON p.id=r.property_id AND p.organization_id=r.organization_id JOIN property_occupancies o ON o.id=r.occupancy_id AND o.organization_id=r.organization_id",
        occupancy: "r.occupancy_id",
        statuses: ["scheduled", "completed", "cancelled"],
      },
    } as const;
    const spec = specs[filters.kind];
    if (!spec) throw new BadRequestException("Choose a supported lifecycle record type.");
    const statusFilter =
      filters.kind === "move_outs" && filters.status === "pending" ? "scheduled" : filters.status;
    if (
      statusFilter &&
      statusFilter !== "resolved" &&
      !spec.statuses.includes(statusFilter as never)
    )
      throw new BadRequestException("That status is not valid for this record type.");
    const limit = this.checkedPageLimit(filters.limit);
    const search = (filters.search ?? "").trim().slice(0, 120).toLocaleLowerCase();
    const propertyId = filters.propertyId ?? "";
    if (p.role === "resident" && propertyId && !p.properties.includes(propertyId))
      throw new NotFoundException("Lifecycle records not found.");
    const scope = this.pageScope(p, {
      kind: filters.kind,
      status: statusFilter ?? "all",
      property_id: propertyId,
      search,
    });
    const cursor = this.readPageCursor(filters.cursor, scope, 2);
    const values: any[] = [p.organizationId];
    const clauses = ["r.organization_id=$1"];
    if (statusFilter === "resolved") {
      clauses.push(filters.kind === "move_outs" ? "r.status<>'scheduled'" : "r.status<>'pending'");
    } else if (statusFilter) {
      values.push(statusFilter);
      clauses.push(`r.status=$${values.length}`);
    }
    if (propertyId) {
      values.push(propertyId);
      clauses.push(`r.property_id=$${values.length}`);
    }
    if (p.role === "resident") {
      values.push(p.properties);
      const propertyArg = `$${values.length}::uuid[]`;
      values.push(p.membershipId);
      clauses.push(
        `r.property_id=ANY(${propertyArg}) AND EXISTS (
           SELECT 1 FROM property_memberships pm
           WHERE pm.organization_id=r.organization_id AND pm.occupancy_id=${spec.occupancy}
             AND pm.membership_id=$${values.length} AND pm.ended_at IS NULL
         )`,
      );
    }
    if (search) {
      values.push(search);
      clauses.push(spec.search(`$${values.length}`));
    }
    if (cursor) {
      values.push(cursor[0], cursor[1]);
      clauses.push(
        `(${spec.time},r.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const rows = (
      await this.query(
        `SELECT ${spec.select},ARRAY[${spec.time}::text,r.id::text] AS __cursor_values
         FROM ${spec.table} r ${spec.join}
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${spec.time} DESC,r.id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    return this.createPage(rows, limit, scope);
  }

  async snapshot(p: Principal) {
    if (!p.organizationId)
      throw new ForbiddenException("Select an organization before reading this data.");
    const resident = p.role === "resident";
    const guard = p.role === "guard";
    // A guard's view is the station they are on duty at. With no active assignment there is
    // nothing to show, so this fails closed rather than falling back to the whole village.
    if (guard && !p.sites.length)
      throw new ForbiddenException(
        "You are not assigned to a station. Ask an administrator to assign one.",
      );
    // A resident is restricted to the households they hold a membership for.
    const residentScope = resident
      ? ` AND v.property_id = ANY($2) AND v.active
          AND EXISTS (SELECT 1 FROM property_memberships pm
                      WHERE pm.organization_id=v.organization_id
                        AND pm.property_id=v.property_id
                        AND pm.occupancy_id=v.occupancy_id
                        AND pm.membership_id=$3 AND pm.ended_at IS NULL)`
      : "";
    const args = resident ? [p.organizationId, p.properties] : [p.organizationId];
    const vehicles = resident
      ? (
          await this.query(
            `SELECT v.*, p.label AS property_label,p.resident_name,c.id AS credential_id,c.value AS credential_value,c.format,c.status AS credential_status
   FROM vehicles v JOIN properties p ON p.id=v.property_id AND p.organization_id=v.organization_id
   LEFT JOIN assignments a ON a.vehicle_id=v.id AND a.organization_id=v.organization_id AND a.ended_at IS NULL
   LEFT JOIN credentials c ON c.id=a.credential_id AND c.organization_id=v.organization_id
   WHERE v.organization_id=$1${residentScope} ORDER BY v.plate`,
            [p.organizationId, p.properties, p.membershipId],
          )
        ).rows
      : guard
        ? // The station's lookup set: vehicles whose credential is valid at one of its lanes. A
          // credential with no recorded policy is authorized everywhere and therefore appears. No
          // household data and no raw tag value is sent, because a guard does not need either.
          (
            await this.query(
              `SELECT v.id, v.plate, v.make, v.color, c.format, c.status AS credential_status
               FROM vehicles v
               JOIN assignments a ON a.vehicle_id=v.id AND a.organization_id=v.organization_id AND a.ended_at IS NULL
               JOIN credentials c ON c.id=a.credential_id AND c.organization_id=v.organization_id
               WHERE v.organization_id=$1
                 AND v.active
                 AND (NOT EXISTS (SELECT 1 FROM credential_lanes cl WHERE cl.credential_id=c.id)
                      OR EXISTS (SELECT 1 FROM credential_lanes cl JOIN lanes l ON l.id=cl.lane_id
                                 WHERE cl.credential_id=c.id AND l.site_id = ANY($2)))
               ORDER BY v.plate`,
              [p.organizationId, p.sites],
            )
          ).rows
        : (
            await this.query(
              `SELECT v.*, p.label AS property_label,p.resident_name,c.id AS credential_id,c.value AS credential_value,c.format,c.status AS credential_status
   FROM vehicles v JOIN properties p ON p.id=v.property_id AND p.organization_id=v.organization_id
   LEFT JOIN assignments a ON a.vehicle_id=v.id AND a.organization_id=v.organization_id AND a.ended_at IS NULL
   LEFT JOIN credentials c ON c.id=a.credential_id AND c.organization_id=v.organization_id
   WHERE v.organization_id=$1 AND v.active ORDER BY v.plate`,
              [p.organizationId],
            )
          ).rows;
    const events = resident
      ? (
          await this.query(
            `SELECT e.payload FROM access_events e
             JOIN vehicles v ON v.id=e.vehicle_id AND v.organization_id=e.organization_id
             WHERE e.organization_id=$1 AND v.property_id=ANY($2)
               AND EXISTS (SELECT 1 FROM property_memberships pm
                           WHERE pm.occupancy_id=v.occupancy_id
                             AND pm.membership_id=$3 AND pm.ended_at IS NULL)
             ORDER BY e.received_at DESC LIMIT 100`,
            [p.organizationId, p.properties, p.membershipId],
          )
        ).rows
      : guard
        ? // Only activity observed at a lane belonging to an assigned station.
          (
            await this.query(
              `SELECT e.payload FROM access_events e
               WHERE e.organization_id=$1
                 AND e.payload->>'lane_id' IN (SELECT id::text FROM lanes WHERE site_id = ANY($2))
               ORDER BY e.received_at DESC LIMIT 100`,
              [p.organizationId, p.sites],
            )
          ).rows
        : (
            await this.query(
              "SELECT payload FROM access_events WHERE organization_id=$1 ORDER BY received_at DESC LIMIT 100",
              [p.organizationId],
            )
          ).rows;
    const organization = (
      await this.query("SELECT id,name,config_version FROM organizations WHERE id=$1", [
        p.organizationId,
      ])
    ).rows[0];
    const heartbeats =
      resident || guard
        ? []
        : (
            await this.query(
              "SELECT payload,received_at FROM edge_heartbeats WHERE organization_id=$1",
              [p.organizationId],
            )
          ).rows;
    // Household records are administrative data. A guard identifies vehicles at the gate; it does
    // not receive the village's household roster.
    const properties = resident
      ? (
          await this.query(
            `SELECT p.id,p.label,p.resident_name,o.id AS occupancy_id,o.started_at AS occupancy_started_at,
                    s.id AS scheduled_move_out_id,s.effective_at AS scheduled_move_out_at,
                    s.revision AS scheduled_move_out_revision,
                    (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
                     JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                     WHERE t.organization_id=s.organization_id AND t.schedule_id=s.id
                       AND t.revision=s.revision AND c.status='active') AS scheduled_expected_controllers,
                    (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
                     JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                     WHERE t.organization_id=s.organization_id AND t.schedule_id=s.id
                       AND t.revision=s.revision AND c.status='active'
                       AND c.config_version>=t.configuration_version) AS scheduled_acknowledged_controllers
             FROM properties p
             LEFT JOIN property_occupancies o
               ON o.organization_id=p.organization_id AND o.property_id=p.id AND o.ended_at IS NULL
             LEFT JOIN scheduled_move_outs s
               ON s.organization_id=o.organization_id AND s.occupancy_id=o.id AND s.status='scheduled'
             WHERE p.organization_id=$1 AND p.id = ANY($2) ORDER BY p.label`,
            args,
          )
        ).rows
      : guard
        ? []
        : (
            await this.query(
              `SELECT p.id,p.label,p.resident_name,o.id AS occupancy_id,o.started_at AS occupancy_started_at,
                      s.id AS scheduled_move_out_id,s.effective_at AS scheduled_move_out_at,
                      s.revision AS scheduled_move_out_revision,
                      (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
                       JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                       WHERE t.organization_id=s.organization_id AND t.schedule_id=s.id
                         AND t.revision=s.revision AND c.status='active') AS scheduled_expected_controllers,
                      (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
                       JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                       WHERE t.organization_id=s.organization_id AND t.schedule_id=s.id
                         AND t.revision=s.revision AND c.status='active'
                         AND c.config_version>=t.configuration_version) AS scheduled_acknowledged_controllers
               FROM properties p
               LEFT JOIN property_occupancies o
                 ON o.organization_id=p.organization_id AND o.property_id=p.id AND o.ended_at IS NULL
               LEFT JOIN scheduled_move_outs s
                 ON s.organization_id=o.organization_id AND s.occupancy_id=o.id AND s.status='scheduled'
               WHERE p.organization_id=$1 ORDER BY p.label`,
              [p.organizationId],
            )
          ).rows;
    const organizationSites = (
      await this.query("SELECT id,name,code FROM sites WHERE organization_id=$1 ORDER BY name", [
        p.organizationId,
      ])
    ).rows;
    // A guard sees only the station they are assigned to, never the whole estate.
    const sites = guard
      ? organizationSites.filter((site) => p.sites.includes(site.id))
      : organizationSites;
    const organizationLanes = (
      await this.query(
        "SELECT id,name,site_id,direction FROM lanes WHERE organization_id=$1 ORDER BY name",
        [p.organizationId],
      )
    ).rows;
    const visibleSites = new Set(sites.map((site) => site.id));
    const lanes = organizationLanes.filter((lane) => visibleSites.has(lane.site_id));
    const credentialRequests = guard
      ? []
      : (
          await this.query(
            `SELECT r.id,r.property_id,r.vehicle_id,r.credential_id,r.status,r.created_at,
                    r.resolved_at,r.required_config_version,r.decision_note,
                    v.plate,v.make,p.label AS property_label,p.resident_name,
                    (SELECT count(*)::int FROM controllers c
                     WHERE c.organization_id=r.organization_id AND c.status='active'
                       AND (NOT EXISTS (
                              SELECT 1 FROM credential_lanes policy
                              WHERE policy.organization_id=r.organization_id
                                AND policy.credential_id=r.credential_id
                            ) OR EXISTS (
                              SELECT 1 FROM credential_lanes policy
                              JOIN controller_lanes assigned
                                ON assigned.organization_id=policy.organization_id
                               AND assigned.lane_id=policy.lane_id
                              WHERE policy.organization_id=r.organization_id
                                AND policy.credential_id=r.credential_id
                                AND assigned.controller_id=c.id
                            ))) AS expected_controllers,
                    (SELECT count(*)::int FROM controllers c
                     WHERE c.organization_id=r.organization_id AND c.status='active'
                       AND c.config_version>=r.required_config_version
                       AND (NOT EXISTS (
                              SELECT 1 FROM credential_lanes policy
                              WHERE policy.organization_id=r.organization_id
                                AND policy.credential_id=r.credential_id
                            ) OR EXISTS (
                              SELECT 1 FROM credential_lanes policy
                              JOIN controller_lanes assigned
                                ON assigned.organization_id=policy.organization_id
                               AND assigned.lane_id=policy.lane_id
                              WHERE policy.organization_id=r.organization_id
                                AND policy.credential_id=r.credential_id
                                AND assigned.controller_id=c.id
                            ))) AS acknowledged_controllers
             FROM credential_replacement_requests r
             JOIN vehicles v ON v.id=r.vehicle_id AND v.organization_id=r.organization_id
             JOIN properties p ON p.id=r.property_id AND p.organization_id=r.organization_id
             WHERE r.organization_id=$1${resident ? " AND r.property_id = ANY($2) AND EXISTS (SELECT 1 FROM property_memberships pm WHERE pm.membership_id=$3 AND pm.occupancy_id=v.occupancy_id AND pm.ended_at IS NULL)" : ""}
             ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC LIMIT 100`,
            resident ? [p.organizationId, p.properties, p.membershipId] : args,
          )
        ).rows;
    const occupancies =
      resident || guard
        ? []
        : (
            await this.query(
              `SELECT o.id,o.property_id,o.started_at,o.ended_at,o.end_reason,o.required_config_version,
                    p.label AS property_label,o.resident_name_at_start AS resident_name,
                    COALESCE((SELECT array_agg(DISTINCT u.name ORDER BY u.name)
                              FROM property_memberships pm
                              JOIN organization_memberships m ON m.id=pm.membership_id
                              JOIN users u ON u.id=m.user_id
                              WHERE pm.occupancy_id=o.id),ARRAY[]::text[]) AS occupant_names,
                    (SELECT count(*)::int FROM occupancy_controller_targets t
                     JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                     WHERE t.organization_id=o.organization_id AND t.occupancy_id=o.id
                       AND c.status='active') AS expected_controllers,
                    (SELECT count(*)::int FROM occupancy_controller_targets t
                     JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                     WHERE t.organization_id=o.organization_id AND t.occupancy_id=o.id
                       AND c.status='active' AND o.required_config_version IS NOT NULL
                       AND c.config_version>=o.required_config_version) AS acknowledged_controllers
             FROM property_occupancies o
             JOIN properties p ON p.id=o.property_id AND p.organization_id=o.organization_id
             WHERE o.organization_id=$1
             ORDER BY o.started_at DESC LIMIT 200`,
              [p.organizationId],
            )
          ).rows;
    const propertyMembers =
      p.role !== "hoa_admin"
        ? []
        : (
            await this.query(
              `SELECT pm.id,pm.property_id,pm.occupancy_id,pm.relationship,
                      pm.is_primary_contact,pm.started_at,pm.ended_at,
                      u.name,u.email,m.status AS membership_status
               FROM property_memberships pm
               JOIN organization_memberships m ON m.id=pm.membership_id
               JOIN users u ON u.id=m.user_id
               WHERE pm.organization_id=$1
               ORDER BY pm.ended_at NULLS FIRST,pm.started_at DESC LIMIT 300`,
              [p.organizationId],
            )
          ).rows;
    const vehicleChanges =
      guard || (p.role !== "hoa_admin" && !resident)
        ? []
        : (
            await this.query(
              `SELECT r.id,r.property_id,r.occupancy_id,r.vehicle_id,r.requested_by,
                      r.prior_plate,r.prior_make,r.prior_color,
                      r.proposed_plate,r.proposed_make,r.proposed_color,
                      r.status,r.decision_note,r.required_config_version,
                      r.created_at,r.resolved_at,p.label AS property_label,
                      (SELECT count(*)::int FROM vehicle_change_controller_targets t
                       JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                       WHERE t.organization_id=r.organization_id AND t.request_id=r.id
                         AND c.status='active') AS expected_controllers,
                      (SELECT count(*)::int FROM vehicle_change_controller_targets t
                       JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                       WHERE t.organization_id=r.organization_id AND t.request_id=r.id
                         AND c.status='active' AND r.required_config_version IS NOT NULL
                         AND c.config_version>=r.required_config_version) AS acknowledged_controllers
               FROM vehicle_change_requests r
               JOIN properties p ON p.id=r.property_id AND p.organization_id=r.organization_id
               WHERE r.organization_id=$1${resident ? " AND r.property_id=ANY($2) AND EXISTS (SELECT 1 FROM property_memberships pm WHERE pm.organization_id=r.organization_id AND pm.occupancy_id=r.occupancy_id AND pm.membership_id=$3 AND pm.ended_at IS NULL)" : ""}
               ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,
                        r.created_at DESC LIMIT 100`,
              resident ? [p.organizationId, p.properties, p.membershipId] : [p.organizationId],
            )
          ).rows;
    const vehicleRetirementRequests =
      guard || (p.role !== "hoa_admin" && !resident)
        ? []
        : (
            await this.query(
              `SELECT r.id,r.property_id,r.occupancy_id,r.vehicle_id,r.requested_by,r.source,
                      r.reason,r.status,r.decision_note,r.required_config_version,
                      r.created_at,r.resolved_at,v.plate,v.make,p.label AS property_label,
                      (SELECT count(*)::int FROM vehicle_retirement_controller_targets t
                       JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                       WHERE t.organization_id=r.organization_id AND t.request_id=r.id
                         AND c.status='active') AS expected_controllers,
                      (SELECT count(*)::int FROM vehicle_retirement_controller_targets t
                       JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                       WHERE t.organization_id=r.organization_id AND t.request_id=r.id
                         AND c.status='active' AND r.required_config_version IS NOT NULL
                         AND c.config_version>=r.required_config_version) AS acknowledged_controllers
               FROM vehicle_retirement_requests r
               JOIN vehicles v ON v.id=r.vehicle_id AND v.organization_id=r.organization_id
               JOIN properties p ON p.id=r.property_id AND p.organization_id=r.organization_id
               WHERE r.organization_id=$1${resident ? " AND r.property_id=ANY($2) AND EXISTS (SELECT 1 FROM property_memberships pm WHERE pm.organization_id=r.organization_id AND pm.occupancy_id=r.occupancy_id AND pm.membership_id=$3 AND pm.ended_at IS NULL)" : ""}
               ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,
                        r.created_at DESC,r.id DESC LIMIT 100`,
              resident ? [p.organizationId, p.properties, p.membershipId] : [p.organizationId],
            )
          ).rows;
    const scheduledMoveOuts =
      guard || (p.role !== "hoa_admin" && !resident)
        ? []
        : (
            await this.query(
              `SELECT s.id,s.property_id,s.occupancy_id,s.requested_by,s.reason,s.effective_at,
                      s.retry_count,s.last_attempt_at,s.next_attempt_at,s.last_processing_error,
                      s.revision,s.configuration_version,s.status,s.created_at,s.updated_at,
                      s.completed_at,s.cancelled_at,p.label AS property_label,
                      o.resident_name_at_start AS resident_name,
                      (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
                       JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                       WHERE t.organization_id=s.organization_id AND t.schedule_id=s.id
                         AND t.revision=s.revision AND c.status='active') AS expected_controllers,
                      (SELECT count(*)::int FROM scheduled_move_out_controller_targets t
                       JOIN controllers c ON c.id=t.controller_id AND c.organization_id=t.organization_id
                       WHERE t.organization_id=s.organization_id AND t.schedule_id=s.id
                         AND t.revision=s.revision AND c.status='active'
                         AND c.config_version>=t.configuration_version) AS acknowledged_controllers
               FROM scheduled_move_outs s
               JOIN property_occupancies o ON o.id=s.occupancy_id AND o.organization_id=s.organization_id
               JOIN properties p ON p.id=s.property_id AND p.organization_id=s.organization_id
               WHERE s.organization_id=$1${resident ? " AND s.property_id=ANY($2) AND EXISTS (SELECT 1 FROM property_memberships pm WHERE pm.organization_id=s.organization_id AND pm.occupancy_id=s.occupancy_id AND pm.membership_id=$3 AND pm.ended_at IS NULL)" : ""}
               ORDER BY CASE WHEN s.status='scheduled' THEN 0 ELSE 1 END,
                        s.effective_at DESC,s.id DESC LIMIT 100`,
              resident ? [p.organizationId, p.properties, p.membershipId] : [p.organizationId],
            )
          ).rows;
    return {
      organization,
      principal: p,
      vehicles,
      events: events.map((r) => r.payload),
      credential_requests: credentialRequests,
      vehicle_change_requests: vehicleChanges,
      vehicle_retirement_requests: vehicleRetirementRequests,
      scheduled_move_outs: scheduledMoveOuts,
      property_members: propertyMembers,
      occupancies,
      heartbeats,
      properties,
      sites,
      lanes,
    };
  }
  async createSite(p: Principal, input: { name: string; code: string }) {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    const name = input.name.trim();
    const code = input.code.trim().toUpperCase();
    if (!name || name.length > 80 || !/^[A-Z0-9_-]{2,16}$/.test(code))
      throw new BadRequestException("Invalid site name or code.");
    const id = randomUUID();
    try {
      await this.transaction(async (q) => {
        await q("INSERT INTO sites(id,organization_id,name,code) VALUES($1,$2,$3,$4)", [
          id,
          p.organizationId,
          name,
          code,
        ]);
        await q("UPDATE organizations SET config_version=config_version+1 WHERE id=$1", [
          p.organizationId,
        ]);
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'site.created',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            id,
            JSON.stringify({ name, code }),
            p.supportGrantId ?? null,
          ],
        );
      });
    } catch (error: any) {
      if (error.code === "23505") throw new BadRequestException("Site code already exists.");
      throw error;
    }
    return { site_id: id, name, code };
  }
  async createLane(
    p: Principal,
    input: { siteId: string; name: string; direction: "entry" | "exit" | "bidirectional" },
  ) {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    const name = input.name.trim();
    if (!name || name.length > 80) throw new BadRequestException("Invalid lane name.");
    const id = randomUUID();
    await this.transaction(async (q) => {
      const site = await q("SELECT id FROM sites WHERE id=$1 AND organization_id=$2", [
        input.siteId,
        p.organizationId,
      ]);
      if (!site.rows.length) throw new NotFoundException("Site not found.");
      await q(
        "INSERT INTO lanes(id,organization_id,site_id,name,direction) VALUES($1,$2,$3,$4,$5)",
        [id, p.organizationId, input.siteId, name, input.direction],
      );
      await q("UPDATE organizations SET config_version=config_version+1 WHERE id=$1", [
        p.organizationId,
      ]);
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'lane.created',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          id,
          JSON.stringify({ site_id: input.siteId, name, direction: input.direction }),
          p.supportGrantId ?? null,
        ],
      );
    });
    return { lane_id: id, site_id: input.siteId, name, direction: input.direction };
  }
  async enroll(
    p: Principal,
    input: {
      propertyId?: string;
      resident?: string;
      property?: string;
      plate: string;
      make: string;
      color: string;
      format: string;
      value: string;
      laneIds?: string[];
    },
  ) {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    const vehicle = randomUUID(),
      property = input.propertyId ?? randomUUID(),
      credential = randomUUID();
    let occupancyId = "";
    try {
      await this.transaction(async (q) => {
        // Gate policy: the listed lanes, or every lane in the village when none are chosen. A
        // credential with no policy rows is authorized everywhere, which is the current default.
        const requested = input.laneIds ?? [];
        const lanes = (
          await q(
            requested.length
              ? "SELECT id FROM lanes WHERE organization_id=$1 AND id = ANY($2)"
              : "SELECT id FROM lanes WHERE organization_id=$1",
            requested.length ? [p.organizationId, requested] : [p.organizationId],
          )
        ).rows.map((row) => row.id as string);
        if (requested.length && lanes.length !== requested.length)
          throw new BadRequestException("A selected lane is not in this organization.");
        if (input.propertyId) {
          const existing = await q(
            "SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE",
            [property, p.organizationId],
          );
          if (!existing.rows.length) throw new NotFoundException("Household not found.");
        } else {
          if (p.role === "resident")
            throw new ForbiddenException("Residents may only enroll vehicles to their household.");
          if (!input.property?.trim() || !input.resident?.trim())
            throw new BadRequestException("A new household needs a resident name and property.");
          await q(
            "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,$3,$4)",
            [property, p.organizationId, input.property.trim(), input.resident.trim()],
          );
          occupancyId = randomUUID();
          await q(
            "INSERT INTO property_occupancies(id,organization_id,property_id,started_at,resident_name_at_start,created_by) VALUES($1,$2,$3,now(),$4,$5)",
            [occupancyId, p.organizationId, property, input.resident!.trim(), p.id],
          );
        }
        if (input.propertyId) {
          const currentOccupancy = (
            await q(
              "SELECT id FROM property_occupancies WHERE organization_id=$1 AND property_id=$2 AND ended_at IS NULL FOR UPDATE",
              [p.organizationId, property],
            )
          ).rows[0];
          if (!currentOccupancy)
            throw new BadRequestException(
              "This household has no active occupancy. Invite a resident to start one before enrolling a vehicle.",
            );
          occupancyId = currentOccupancy.id;
        }
        await this.assertOccupancyBeforeCutoff(q, p.organizationId, occupancyId);
        await q(
          "INSERT INTO vehicles(id,organization_id,property_id,occupancy_id,plate,make,color) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [vehicle, p.organizationId, property, occupancyId, input.plate, input.make, input.color],
        );
        await q(
          "INSERT INTO credentials(id,organization_id,format,value,status,valid_from) VALUES($1,$2,$3,$4,'active',now())",
          [credential, p.organizationId, input.format, input.value],
        );
        await q(
          "INSERT INTO assignments(id,organization_id,credential_id,vehicle_id) VALUES($1,$2,$3,$4)",
          [randomUUID(), p.organizationId, credential, vehicle],
        );
        for (const lane of lanes)
          await q(
            "INSERT INTO credential_lanes(id,organization_id,credential_id,lane_id) VALUES($1,$2,$3,$4)",
            [randomUUID(), p.organizationId, credential, lane],
          );
        const versionRow = (
          await q(
            "UPDATE organizations SET config_version=config_version+1 WHERE id=$1 RETURNING config_version",
            [p.organizationId],
          )
        ).rows[0];
        await this.refreshScheduledMoveOutTargets(
          q,
          p.organizationId!,
          occupancyId,
          versionRow.config_version,
        );
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'credential.enrolled',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            credential,
            JSON.stringify({ vehicle_id: vehicle, property_id: property, lane_ids: lanes }),
            p.supportGrantId ?? null,
          ],
        );
      });
    } catch (e: any) {
      if (e.code === "23505")
        throw new BadRequestException("Plate or credential already enrolled in this village.");
      throw e;
    }
    return { vehicle_id: vehicle, property_id: property, credential_id: credential };
  }
  async status(p: Principal, id: string, status: string) {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    await this.transaction(async (q) => {
      const rows = (
        await q(
          `SELECT c.status,v.property_id FROM credentials c
           JOIN assignments a ON a.credential_id=c.id AND a.organization_id=c.organization_id AND a.ended_at IS NULL
           JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id AND v.active
           JOIN property_occupancies o ON o.id=v.occupancy_id AND o.organization_id=v.organization_id AND o.ended_at IS NULL
           WHERE c.id=$1 AND c.organization_id=$2
             AND NOT EXISTS (
               SELECT 1 FROM scheduled_move_outs s
               WHERE s.organization_id=o.organization_id AND s.occupancy_id=o.id
                AND s.status='scheduled' AND s.effective_at<=clock_timestamp()
             )
           FOR UPDATE OF c`,
          [id, p.organizationId],
        )
      ).rows;
      const current = rows[0];
      // A resident may only act on a credential belonging to one of their own households.
      if (!current || (p.role === "resident" && !p.properties.includes(current.property_id)))
        throw new NotFoundException("Credential not found.");
      if (current.status === "revoked" || current.status === "lost")
        throw new BadRequestException(
          "Lost or revoked credentials require replacement, not reactivation.",
        );
      if (current.status === status) return;
      await q("UPDATE credentials SET status=$1 WHERE id=$2 AND organization_id=$3", [
        status,
        id,
        p.organizationId,
      ]);
      await q("UPDATE organizations SET config_version=config_version+1 WHERE id=$1", [
        p.organizationId,
      ]);
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'credential.status_changed',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          id,
          JSON.stringify({ previous: current.status, status }),
          p.supportGrantId ?? null,
        ],
      );
    });
  }
  async requestVehicleChange(
    p: Principal,
    vehicleId: string,
    proposed: { plate: string; make: string; color: string },
  ) {
    if (!p.organizationId || p.role !== "resident" || !p.membershipId)
      throw new ForbiddenException("A resident membership is required.");
    const reference = (
      await this.query("SELECT property_id FROM vehicles WHERE id=$1 AND organization_id=$2", [
        vehicleId,
        p.organizationId,
      ])
    ).rows[0];
    if (!reference) throw new NotFoundException("Vehicle not found.");
    const requestId = randomUUID();
    try {
      return await this.transaction(async (q) => {
        const property = (
          await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
            reference.property_id,
            p.organizationId,
          ])
        ).rows[0];
        if (!property) throw new NotFoundException("Vehicle not found.");
        const vehicle = (
          await q(
            `SELECT v.id,v.property_id,v.occupancy_id,v.plate,v.make,v.color
             FROM vehicles v
             JOIN property_occupancies o ON o.id=v.occupancy_id AND o.ended_at IS NULL
             WHERE v.id=$1 AND v.organization_id=$2 AND v.active
             FOR UPDATE OF v`,
            [vehicleId, p.organizationId],
          )
        ).rows[0];
        if (!vehicle || vehicle.property_id !== reference.property_id)
          throw new NotFoundException("Active household vehicle not found.");
        await this.assertOccupancyBeforeCutoff(q, p.organizationId, vehicle.occupancy_id);
        const ownsCurrentOccupancy = (
          await q(
            `SELECT 1 FROM property_memberships
             WHERE organization_id=$1 AND property_id=$2 AND occupancy_id=$3
               AND membership_id=$4 AND ended_at IS NULL`,
            [p.organizationId, vehicle.property_id, vehicle.occupancy_id, p.membershipId],
          )
        ).rows.length;
        if (!ownsCurrentOccupancy) throw new NotFoundException("Vehicle not found.");
        if (
          vehicle.plate === proposed.plate &&
          vehicle.make === proposed.make &&
          vehicle.color === proposed.color
        )
          throw new BadRequestException("Enter a change to request.");
        await q(
          `INSERT INTO vehicle_change_requests(
             id,organization_id,property_id,occupancy_id,vehicle_id,requested_by,
             prior_plate,prior_make,prior_color,proposed_plate,proposed_make,proposed_color
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            requestId,
            p.organizationId,
            vehicle.property_id,
            vehicle.occupancy_id,
            vehicle.id,
            p.id,
            vehicle.plate,
            vehicle.make,
            vehicle.color,
            proposed.plate,
            proposed.make,
            proposed.color,
          ],
        );
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.change_requested',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            requestId,
            JSON.stringify({
              vehicle_id: vehicle.id,
              occupancy_id: vehicle.occupancy_id,
              proposed,
            }),
            p.supportGrantId ?? null,
          ],
        );
        return { request_id: requestId, status: "pending" };
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new BadRequestException("This vehicle already has a pending change request.");
      throw error;
    }
  }
  async approveVehicleChange(p: Principal, requestId: string, note = "") {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    const reference = (
      await this.query(
        "SELECT property_id FROM vehicle_change_requests WHERE id=$1 AND organization_id=$2",
        [requestId, p.organizationId],
      )
    ).rows[0];
    if (!reference) throw new NotFoundException("Vehicle change request not found.");
    try {
      return await this.transaction(async (q) => {
        const property = (
          await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
            reference.property_id,
            p.organizationId,
          ])
        ).rows[0];
        if (!property) throw new NotFoundException("Vehicle change request not found.");
        const request = (
          await q(
            `SELECT * FROM vehicle_change_requests
             WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
            [requestId, p.organizationId],
          )
        ).rows[0];
        if (!request || request.status !== "pending")
          throw new BadRequestException("This request is no longer pending.");
        const requesterStillBelongs = (
          await q(
            `SELECT 1 FROM property_memberships pm
             JOIN organization_memberships membership ON membership.id=pm.membership_id
             WHERE pm.organization_id=$1 AND pm.property_id=$2 AND pm.occupancy_id=$3
               AND pm.ended_at IS NULL AND membership.status='active'
               AND membership.role='resident' AND membership.user_id=$4
             LIMIT 1`,
            [p.organizationId, request.property_id, request.occupancy_id, request.requested_by],
          )
        ).rows.length;
        if (!requesterStillBelongs)
          throw new BadRequestException("The resident no longer belongs to this household.");
        await this.assertOccupancyBeforeCutoff(q, p.organizationId, request.occupancy_id);
        const vehicle = (
          await q(
            `SELECT v.id,v.occupancy_id,v.plate,v.make,v.color,v.active,o.ended_at
             FROM vehicles v JOIN property_occupancies o ON o.id=v.occupancy_id
             WHERE v.id=$1 AND v.organization_id=$2 FOR UPDATE OF v`,
            [request.vehicle_id, p.organizationId],
          )
        ).rows[0];
        if (
          !vehicle ||
          !vehicle.active ||
          vehicle.ended_at ||
          vehicle.occupancy_id !== request.occupancy_id
        )
          throw new BadRequestException("The household or vehicle is no longer active.");
        if (
          vehicle.plate !== request.prior_plate ||
          vehicle.make !== request.prior_make ||
          vehicle.color !== request.prior_color
        )
          throw new BadRequestException(
            "Vehicle details changed after this request was submitted.",
          );
        const plateChanged = request.proposed_plate !== vehicle.plate;
        await q(
          "UPDATE vehicles SET plate=$1,make=$2,color=$3 WHERE id=$4 AND organization_id=$5",
          [
            request.proposed_plate,
            request.proposed_make,
            request.proposed_color,
            vehicle.id,
            p.organizationId,
          ],
        );
        let version: number | null = null;
        let targetCount = 0;
        if (plateChanged) {
          const organization = (
            await q(
              "UPDATE organizations SET config_version=config_version+1 WHERE id=$1 RETURNING config_version",
              [p.organizationId],
            )
          ).rows[0];
          version = organization.config_version;
          const targets = (
            await q(
              `SELECT DISTINCT controller.id
               FROM controllers controller
               WHERE controller.organization_id=$1 AND controller.status='active'
                 AND EXISTS (
                   SELECT 1 FROM assignments a
                   JOIN credentials credential
                     ON credential.id=a.credential_id AND credential.organization_id=a.organization_id
                   WHERE a.organization_id=$1 AND a.vehicle_id=$2 AND a.ended_at IS NULL
                     AND (NOT EXISTS (
                            SELECT 1 FROM credential_lanes policy
                            WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                          ) OR EXISTS (
                            SELECT 1 FROM credential_lanes policy
                            JOIN controller_lanes assigned
                              ON assigned.organization_id=policy.organization_id
                             AND assigned.lane_id=policy.lane_id
                            WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                              AND assigned.controller_id=controller.id
                          ))
                 )`,
              [p.organizationId, vehicle.id],
            )
          ).rows;
          targetCount = targets.length;
          for (const target of targets)
            await q(
              "INSERT INTO vehicle_change_controller_targets(organization_id,request_id,controller_id) VALUES($1,$2,$3)",
              [p.organizationId, requestId, target.id],
            );
        }
        await q(
          `UPDATE vehicle_change_requests
           SET status='approved',decision_note=$1,decided_by=$2,resolved_at=now(),
               required_config_version=$3 WHERE id=$4`,
          [note, p.id, version, requestId],
        );
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.change_approved',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            requestId,
            JSON.stringify({
              vehicle_id: vehicle.id,
              property_id: request.property_id,
              occupancy_id: request.occupancy_id,
              plate_changed: plateChanged,
              required_config_version: version,
              target_controllers: targetCount,
              decision_note: note,
            }),
            p.supportGrantId ?? null,
          ],
        );
        return {
          request_id: requestId,
          status: "approved",
          required_config_version: version,
          expected_controllers: targetCount,
          acknowledged_controllers: 0,
        };
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new BadRequestException("That plate is already active in this village.");
      throw error;
    }
  }
  async rejectVehicleChange(p: Principal, requestId: string, note: string) {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    const reference = (
      await this.query(
        "SELECT property_id FROM vehicle_change_requests WHERE id=$1 AND organization_id=$2",
        [requestId, p.organizationId],
      )
    ).rows[0];
    if (!reference) throw new NotFoundException("Vehicle change request not found.");
    return this.transaction(async (q) => {
      const property = (
        await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
          reference.property_id,
          p.organizationId,
        ])
      ).rows[0];
      if (!property) throw new NotFoundException("Vehicle change request not found.");
      const request = (
        await q(
          "SELECT id,status FROM vehicle_change_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE",
          [requestId, p.organizationId],
        )
      ).rows[0];
      if (!request || request.status !== "pending")
        throw new BadRequestException("This request is no longer pending.");
      await q(
        "UPDATE vehicle_change_requests SET status='rejected',decision_note=$1,decided_by=$2,resolved_at=now() WHERE id=$3",
        [note, p.id, requestId],
      );
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.change_rejected',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          requestId,
          JSON.stringify({ reason: note }),
          p.supportGrantId ?? null,
        ],
      );
      return { request_id: requestId, status: "rejected" };
    });
  }

  private async vehicleControllers(q: Query, organizationId: string, vehicleId: string) {
    return (
      await q(
        `SELECT DISTINCT controller.id
         FROM controllers controller
         WHERE controller.organization_id=$1 AND controller.status='active'
           AND EXISTS (
             SELECT 1 FROM assignments a
             JOIN credentials credential
               ON credential.id=a.credential_id AND credential.organization_id=a.organization_id
             WHERE a.organization_id=$1 AND a.vehicle_id=$2 AND a.ended_at IS NULL
               AND (NOT EXISTS (
                      SELECT 1 FROM credential_lanes policy
                      WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                    ) OR EXISTS (
                      SELECT 1 FROM credential_lanes policy
                      JOIN controller_lanes assigned
                        ON assigned.organization_id=policy.organization_id
                       AND assigned.lane_id=policy.lane_id
                      WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                        AND assigned.controller_id=controller.id
                    ))
           )`,
        [organizationId, vehicleId],
      )
    ).rows;
  }

  private async occupancyControllers(q: Query, organizationId: string, occupancyId: string) {
    return (
      await q(
        `SELECT DISTINCT c.id
         FROM controllers c
         WHERE c.organization_id=$1 AND c.status='active'
           AND EXISTS (
             SELECT 1 FROM assignments a
             JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
             JOIN credentials credential
               ON credential.id=a.credential_id AND credential.organization_id=a.organization_id
             WHERE v.organization_id=$1 AND v.occupancy_id=$2 AND a.ended_at IS NULL
               AND (NOT EXISTS (
                      SELECT 1 FROM credential_lanes policy
                      WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                    ) OR EXISTS (
                      SELECT 1 FROM credential_lanes policy
                      JOIN controller_lanes assigned
                        ON assigned.organization_id=policy.organization_id
                       AND assigned.lane_id=policy.lane_id
                      WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                        AND assigned.controller_id=c.id
                    ))
           )`,
        [organizationId, occupancyId],
      )
    ).rows;
  }

  private async assertOccupancyBeforeCutoff(
    q: Query,
    organizationId: string | null,
    occupancyId: string,
    message = "This household's scheduled move-out is due.",
  ) {
    if (!organizationId) throw new ForbiddenException("Select an organization first.");
    const due = (
      await q(
        `SELECT 1 FROM scheduled_move_outs
         WHERE organization_id=$1 AND occupancy_id=$2 AND status='scheduled'
           AND effective_at<=clock_timestamp() LIMIT 1`,
        [organizationId, occupancyId],
      )
    ).rows.length;
    if (due) throw new BadRequestException(message);
  }

  private async moveOutControllers(
    q: Query,
    organizationId: string,
    occupancyId: string,
    scheduleId?: string,
  ) {
    return (
      await q(
        `SELECT DISTINCT c.id
         FROM controllers c
         WHERE c.organization_id=$1 AND c.status='active'
           AND (
             EXISTS (
               SELECT 1 FROM assignments a
               JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
               JOIN credentials credential
                 ON credential.id=a.credential_id AND credential.organization_id=a.organization_id
               WHERE v.organization_id=$1 AND v.occupancy_id=$2 AND a.ended_at IS NULL
                 AND (NOT EXISTS (
                        SELECT 1 FROM credential_lanes policy
                        WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                      ) OR EXISTS (
                        SELECT 1 FROM credential_lanes policy
                        JOIN controller_lanes assigned
                          ON assigned.organization_id=policy.organization_id
                         AND assigned.lane_id=policy.lane_id
                        WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                          AND assigned.controller_id=c.id
                      ))
             )
             OR ($3::uuid IS NOT NULL AND EXISTS (
               SELECT 1 FROM scheduled_move_out_controller_targets t
               WHERE t.organization_id=$1 AND t.schedule_id=$3 AND t.controller_id=c.id
             ))
           )`,
        [organizationId, occupancyId, scheduleId ?? null],
      )
    ).rows;
  }

  private async recordScheduleRevisionTargets(
    q: Tx,
    organizationId: string,
    scheduleId: string,
    revision: number,
    version: number,
    targets: Array<{ id: string }>,
  ) {
    for (const target of targets)
      await q(
        `INSERT INTO scheduled_move_out_controller_targets(
           organization_id,schedule_id,revision,controller_id,configuration_version
         ) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(organization_id,schedule_id,revision,controller_id)
         DO UPDATE SET configuration_version=GREATEST(
           scheduled_move_out_controller_targets.configuration_version,EXCLUDED.configuration_version
         )`,
        [organizationId, scheduleId, revision, target.id, version],
      );
  }

  private async refreshScheduledMoveOutTargets(
    q: Tx,
    organizationId: string,
    occupancyId: string,
    version: number,
  ) {
    const schedule = (
      await q(
        `SELECT id,revision FROM scheduled_move_outs
         WHERE organization_id=$1 AND occupancy_id=$2 AND status='scheduled' FOR NO KEY UPDATE`,
        [organizationId, occupancyId],
      )
    ).rows[0];
    if (!schedule) return;
    const targets = await this.moveOutControllers(q, organizationId, occupancyId, schedule.id);
    await this.recordScheduleRevisionTargets(
      q,
      organizationId,
      schedule.id,
      Number(schedule.revision),
      version,
      targets,
    );
  }

  async scheduleMoveOut(p: Principal, propertyId: string, effectiveAt: Date, reason: string) {
    if (!p.organizationId || p.role !== "hoa_admin")
      throw new ForbiddenException("Village administrator permission is required.");
    if (!(effectiveAt instanceof Date) || !Number.isFinite(effectiveAt.getTime()))
      throw new BadRequestException("Enter a valid move-out date and time.");
    return this.transaction(async (q) => {
      const property = (
        await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
          propertyId,
          p.organizationId,
        ])
      ).rows[0];
      if (!property) throw new NotFoundException("Household not found.");
      const occupancy = (
        await q(
          "SELECT id FROM property_occupancies WHERE organization_id=$1 AND property_id=$2 AND ended_at IS NULL FOR UPDATE",
          [p.organizationId, propertyId],
        )
      ).rows[0];
      if (!occupancy) throw new BadRequestException("This household has no active occupancy.");
      const existing = (
        await q(
          `SELECT * FROM scheduled_move_outs
           WHERE organization_id=$1 AND occupancy_id=$2 AND status='scheduled' FOR NO KEY UPDATE`,
          [p.organizationId, occupancy.id],
        )
      ).rows[0];
      const versionRow = (
        await q(
          "UPDATE organizations SET config_version=config_version+1 WHERE id=$1 RETURNING config_version",
          [p.organizationId],
        )
      ).rows[0];
      const clock = (
        await q(
          "SELECT clock_timestamp() AS current_time,clock_timestamp()+interval '10 minutes' AS earliest_time",
        )
      ).rows[0];
      if (existing && new Date(existing.effective_at) <= new Date(clock.current_time))
        throw new BadRequestException("A due move-out cannot be rescheduled.");
      if (effectiveAt <= new Date(clock.earliest_time))
        throw new BadRequestException("Schedule the move-out at least 10 minutes in advance.");
      const scheduleId = existing?.id ?? randomUUID();
      const revision = existing ? Number(existing.revision) + 1 : 1;
      if (existing) {
        await q(
          `UPDATE scheduled_move_outs
           SET requested_by=$1,reason=$2,effective_at=$3,revision=$4,
               configuration_version=$5,retry_count=0,last_attempt_at=NULL,
               next_attempt_at=NULL,last_processing_error=NULL,updated_at=clock_timestamp()
           WHERE id=$6 AND organization_id=$7 AND status='scheduled'`,
          [
            p.id,
            reason,
            effectiveAt,
            revision,
            versionRow.config_version,
            scheduleId,
            p.organizationId,
          ],
        );
      } else {
        await q(
          `INSERT INTO scheduled_move_outs(
             id,organization_id,property_id,occupancy_id,requested_by,reason,effective_at,
             revision,configuration_version
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            scheduleId,
            p.organizationId,
            propertyId,
            occupancy.id,
            p.id,
            reason,
            effectiveAt,
            revision,
            versionRow.config_version,
          ],
        );
      }
      const targets = await this.moveOutControllers(q, p.organizationId!, occupancy.id, scheduleId);
      await this.recordScheduleRevisionTargets(
        q,
        p.organizationId!,
        scheduleId,
        revision,
        versionRow.config_version,
        targets,
      );
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          existing ? "property.move_out_rescheduled" : "property.move_out_scheduled",
          scheduleId,
          JSON.stringify({
            property_id: propertyId,
            occupancy_id: occupancy.id,
            revision,
            effective_at: effectiveAt.toISOString(),
            reason,
            configuration_version: versionRow.config_version,
            target_controllers: targets.map((target: any) => target.id),
          }),
          p.supportGrantId ?? null,
        ],
      );
      return {
        schedule_id: scheduleId,
        occupancy_id: occupancy.id,
        status: "scheduled",
        revision,
        effective_at: effectiveAt.toISOString(),
        configuration_version: versionRow.config_version,
        expected_controllers: targets.length,
        acknowledged_controllers: 0,
      };
    });
  }

  async cancelScheduledMoveOut(p: Principal, propertyId: string) {
    if (!p.organizationId || p.role !== "hoa_admin")
      throw new ForbiddenException("Village administrator permission is required.");
    return this.transaction(async (q) => {
      const property = (
        await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
          propertyId,
          p.organizationId,
        ])
      ).rows[0];
      if (!property) throw new NotFoundException("Household not found.");
      const occupancy = (
        await q(
          "SELECT id FROM property_occupancies WHERE organization_id=$1 AND property_id=$2 AND ended_at IS NULL FOR UPDATE",
          [p.organizationId, propertyId],
        )
      ).rows[0];
      if (!occupancy) throw new BadRequestException("This household has no active occupancy.");
      const schedule = (
        await q(
          `SELECT * FROM scheduled_move_outs
           WHERE organization_id=$1 AND occupancy_id=$2 AND status='scheduled' FOR NO KEY UPDATE`,
          [p.organizationId, occupancy.id],
        )
      ).rows[0];
      if (!schedule)
        throw new NotFoundException("No scheduled move-out is active for this household.");
      const version = (
        await q(
          "UPDATE organizations SET config_version=config_version+1 WHERE id=$1 RETURNING config_version",
          [p.organizationId],
        )
      ).rows[0].config_version;
      const clock = (await q("SELECT clock_timestamp() AS current_time")).rows[0];
      if (new Date(schedule.effective_at) <= new Date(clock.current_time))
        throw new BadRequestException(
          "A due move-out cannot be cancelled; complete the move-out now.",
        );
      const revision = Number(schedule.revision) + 1;
      const targets = await this.moveOutControllers(
        q,
        p.organizationId!,
        occupancy.id,
        schedule.id,
      );
      await q(
        `UPDATE scheduled_move_outs
         SET status='cancelled',revision=$1,configuration_version=$2,cancelled_at=now(),updated_at=now()
         WHERE id=$3 AND organization_id=$4 AND status='scheduled'`,
        [revision, version, schedule.id, p.organizationId],
      );
      await this.recordScheduleRevisionTargets(
        q,
        p.organizationId!,
        schedule.id,
        revision,
        version,
        targets,
      );
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'property.move_out_schedule_cancelled',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          schedule.id,
          JSON.stringify({
            property_id: propertyId,
            occupancy_id: occupancy.id,
            revision,
            prior_effective_at: new Date(schedule.effective_at).toISOString(),
            configuration_version: version,
            target_controllers: targets.map((target: any) => target.id),
          }),
          p.supportGrantId ?? null,
        ],
      );
      return {
        schedule_id: schedule.id,
        status: "cancelled",
        revision,
        configuration_version: version,
        expected_controllers: targets.length,
        acknowledged_controllers: 0,
      };
    });
  }

  async requestVehicleRetirement(p: Principal, vehicleId: string, reason: string) {
    if (!p.organizationId || p.role !== "resident" || !p.membershipId)
      throw new ForbiddenException("A resident membership is required.");
    const reference = (
      await this.query("SELECT property_id FROM vehicles WHERE id=$1 AND organization_id=$2", [
        vehicleId,
        p.organizationId,
      ])
    ).rows[0];
    if (!reference) throw new NotFoundException("Vehicle not found.");
    try {
      return await this.transaction(async (q) => {
        const property = (
          await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
            reference.property_id,
            p.organizationId!,
          ])
        ).rows[0];
        const vehicle = (
          await q(
            `SELECT v.id,v.property_id,v.occupancy_id,v.plate,v.active,o.ended_at
             FROM vehicles v JOIN property_occupancies o
               ON o.id=v.occupancy_id AND o.organization_id=v.organization_id
             WHERE v.id=$1 AND v.organization_id=$2 FOR UPDATE OF v,o`,
            [vehicleId, p.organizationId],
          )
        ).rows[0];
        const member = vehicle
          ? (
              await q(
                `SELECT 1 FROM property_memberships pm
                 JOIN organization_memberships m ON m.id=pm.membership_id
                 WHERE pm.organization_id=$1 AND pm.property_id=$2 AND pm.occupancy_id=$3
                   AND pm.membership_id=$4 AND pm.ended_at IS NULL
                   AND m.status='active' AND m.role='resident'
                   AND NOT EXISTS (
                     SELECT 1 FROM scheduled_move_outs s
                     WHERE s.organization_id=pm.organization_id AND s.occupancy_id=pm.occupancy_id
                       AND s.status='scheduled' AND s.effective_at<=clock_timestamp()
                   ) LIMIT 1`,
                [p.organizationId, vehicle.property_id, vehicle.occupancy_id, p.membershipId],
              )
            ).rows.length
          : 0;
        if (!property || !vehicle || !vehicle.active || vehicle.ended_at || !member)
          throw new NotFoundException("Active household vehicle not found.");
        const id = randomUUID();
        await q(
          `INSERT INTO vehicle_retirement_requests(
             id,organization_id,property_id,occupancy_id,vehicle_id,requested_by,source,reason
           ) VALUES($1,$2,$3,$4,$5,$6,'resident',$7)`,
          [
            id,
            p.organizationId,
            vehicle.property_id,
            vehicle.occupancy_id,
            vehicleId,
            p.id,
            reason,
          ],
        );
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.retirement_requested',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            id,
            JSON.stringify({
              property_id: vehicle.property_id,
              occupancy_id: vehicle.occupancy_id,
              vehicle_id: vehicle.id,
              plate: vehicle.plate,
              reason,
            }),
            p.supportGrantId ?? null,
          ],
        );
        return { request_id: id, status: "pending" };
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new BadRequestException("This vehicle already has a pending retirement request.");
      throw error;
    }
  }

  private async applyVehicleRetirement(
    q: Tx,
    p: Principal,
    request: any,
    note: string,
  ): Promise<
    DeliveryCounts & { request_id: string; status: string; required_config_version: number | null }
  > {
    if (request.status !== "pending")
      throw new BadRequestException("This vehicle retirement is no longer pending.");
    const active = (
      await q(
        `SELECT v.id,v.property_id,v.occupancy_id,v.plate,v.make,v.color
         FROM vehicles v JOIN property_occupancies o
           ON o.id=v.occupancy_id AND o.organization_id=v.organization_id
         WHERE v.id=$1 AND v.organization_id=$2 AND v.active AND o.ended_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM scheduled_move_outs s
             WHERE s.organization_id=o.organization_id AND s.occupancy_id=o.id
               AND s.status='scheduled' AND s.effective_at<=clock_timestamp()
           )
         FOR UPDATE OF v,o`,
        [request.vehicle_id, p.organizationId],
      )
    ).rows[0];
    if (!active || active.occupancy_id !== request.occupancy_id)
      throw new BadRequestException("The household or vehicle is no longer active.");
    await this.assertOccupancyBeforeCutoff(q, p.organizationId, active.occupancy_id);
    if (request.source === "resident") {
      const requesterStillBelongs = (
        await q(
          `SELECT 1 FROM property_memberships pm
           JOIN organization_memberships m ON m.id=pm.membership_id
           WHERE pm.organization_id=$1 AND pm.property_id=$2 AND pm.occupancy_id=$3
             AND pm.ended_at IS NULL AND m.status='active' AND m.role='resident'
             AND m.user_id=$4 LIMIT 1`,
          [p.organizationId, request.property_id, request.occupancy_id, request.requested_by],
        )
      ).rows.length;
      if (!requesterStillBelongs)
        throw new BadRequestException("The resident no longer belongs to this household.");
    }
    const assigned = (
      await q(
        `SELECT a.credential_id,c.status AS credential_status
         FROM assignments a JOIN credentials c
           ON c.id=a.credential_id AND c.organization_id=a.organization_id
         WHERE a.organization_id=$1 AND a.vehicle_id=$2 AND a.ended_at IS NULL
         FOR UPDATE OF a,c`,
        [p.organizationId, active.id],
      )
    ).rows;
    const targets = assigned.length
      ? await this.vehicleControllers(q, p.organizationId!, active.id)
      : [];
    let version: number | null = null;
    if (assigned.length) {
      const organization = (
        await q(
          "UPDATE organizations SET config_version=config_version+1 WHERE id=$1 RETURNING config_version",
          [p.organizationId],
        )
      ).rows[0];
      version = organization.config_version;
      for (const target of targets)
        await q(
          "INSERT INTO vehicle_retirement_controller_targets(organization_id,request_id,controller_id) VALUES($1,$2,$3)",
          [p.organizationId, request.id, target.id],
        );
    }
    const cancelledChanges = (
      await q(
        `UPDATE vehicle_change_requests
         SET status='cancelled',decision_note='Vehicle access was retired.',decided_by=$1,resolved_at=now()
         WHERE organization_id=$2 AND vehicle_id=$3 AND status='pending'
         RETURNING id`,
        [p.id, p.organizationId, active.id],
      )
    ).rows;
    for (const change of cancelledChanges)
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.change_cancelled',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          change.id,
          JSON.stringify({ reason: "vehicle_retired" }),
          p.supportGrantId ?? null,
        ],
      );
    const cancelledReplacements = (
      await q(
        `UPDATE credential_replacement_requests r
         SET status='rejected',decision_note='Vehicle access was retired.',decided_by=$1,resolved_at=now()
         FROM assignments a
         WHERE a.credential_id=r.credential_id AND a.organization_id=r.organization_id
           AND a.vehicle_id=$3 AND a.ended_at IS NULL
           AND r.organization_id=$2 AND r.status='pending'
         RETURNING r.id,r.credential_id`,
        [p.id, p.organizationId, active.id],
      )
    ).rows;
    for (const replacement of cancelledReplacements)
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'credential.replacement_cancelled',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          replacement.id,
          JSON.stringify({ credential_id: replacement.credential_id, reason: "vehicle_retired" }),
          p.supportGrantId ?? null,
        ],
      );
    await q(
      `UPDATE credentials c SET status='revoked'
       WHERE c.organization_id=$1 AND EXISTS (
         SELECT 1 FROM assignments a
         WHERE a.organization_id=$1 AND a.vehicle_id=$2 AND a.credential_id=c.id
           AND a.ended_at IS NULL
       )`,
      [p.organizationId, active.id],
    );
    await q(
      "UPDATE assignments SET ended_at=now() WHERE organization_id=$1 AND vehicle_id=$2 AND ended_at IS NULL",
      [p.organizationId, active.id],
    );
    await q("UPDATE vehicles SET active=false WHERE organization_id=$1 AND id=$2", [
      p.organizationId,
      active.id,
    ]);
    await q(
      `UPDATE vehicle_retirement_requests
       SET status='approved',decision_note=$1,decided_by=$2,resolved_at=now(),required_config_version=$3
       WHERE organization_id=$4 AND id=$5 AND status='pending'`,
      [note, p.id, version, p.organizationId, request.id],
    );
    const result = {
      request_id: request.id,
      status: "approved",
      required_config_version: version,
      expected_controllers: targets.length,
      acknowledged_controllers: 0,
    };
    await q(
      "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.retired',$4,$5,$6)",
      [
        randomUUID(),
        p.organizationId,
        p.id,
        active.id,
        JSON.stringify({
          request_id: request.id,
          property_id: request.property_id,
          occupancy_id: request.occupancy_id,
          plate: active.plate,
          source: request.source,
          reason: request.reason,
          decision_note: note,
          cancelled_correction_requests: cancelledChanges.map((row: any) => row.id),
          cancelled_replacement_requests: cancelledReplacements.map((row: any) => row.id),
          target_controllers: targets.map((row: any) => row.id),
          required_config_version: version,
        }),
        p.supportGrantId ?? null,
      ],
    );
    return result;
  }

  async approveVehicleRetirement(p: Principal, requestId: string, note = "") {
    if (!p.organizationId || p.role !== "hoa_admin")
      throw new ForbiddenException("Village administrator permission is required.");
    const reference = (
      await this.query(
        "SELECT property_id FROM vehicle_retirement_requests WHERE id=$1 AND organization_id=$2",
        [requestId, p.organizationId],
      )
    ).rows[0];
    if (!reference) throw new NotFoundException("Vehicle retirement request not found.");
    return this.transaction(async (q) => {
      const property = (
        await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
          reference.property_id,
          p.organizationId,
        ])
      ).rows[0];
      if (!property) throw new NotFoundException("Vehicle retirement request not found.");
      const request = (
        await q(
          "SELECT * FROM vehicle_retirement_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE",
          [requestId, p.organizationId],
        )
      ).rows[0];
      if (!request) throw new NotFoundException("Vehicle retirement request not found.");
      return this.applyVehicleRetirement(q, p, request, note);
    });
  }

  async rejectVehicleRetirement(p: Principal, requestId: string, note: string) {
    if (!p.organizationId || p.role !== "hoa_admin")
      throw new ForbiddenException("Village administrator permission is required.");
    const reference = (
      await this.query(
        "SELECT property_id FROM vehicle_retirement_requests WHERE id=$1 AND organization_id=$2",
        [requestId, p.organizationId],
      )
    ).rows[0];
    if (!reference) throw new NotFoundException("Vehicle retirement request not found.");
    return this.transaction(async (q) => {
      await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
        reference.property_id,
        p.organizationId,
      ]);
      const request = (
        await q(
          "SELECT * FROM vehicle_retirement_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE",
          [requestId, p.organizationId],
        )
      ).rows[0];
      if (!request || request.status !== "pending")
        throw new BadRequestException("This vehicle retirement is no longer pending.");
      await q(
        "UPDATE vehicle_retirement_requests SET status='rejected',decision_note=$1,decided_by=$2,resolved_at=now() WHERE id=$3",
        [note, p.id, requestId],
      );
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.retirement_rejected',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          requestId,
          JSON.stringify({ note }),
          p.supportGrantId ?? null,
        ],
      );
      return { request_id: requestId, status: "rejected" };
    });
  }

  async cancelVehicleRetirement(p: Principal, requestId: string) {
    if (!p.organizationId || p.role !== "resident" || !p.membershipId)
      throw new ForbiddenException("A resident membership is required.");
    const reference = (
      await this.query(
        "SELECT property_id FROM vehicle_retirement_requests WHERE id=$1 AND organization_id=$2",
        [requestId, p.organizationId],
      )
    ).rows[0];
    if (!reference) throw new NotFoundException("Vehicle retirement request not found.");
    return this.transaction(async (q) => {
      await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
        reference.property_id,
        p.organizationId,
      ]);
      const request = (
        await q(
          "SELECT * FROM vehicle_retirement_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE",
          [requestId, p.organizationId],
        )
      ).rows[0];
      if (
        !request ||
        request.status !== "pending" ||
        request.source !== "resident" ||
        request.requested_by !== p.id
      )
        throw new NotFoundException("Pending vehicle retirement request not found.");
      const membership = (
        await q(
          `SELECT 1 FROM property_memberships
           WHERE organization_id=$1 AND occupancy_id=$2 AND membership_id=$3 AND ended_at IS NULL`,
          [p.organizationId, request.occupancy_id, p.membershipId],
        )
      ).rows.length;
      if (!membership) throw new NotFoundException("Pending vehicle retirement request not found.");
      await this.assertOccupancyBeforeCutoff(q, p.organizationId, request.occupancy_id);
      await q(
        "UPDATE vehicle_retirement_requests SET status='cancelled',decision_note='Cancelled by resident.',decided_by=$1,resolved_at=now() WHERE id=$2",
        [p.id, requestId],
      );
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.retirement_cancelled',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          requestId,
          JSON.stringify({ vehicle_id: request.vehicle_id }),
          p.supportGrantId ?? null,
        ],
      );
      return { request_id: requestId, status: "cancelled" };
    });
  }

  async retireVehicle(p: Principal, vehicleId: string, reason: string) {
    if (!p.organizationId || p.role !== "hoa_admin")
      throw new ForbiddenException("Village administrator permission is required.");
    const reference = (
      await this.query("SELECT property_id FROM vehicles WHERE id=$1 AND organization_id=$2", [
        vehicleId,
        p.organizationId,
      ])
    ).rows[0];
    if (!reference) throw new NotFoundException("Vehicle not found.");
    return this.transaction(async (q) => {
      await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
        reference.property_id,
        p.organizationId,
      ]);
      const vehicle = (
        await q(
          `SELECT v.id,v.property_id,v.occupancy_id,v.active,o.ended_at
           FROM vehicles v JOIN property_occupancies o
             ON o.id=v.occupancy_id AND o.organization_id=v.organization_id
           WHERE v.id=$1 AND v.organization_id=$2 FOR UPDATE OF v,o`,
          [vehicleId, p.organizationId],
        )
      ).rows[0];
      if (!vehicle || !vehicle.active || vehicle.ended_at)
        throw new BadRequestException("This vehicle is not in an active household.");
      await this.assertOccupancyBeforeCutoff(q, p.organizationId, vehicle.occupancy_id);
      const pending = (
        await q(
          "SELECT id FROM vehicle_retirement_requests WHERE organization_id=$1 AND vehicle_id=$2 AND status='pending' FOR UPDATE",
          [p.organizationId, vehicleId],
        )
      ).rows[0];
      if (pending)
        throw new BadRequestException("Review the pending resident retirement request first.");
      const id = randomUUID();
      await q(
        `INSERT INTO vehicle_retirement_requests(
           id,organization_id,property_id,occupancy_id,vehicle_id,requested_by,source,reason
         ) VALUES($1,$2,$3,$4,$5,$6,'hoa',$7)`,
        [id, p.organizationId, vehicle.property_id, vehicle.occupancy_id, vehicleId, p.id, reason],
      );
      const request = (
        await q(
          "SELECT * FROM vehicle_retirement_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE",
          [id, p.organizationId],
        )
      ).rows[0];
      // Direct HOA removal is recorded as one approved retirement; no resident review is pending.
      return this.applyVehicleRetirement(q, p, request, reason);
    });
  }

  async moveOut(
    p: Principal,
    propertyId: string,
    reason = "",
    options: {
      effectiveAt?: Date;
      scheduleId?: string;
      expectedOccupancyId?: string;
    } = {},
  ) {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    return this.transaction(async (q) => {
      const property = (
        await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
          propertyId,
          p.organizationId,
        ])
      ).rows[0];
      if (!property) throw new NotFoundException("Household not found.");
      const occupancy = (
        await q(
          "SELECT id FROM property_occupancies WHERE organization_id=$1 AND property_id=$2 AND ended_at IS NULL FOR UPDATE",
          [p.organizationId, propertyId],
        )
      ).rows[0];
      if (!occupancy) {
        if (options.scheduleId)
          return { schedule_id: options.scheduleId, status: "already_processed" };
        throw new BadRequestException("This household has no active occupancy.");
      }
      if (options.expectedOccupancyId && occupancy.id !== options.expectedOccupancyId)
        return { schedule_id: options.scheduleId, status: "stale_occupancy" };
      const schedule = (
        await q(
          `SELECT * FROM scheduled_move_outs
           WHERE organization_id=$1 AND occupancy_id=$2 AND status='scheduled' FOR NO KEY UPDATE`,
          [p.organizationId, occupancy.id],
        )
      ).rows[0];
      let effectiveAt = options.effectiveAt;
      let endReason = reason;
      let endingActor = p.id;
      let completingSchedule = false;
      if (options.scheduleId) {
        if (!schedule || schedule.id !== options.scheduleId)
          return { schedule_id: options.scheduleId, status: "already_processed" };
        const current = (await q("SELECT clock_timestamp() AS current_time")).rows[0].current_time;
        if (new Date(schedule.effective_at) > new Date(current))
          return { schedule_id: options.scheduleId, status: "not_due" };
        effectiveAt = new Date(schedule.effective_at);
        endReason = schedule.reason;
        endingActor = schedule.requested_by;
        completingSchedule = true;
      } else if (schedule) {
        const current = (await q("SELECT clock_timestamp() AS current_time")).rows[0].current_time;
        if (new Date(schedule.effective_at) <= new Date(current)) {
          effectiveAt = new Date(schedule.effective_at);
          endReason = schedule.reason;
          endingActor = schedule.requested_by;
          completingSchedule = true;
        } else {
          effectiveAt = new Date(current);
        }
      } else if (!effectiveAt) {
        effectiveAt = new Date(
          (await q("SELECT clock_timestamp() AS current_time")).rows[0].current_time,
        );
      }
      const endAt = effectiveAt ?? new Date();

      const revokedInvitations = (
        await q(
          `UPDATE invitations SET revoked_at=$1
           WHERE organization_id=$2 AND property_id=$3 AND role='resident'
             AND accepted_at IS NULL AND revoked_at IS NULL
            RETURNING id,email`,
          [effectiveAt, p.organizationId, propertyId],
        )
      ).rows;
      for (const invitation of revokedInvitations)
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'invitation.revoked',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            invitation.id,
            JSON.stringify({ role: "resident", email: invitation.email, reason: "move_out" }),
            p.supportGrantId ?? null,
          ],
        );

      // Lock the live vehicle, assignment, and credential rows before taking the controller
      // targets. Enrollment and resident invitation acceptance lock the property row above.
      const liveCredentials = (
        await q(
          `SELECT c.id AS credential_id,c.value,v.id AS vehicle_id,v.plate
           FROM vehicles v
           JOIN assignments a ON a.vehicle_id=v.id AND a.organization_id=v.organization_id AND a.ended_at IS NULL
           JOIN credentials c ON c.id=a.credential_id AND c.organization_id=a.organization_id
           WHERE v.organization_id=$1 AND v.occupancy_id=$2
           FOR UPDATE OF v,a,c`,
          [p.organizationId, occupancy.id],
        )
      ).rows;
      const vehicles = (
        await q(
          "SELECT id FROM vehicles WHERE organization_id=$1 AND occupancy_id=$2 AND active FOR UPDATE",
          [p.organizationId, occupancy.id],
        )
      ).rows;
      const targets = (
        await q(
          `SELECT DISTINCT c.id
           FROM controllers c
           WHERE c.organization_id=$1 AND c.status='active'
             AND EXISTS (
               SELECT 1 FROM assignments a
               JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
               JOIN credentials credential ON credential.id=a.credential_id AND credential.organization_id=a.organization_id
               WHERE v.organization_id=$1 AND v.occupancy_id=$2 AND a.ended_at IS NULL
                 AND (NOT EXISTS (
                        SELECT 1 FROM credential_lanes policy
                        WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                      ) OR EXISTS (
                        SELECT 1 FROM credential_lanes policy
                        JOIN controller_lanes assigned
                          ON assigned.organization_id=policy.organization_id
                         AND assigned.lane_id=policy.lane_id
                        WHERE policy.organization_id=$1 AND policy.credential_id=credential.id
                          AND assigned.controller_id=c.id
                      ))
             )`,
          [p.organizationId, occupancy.id],
        )
      ).rows;
      if (schedule) {
        const previouslyTargeted = (
          await q(
            "SELECT DISTINCT controller_id AS id FROM scheduled_move_out_controller_targets WHERE organization_id=$1 AND schedule_id=$2",
            [p.organizationId, schedule.id],
          )
        ).rows;
        for (const previous of previouslyTargeted)
          if (!targets.some((target: any) => target.id === previous.id)) targets.push(previous);
      }
      for (const target of targets)
        await q(
          "INSERT INTO occupancy_controller_targets(organization_id,occupancy_id,controller_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [p.organizationId, occupancy.id, target.id],
        );

      const canceledRequests = (
        await q(
          `UPDATE credential_replacement_requests r
           SET status='rejected',decision_note='Household occupancy ended.',decided_by=$1,resolved_at=$2
           FROM vehicles v
           WHERE v.id=r.vehicle_id AND v.organization_id=r.organization_id
              AND v.organization_id=$3 AND v.occupancy_id=$4 AND r.status='pending'
           RETURNING r.id,r.credential_id`,
          [endingActor, effectiveAt, p.organizationId, occupancy.id],
        )
      ).rows;
      for (const request of canceledRequests)
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'credential.replacement_cancelled',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            request.id,
            JSON.stringify({ credential_id: request.credential_id, reason: "occupancy_ended" }),
            p.supportGrantId ?? null,
          ],
        );
      const canceledVehicleChanges = (
        await q(
          `UPDATE vehicle_change_requests
           SET status='cancelled',decision_note='Household occupancy ended.',
               decided_by=$1,resolved_at=$2
           WHERE organization_id=$3 AND occupancy_id=$4 AND status='pending'
            RETURNING id,vehicle_id`,
          [endingActor, effectiveAt, p.organizationId, occupancy.id],
        )
      ).rows;
      for (const request of canceledVehicleChanges)
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.change_cancelled',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            request.id,
            JSON.stringify({ vehicle_id: request.vehicle_id, reason: "occupancy_ended" }),
            p.supportGrantId ?? null,
          ],
        );
      const canceledRetirements = (
        await q(
          `UPDATE vehicle_retirement_requests
           SET status='cancelled',decision_note='Household occupancy ended.',
               decided_by=$1,resolved_at=$2
           WHERE organization_id=$3 AND occupancy_id=$4 AND status='pending'
           RETURNING id,vehicle_id`,
          [endingActor, effectiveAt, p.organizationId, occupancy.id],
        )
      ).rows;
      for (const request of canceledRetirements)
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'vehicle.retirement_cancelled',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            request.id,
            JSON.stringify({ vehicle_id: request.vehicle_id, reason: "occupancy_ended" }),
            p.supportGrantId ?? null,
          ],
        );
      await q(
        `UPDATE credentials c SET status='revoked'
         WHERE c.organization_id=$1 AND EXISTS (
           SELECT 1 FROM assignments a
           JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
           WHERE a.organization_id=$1 AND a.credential_id=c.id AND a.ended_at IS NULL
             AND v.occupancy_id=$2
         )`,
        [p.organizationId, occupancy.id],
      );
      await q(
        "UPDATE assignments SET ended_at=$1 WHERE organization_id=$2 AND ended_at IS NULL AND vehicle_id IN (SELECT id FROM vehicles WHERE organization_id=$2 AND occupancy_id=$3)",
        [endAt, p.organizationId, occupancy.id],
      );
      await q(
        "UPDATE vehicles SET active=false WHERE organization_id=$1 AND occupancy_id=$2 AND active",
        [p.organizationId, occupancy.id],
      );
      await q(
        "UPDATE property_memberships SET ended_at=$1 WHERE organization_id=$2 AND occupancy_id=$3 AND ended_at IS NULL",
        [endAt, p.organizationId, occupancy.id],
      );
      const organization = (
        await q(
          "UPDATE organizations SET config_version=config_version+1 WHERE id=$1 RETURNING config_version",
          [p.organizationId],
        )
      ).rows[0];
      if (schedule) {
        if (completingSchedule) {
          await q(
            `UPDATE scheduled_move_outs
             SET status='completed',completed_at=clock_timestamp(),executed_by=$1,
                 completed_configuration_version=$2,next_attempt_at=NULL,
                 last_processing_error=NULL,updated_at=clock_timestamp()
             WHERE id=$3 AND organization_id=$4 AND status='scheduled'`,
            [p.id, organization.config_version, schedule.id, p.organizationId],
          );
        } else {
          const revision = Number(schedule.revision) + 1;
          await q(
            `UPDATE scheduled_move_outs
             SET status='cancelled',revision=$1,configuration_version=$2,
                 cancelled_at=now(),updated_at=now()
             WHERE id=$3 AND organization_id=$4 AND status='scheduled'`,
            [revision, organization.config_version, schedule.id, p.organizationId],
          );
          await this.recordScheduleRevisionTargets(
            q,
            p.organizationId!,
            schedule.id,
            revision,
            organization.config_version,
            targets,
          );
        }
      }
      await q(
        `UPDATE property_occupancies
         SET ended_at=$1,end_reason=$2,ended_by=$3,required_config_version=$4
         WHERE id=$5 AND organization_id=$6`,
        [
          endAt,
          endReason,
          endingActor,
          organization.config_version,
          occupancy.id,
          p.organizationId,
        ],
      );
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'property.occupancy_ended',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          occupancy.id,
          JSON.stringify({
            property_id: propertyId,
            vehicle_ids: vehicles.map((vehicle: any) => vehicle.id),
            credentials: liveCredentials.map((credential: any) => ({
              id: credential.credential_id,
              vehicle_id: credential.vehicle_id,
              plate: credential.plate,
            })),
            canceled_replacement_requests: canceledRequests.map((request: any) => request.id),
            canceled_vehicle_changes: canceledVehicleChanges.map((request: any) => request.id),
            canceled_vehicle_retirements: canceledRetirements.map((request: any) => request.id),
            target_controllers: targets.map((target: any) => target.id),
            required_config_version: organization.config_version,
            reason: endReason,
            effective_at: endAt.toISOString(),
            ...(schedule
              ? {
                  schedule_id: schedule.id,
                  schedule_revision: schedule.revision,
                  scheduled_by: schedule.requested_by,
                  processed_at: new Date().toISOString(),
                }
              : {}),
          }),
          p.supportGrantId ?? null,
        ],
      );
      return {
        occupancy_id: occupancy.id,
        property_id: propertyId,
        status: "ended",
        configuration_version: organization.config_version,
        vehicle_count: vehicles.length,
        credential_count: liveCredentials.length,
        canceled_request_count: canceledRequests.length,
        canceled_vehicle_change_count: canceledVehicleChanges.length,
        canceled_vehicle_retirement_count: canceledRetirements.length,
        revoked_invitation_count: revokedInvitations.length,
        expected_controllers: targets.length,
        acknowledged_controllers: 0,
      };
    });
  }
  async reportLostCredential(p: Principal, id: string) {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    return this.transaction(async (q) => {
      const current = (
        await q(
          `SELECT c.id,c.status,v.id AS vehicle_id,v.property_id
           FROM credentials c
           JOIN assignments a ON a.credential_id=c.id AND a.organization_id=c.organization_id AND a.ended_at IS NULL
           JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
           JOIN property_occupancies o ON o.id=v.occupancy_id AND o.organization_id=v.organization_id
             AND o.ended_at IS NULL
           WHERE c.id=$1 AND c.organization_id=$2 AND v.active
             AND NOT EXISTS (
               SELECT 1 FROM scheduled_move_outs s
               WHERE s.organization_id=o.organization_id AND s.occupancy_id=o.id
                 AND s.status='scheduled' AND s.effective_at<=clock_timestamp()
             )
           FOR UPDATE OF c,v`,
          [id, p.organizationId],
        )
      ).rows[0];
      if (!current || (p.role === "resident" && !p.properties.includes(current.property_id)))
        throw new NotFoundException("Credential not found.");
      if (current.status === "revoked")
        throw new BadRequestException("A revoked credential cannot be replaced.");

      const existing = (
        await q(
          "SELECT id,required_config_version FROM credential_replacement_requests WHERE organization_id=$1 AND credential_id=$2 AND status='pending'",
          [p.organizationId, id],
        )
      ).rows[0];
      if (existing)
        return {
          request_id: existing.id,
          status: "pending",
          required_config_version: existing.required_config_version,
          already_pending: true,
        };

      if (current.status !== "lost")
        await q("UPDATE credentials SET status='lost' WHERE id=$1 AND organization_id=$2", [
          id,
          p.organizationId,
        ]);
      const organization =
        current.status === "lost"
          ? (await q("SELECT config_version FROM organizations WHERE id=$1", [p.organizationId]))
              .rows[0]
          : (
              await q(
                "UPDATE organizations SET config_version=config_version+1 WHERE id=$1 RETURNING config_version",
                [p.organizationId],
              )
            ).rows[0];
      const requestId = randomUUID();
      await q(
        `INSERT INTO credential_replacement_requests
           (id,organization_id,property_id,vehicle_id,credential_id,requested_by,required_config_version)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          requestId,
          p.organizationId,
          current.property_id,
          current.vehicle_id,
          id,
          p.id,
          organization.config_version,
        ],
      );
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'credential.loss_reported',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          requestId,
          JSON.stringify({ credential_id: id, vehicle_id: current.vehicle_id }),
          p.supportGrantId ?? null,
        ],
      );
      return {
        request_id: requestId,
        status: "pending",
        required_config_version: organization.config_version,
        already_pending: false,
      };
    });
  }
  async issueCredentialReplacement(
    p: Principal,
    requestId: string,
    input: { format: string; value: string },
  ) {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    try {
      return await this.transaction(async (q) => {
        const scope = (
          await q(
            `SELECT r.property_id,v.occupancy_id
             FROM credential_replacement_requests r
             JOIN vehicles v ON v.id=r.vehicle_id AND v.organization_id=r.organization_id
             WHERE r.id=$1 AND r.organization_id=$2`,
            [requestId, p.organizationId],
          )
        ).rows[0];
        if (!scope) throw new NotFoundException("Replacement request not found.");
        await q("SELECT id FROM properties WHERE id=$1 AND organization_id=$2 FOR UPDATE", [
          scope.property_id,
          p.organizationId,
        ]);
        const occupancy = (
          await q(
            "SELECT id FROM property_occupancies WHERE id=$1 AND organization_id=$2 FOR UPDATE",
            [scope.occupancy_id, p.organizationId],
          )
        ).rows[0];
        if (!occupancy)
          throw new BadRequestException(
            "The household occupancy for this request no longer exists.",
          );
        const activeOccupancy = (
          await q("SELECT id FROM property_occupancies WHERE id=$1 AND ended_at IS NULL", [
            occupancy.id,
          ])
        ).rows[0];
        if (!activeOccupancy)
          throw new BadRequestException(
            "The household moved out before this replacement was issued.",
          );
        await this.assertOccupancyBeforeCutoff(q, p.organizationId, occupancy.id);
        const request = (
          await q(
            "SELECT id,vehicle_id,credential_id,status FROM credential_replacement_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE",
            [requestId, p.organizationId],
          )
        ).rows[0];
        if (!request) throw new NotFoundException("Replacement request not found.");
        if (request.status !== "pending")
          throw new BadRequestException("This replacement request has already been decided.");
        const assignment = (
          await q(
            `SELECT a.id,v.property_id FROM assignments a
             JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
             WHERE a.organization_id=$1 AND a.credential_id=$2 AND a.vehicle_id=$3
               AND a.ended_at IS NULL FOR UPDATE OF a`,
            [p.organizationId, request.credential_id, request.vehicle_id],
          )
        ).rows[0];
        if (!assignment)
          throw new BadRequestException(
            "The vehicle no longer has the credential in this request.",
          );

        const credentialId = randomUUID();
        await q(
          "UPDATE assignments SET ended_at=now() WHERE id=$1 AND ended_at IS NULL RETURNING id",
          [assignment.id],
        );
        await q(
          "INSERT INTO credentials(id,organization_id,format,value,status,valid_from) VALUES($1,$2,$3,$4,'active',now())",
          [credentialId, p.organizationId, input.format, input.value],
        );
        await q(
          "INSERT INTO assignments(id,organization_id,credential_id,vehicle_id) VALUES($1,$2,$3,$4)",
          [randomUUID(), p.organizationId, credentialId, request.vehicle_id],
        );
        const lanes = (
          await q(
            "SELECT lane_id FROM credential_lanes WHERE organization_id=$1 AND credential_id=$2",
            [p.organizationId, request.credential_id],
          )
        ).rows;
        for (const lane of lanes)
          await q(
            "INSERT INTO credential_lanes(id,organization_id,credential_id,lane_id) VALUES($1,$2,$3,$4)",
            [randomUUID(), p.organizationId, credentialId, lane.lane_id],
          );
        const organization = (
          await q(
            "UPDATE organizations SET config_version=config_version+1 WHERE id=$1 RETURNING config_version",
            [p.organizationId],
          )
        ).rows[0];
        await this.refreshScheduledMoveOutTargets(
          q,
          p.organizationId!,
          occupancy.id,
          organization.config_version,
        );
        await q(
          `UPDATE credential_replacement_requests
           SET status='issued',replacement_credential_id=$1,required_config_version=$2,
               decided_by=$3,resolved_at=now()
           WHERE id=$4 AND organization_id=$5`,
          [credentialId, organization.config_version, p.id, requestId, p.organizationId],
        );
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'credential.replacement_issued',$4,$5,$6)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            requestId,
            JSON.stringify({
              previous_credential_id: request.credential_id,
              replacement_credential_id: credentialId,
              vehicle_id: request.vehicle_id,
            }),
            p.supportGrantId ?? null,
          ],
        );
        return {
          request_id: requestId,
          credential_id: credentialId,
          configuration_version: organization.config_version,
          status: "issued",
        };
      });
    } catch (error: any) {
      if (error.code === "23505")
        throw new BadRequestException("That tag is already enrolled in this village.");
      throw error;
    }
  }
  async rejectCredentialReplacement(p: Principal, requestId: string, note = "") {
    if (!p.organizationId) throw new ForbiddenException("Select an organization first.");
    await this.transaction(async (q) => {
      const request = (
        await q(
          "SELECT id,status FROM credential_replacement_requests WHERE id=$1 AND organization_id=$2 FOR UPDATE",
          [requestId, p.organizationId],
        )
      ).rows[0];
      if (!request) throw new NotFoundException("Replacement request not found.");
      if (request.status !== "pending")
        throw new BadRequestException("This replacement request has already been decided.");
      await q(
        `UPDATE credential_replacement_requests
         SET status='rejected',decision_note=$1,decided_by=$2,resolved_at=now()
         WHERE id=$3 AND organization_id=$4`,
        [note, p.id, requestId, p.organizationId],
      );
      await q(
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail,support_grant_id) VALUES($1,$2,$3,'credential.replacement_rejected',$4,$5,$6)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          requestId,
          JSON.stringify({ note }),
          p.supportGrantId ?? null,
        ],
      );
    });
    return { request_id: requestId, status: "rejected" };
  }
  async configuration(device?: DeviceIdentity): Promise<Configuration> {
    const identity =
      device ??
      ({
        id: IDS.edge,
        organizationId: IDS.organization,
        siteId: IDS.site,
        laneIds: [IDS.lane],
        demo: true,
      } satisfies DeviceIdentity);
    if (!identity.laneIds.length) throw new ForbiddenException("Controller has no lane scope.");
    return this.transaction(async (q) => {
      const organization = (
        await q("SELECT config_version FROM organizations WHERE id=$1 FOR SHARE", [
          identity.organizationId,
        ])
      ).rows[0];
      if (!organization) throw new NotFoundException("Controller organization not found.");
      const records = (
        await q(
          `SELECT c.*,v.id AS vehicle_id,v.plate AS vehicle_plate,v.active,
                  CASE
                    WHEN s.effective_at IS NULL THEN c.valid_until
                    WHEN c.valid_until IS NULL THEN s.effective_at
                    ELSE LEAST(c.valid_until,s.effective_at)
                  END AS effective_valid_until,
                  (SELECT count(*)::int FROM credential_lanes cl WHERE cl.credential_id=c.id) AS policy_count,
                  (SELECT array_agg(cl.lane_id::text ORDER BY cl.lane_id)
                     FROM credential_lanes cl
                    WHERE cl.credential_id=c.id AND cl.lane_id=ANY($2::uuid[])) AS policy_lane_ids
           FROM credentials c
           JOIN assignments a ON a.credential_id=c.id AND a.organization_id=c.organization_id AND a.ended_at IS NULL
           JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
           LEFT JOIN scheduled_move_outs s
             ON s.organization_id=v.organization_id AND s.occupancy_id=v.occupancy_id
            AND s.status='scheduled'
           WHERE c.organization_id=$1 ORDER BY c.id`,
          [identity.organizationId, identity.laneIds],
        )
      ).rows;
      const allowed = new Set(identity.laneIds);
      const credentials = records.flatMap((c) => {
        const laneIds =
          Number(c.policy_count) > 0
            ? (c.policy_lane_ids ?? []).filter((laneId: string) => allowed.has(laneId))
            : identity.laneIds;
        if (!laneIds.length) return [];
        const validUntil = c.effective_valid_until ? new Date(c.effective_valid_until) : null;
        const validFrom = new Date(c.valid_from);
        // A schedule may be moved earlier than a newly issued credential's start. Such a
        // credential must not be exported with an invalid validity window.
        if (validUntil && validUntil <= validFrom) return [];
        return [
          {
            id: c.id,
            format: c.format,
            value: c.value,
            status: c.active ? c.status : "suspended",
            vehicle_id: c.vehicle_id,
            vehicle_plate: c.vehicle_plate,
            lane_ids: laneIds,
            valid_from: validFrom.toISOString(),
            valid_until: validUntil ? validUntil.toISOString() : null,
          },
        ];
      });
      return {
        schema_version: 1,
        organization_id: identity.organizationId,
        edge_id: identity.id,
        site_id: identity.siteId,
        lane_ids: identity.laneIds,
        version: organization.config_version,
        generated_at: new Date().toISOString(),
        credentials,
      };
    });
  }
  async ingest(events: AccessEvent[], device?: DeviceIdentity) {
    const identity =
      device ??
      ({
        id: IDS.edge,
        organizationId: IDS.organization,
        siteId: IDS.site,
        laneIds: [IDS.lane],
        demo: true,
      } satisfies DeviceIdentity);
    return this.transaction(async (q) => {
      for (const e of events) {
        if (
          e.organization_id !== identity.organizationId ||
          e.edge_id !== identity.id ||
          !identity.laneIds.includes(e.lane_id)
        )
          throw new BadRequestException("Device scope mismatch.");
        if (
          e.vehicle_id &&
          !(
            await q("SELECT id FROM vehicles WHERE id=$1 AND organization_id=$2", [
              e.vehicle_id,
              identity.organizationId,
            ])
          ).rows.length
        )
          throw new BadRequestException("Vehicle scope mismatch.");
        const inserted = await q(
          "INSERT INTO access_events(event_id,organization_id,edge_id,vehicle_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_id) DO NOTHING RETURNING event_id",
          [e.event_id, e.organization_id, e.edge_id, e.vehicle_id, JSON.stringify(e)],
        );
        if (!inserted.rows.length) {
          // Concurrent retries wait on the unique constraint before comparing the committed content.
          const existing = (
            await q("SELECT payload FROM access_events WHERE event_id=$1", [e.event_id])
          ).rows[0];
          const stable = (v: any): string =>
            JSON.stringify(
              Object.fromEntries(
                Object.keys(v)
                  .sort()
                  .map((k) => [k, v[k]]),
              ),
            );
          if (!existing || stable(existing.payload) !== stable(e))
            throw new BadRequestException("Event UUID was reused with different content.");
        }
      }
      return { acknowledged: events.map((e) => e.event_id) };
    });
  }
  async heartbeat(payload: any, device?: DeviceIdentity) {
    const identity =
      device ??
      ({
        id: IDS.edge,
        organizationId: IDS.organization,
        siteId: IDS.site,
        laneIds: [IDS.lane],
        demo: true,
      } satisfies DeviceIdentity);
    if (
      payload.edge_id !== identity.id ||
      payload.organization_id !== identity.organizationId ||
      !Number.isInteger(payload.config_version) ||
      payload.config_version < 0 ||
      !Number.isInteger(payload.pending_events) ||
      payload.pending_events < 0
    )
      throw new BadRequestException("Device scope mismatch.");
    if (identity.demo) {
      await this.query(
        "INSERT INTO edge_heartbeats(edge_id,organization_id,payload) VALUES($1,$2,$3) ON CONFLICT(edge_id) DO UPDATE SET payload=$3,received_at=now()",
        [identity.id, identity.organizationId, JSON.stringify(payload)],
      );
    } else {
      const result = await this.query(
        `UPDATE controllers SET protocol_version=$1,software_version=$2,hardware_mode=$3,config_version=$4,
                pending_events=$5,last_reported_at=$6,last_seen_at=now(),updated_at=now()
         WHERE id=$7 AND organization_id=$8 AND status='active' RETURNING id`,
        [
          payload.protocol_version ?? 1,
          payload.software_version ?? null,
          payload.hardware_mode,
          payload.config_version,
          payload.pending_events,
          payload.reported_at,
          identity.id,
          identity.organizationId,
        ],
      );
      if (!result.rows.length) throw new UnauthorizedException();
    }
    return { ok: true };
  }
}
