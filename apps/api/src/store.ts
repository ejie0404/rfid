import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { mkdirSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
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
import type { DeviceIdentity } from "./session.js";

const migrations = new URL("../../../database/migrations/", import.meta.url);
export type Result = { rows: any[] };
export type Query = (sql: string, values?: any[]) => Promise<Result>;
/** A transaction handle. Multi-statement SQL needs `exec`; parameterized SQL uses the call itself. */
export type Tx = Query & { exec: (sql: string) => Promise<void> };
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
  private queue: Promise<unknown> = Promise.resolve();
  private demo = false;
  query!: Query;
  async start(options: StartOptions = {}) {
    this.demo = !!options.demo;
    if (process.env.DATABASE_URL && !options.memory) {
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
      this.query = async (s, v) => this.pool!.query(s, v);
    } else {
      const directory = resolve(process.env.SMARTGATE_DATA_DIR || ".data/postgres");
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
      await this.query("SELECT version FROM schema_migrations ORDER BY version")
    ).rows.map((row) => row.version as string);
    const expected = migrationFiles(migrations).map((file) => file.version);
    const missing = expected.filter((version) => !recorded.includes(version));
    if (missing.length)
      throw new Error(
        "This database is missing required migrations: " +
          missing.join(", ") +
          ". Run `npm run migrate` with migration credentials before starting the application.",
      );
    const unknown = recorded.filter((version) => !expected.includes(version));
    if (unknown.length)
      throw new Error(
        "This database has migrations this build does not know about: " +
          unknown.join(", ") +
          ". Deploy the matching application version.",
      );
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
              "INSERT INTO property_memberships(id,organization_id,property_id,membership_id,relationship,is_primary_contact) VALUES($1,$2,$3,$4,'owner',true)",
              [randomUUID(), organizationId, IDS.property, row.id],
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
          "INSERT INTO vehicles(id,organization_id,property_id,plate,make,color) VALUES($1,$2,$3,'NCR 2048','Toyota Fortuner','Pearl white')",
          [vehicle, IDS.organization, IDS.property],
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
    const residentScope = resident ? " AND v.property_id = ANY($2)" : "";
    const args = resident ? [p.organizationId, p.properties] : [p.organizationId];
    const vehicles = resident
      ? (
          await this.query(
            `SELECT v.*, p.label AS property_label,p.resident_name,c.id AS credential_id,c.value AS credential_value,c.format,c.status AS credential_status
   FROM vehicles v JOIN properties p ON p.id=v.property_id AND p.organization_id=v.organization_id
   LEFT JOIN assignments a ON a.vehicle_id=v.id AND a.organization_id=v.organization_id AND a.ended_at IS NULL
   LEFT JOIN credentials c ON c.id=a.credential_id AND c.organization_id=v.organization_id
   WHERE v.organization_id=$1${residentScope} ORDER BY v.plate`,
            args,
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
   WHERE v.organization_id=$1 ORDER BY v.plate`,
              [p.organizationId],
            )
          ).rows;
    const events = resident
      ? (
          await this.query(
            "SELECT e.payload FROM access_events e JOIN vehicles v ON v.id=e.vehicle_id AND v.organization_id=e.organization_id WHERE e.organization_id=$1 AND v.property_id = ANY($2) ORDER BY e.received_at DESC LIMIT 100",
            args,
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
            "SELECT id,label,resident_name FROM properties WHERE organization_id=$1 AND id = ANY($2) ORDER BY label",
            args,
          )
        ).rows
      : guard
        ? []
        : (
            await this.query(
              "SELECT id,label,resident_name FROM properties WHERE organization_id=$1 ORDER BY label",
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
    return {
      organization,
      principal: p,
      vehicles,
      events: events.map((r) => r.payload),
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
        }
        await q(
          "INSERT INTO vehicles(id,organization_id,property_id,plate,make,color) VALUES($1,$2,$3,$4,$5,$6)",
          [vehicle, p.organizationId, property, input.plate, input.make, input.color],
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
        await q("UPDATE organizations SET config_version=config_version+1 WHERE id=$1", [
          p.organizationId,
        ]);
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
          "SELECT c.status,v.property_id FROM credentials c JOIN assignments a ON a.credential_id=c.id AND a.organization_id=c.organization_id AND a.ended_at IS NULL JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id WHERE c.id=$1 AND c.organization_id=$2 FOR UPDATE OF c",
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
                  (SELECT count(*)::int FROM credential_lanes cl WHERE cl.credential_id=c.id) AS policy_count,
                  (SELECT array_agg(cl.lane_id::text ORDER BY cl.lane_id)
                     FROM credential_lanes cl
                    WHERE cl.credential_id=c.id AND cl.lane_id=ANY($2::uuid[])) AS policy_lane_ids
           FROM credentials c
           JOIN assignments a ON a.credential_id=c.id AND a.organization_id=c.organization_id AND a.ended_at IS NULL
           JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
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
        return [
          {
            id: c.id,
            format: c.format,
            value: c.value,
            status: c.active ? c.status : "suspended",
            vehicle_id: c.vehicle_id,
            vehicle_plate: c.vehicle_plate,
            lane_ids: laneIds,
            valid_from: new Date(c.valid_from).toISOString(),
            valid_until: c.valid_until ? new Date(c.valid_until).toISOString() : null,
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
