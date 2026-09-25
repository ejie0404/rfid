import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";
import { readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { IDS, type Configuration, type AccessEvent } from "@smartgate/contracts";
import type { Principal } from "@smartgate/permissions";
import { BadRequestException, NotFoundException } from "@nestjs/common";

type Result = { rows: any[] };
type Query = (sql: string, values?: any[]) => Promise<Result>;
export class Store {
  private memory?: PGlite;
  private pool?: Pool;
  private queue: Promise<unknown> = Promise.resolve();
  query!: Query;
  async start(inMemory = false) {
    if (process.env.DATABASE_URL && !inMemory) {
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
      this.query = async (s, v) => this.pool!.query(s, v);
    } else {
      const directory = resolve(process.env.SMARTGATE_DATA_DIR || ".data/postgres");
      if (!inMemory) mkdirSync(directory, { recursive: true });
      this.memory = new PGlite(inMemory ? undefined : directory);
      this.query = (s, v) => this.memory!.query(s, v);
    }
    const schema = readFileSync(
      new URL("../../../database/migrations/001_foundation.sql", import.meta.url),
      "utf8",
    );
    if (this.memory) await this.memory.exec(schema);
    else await this.query(schema);
    await this.seed();
  }
  async transaction<T>(run: (q: Query) => Promise<T>): Promise<T> {
    if (this.pool) {
      const c = await this.pool.connect();
      try {
        await c.query("BEGIN");
        const result = await run((s, v) => c.query(s, v));
        await c.query("COMMIT");
        return result;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
    const next = this.queue.then(() =>
      this.memory!.transaction((tx) => run((s, v) => tx.query(s, v))),
    );
    this.queue = next.catch(() => {});
    return next;
  }
  async close() {
    await this.queue;
    await this.memory?.close();
    await this.pool?.end();
  }
  private async seed() {
    await this.transaction(async (q) => {
      await q(
        "INSERT INTO organizations(id,name) VALUES($1,'Palm Grove Village'),($2,'Cedar Heights') ON CONFLICT DO NOTHING",
        [IDS.organization, IDS.otherOrganization],
      );
      await q(
        "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,'Lot 12 · Acacia Street','Andrea Santos') ON CONFLICT DO NOTHING",
        [IDS.property, IDS.organization],
      );
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
  async snapshot(p: Principal) {
    const filter = p.role === "resident" ? " AND v.property_id=$2" : "";
    const args = p.role === "resident" ? [p.organizationId, p.propertyId] : [p.organizationId];
    const vehicles = (
      await this.query(
        `SELECT v.*, p.label AS property_label,p.resident_name,c.id AS credential_id,c.value AS credential_value,c.format,c.status AS credential_status
   FROM vehicles v JOIN properties p ON p.id=v.property_id AND p.organization_id=v.organization_id
   LEFT JOIN assignments a ON a.vehicle_id=v.id AND a.organization_id=v.organization_id AND a.ended_at IS NULL
   LEFT JOIN credentials c ON c.id=a.credential_id AND c.organization_id=v.organization_id
   WHERE v.organization_id=$1${filter} ORDER BY v.plate`,
        args,
      )
    ).rows;
    const events =
      p.role === "resident"
        ? (
            await this.query(
              "SELECT e.payload FROM access_events e JOIN vehicles v ON v.id=e.vehicle_id AND v.organization_id=e.organization_id WHERE e.organization_id=$1 AND v.property_id=$2 ORDER BY e.received_at DESC LIMIT 100",
              args,
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
      p.role === "resident"
        ? []
        : (
            await this.query(
              "SELECT payload,received_at FROM edge_heartbeats WHERE organization_id=$1",
              [p.organizationId],
            )
          ).rows;
    return {
      organization,
      principal: p,
      vehicles,
      events: events.map((r) => r.payload),
      heartbeats,
    };
  }
  async enroll(
    p: Principal,
    input: {
      resident: string;
      property: string;
      plate: string;
      make: string;
      color: string;
      format: string;
      value: string;
    },
  ) {
    const vehicle = randomUUID(),
      property = randomUUID(),
      credential = randomUUID();
    try {
      await this.transaction(async (q) => {
        await q(
          "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,$3,$4)",
          [property, p.organizationId, input.property, input.resident],
        );
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
        await q("UPDATE organizations SET config_version=config_version+1 WHERE id=$1", [
          p.organizationId,
        ]);
        await q(
          "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail) VALUES($1,$2,$3,'credential.enrolled',$4,$5)",
          [
            randomUUID(),
            p.organizationId,
            p.id,
            credential,
            JSON.stringify({ vehicle_id: vehicle }),
          ],
        );
      });
    } catch (e: any) {
      if (e.code === "23505")
        throw new BadRequestException("Plate or credential already enrolled in this village.");
      throw e;
    }
    return { vehicle_id: vehicle, credential_id: credential };
  }
  async status(p: Principal, id: string, status: string) {
    await this.transaction(async (q) => {
      const rows = (
        await q(
          "SELECT c.status,v.property_id FROM credentials c JOIN assignments a ON a.credential_id=c.id AND a.organization_id=c.organization_id AND a.ended_at IS NULL JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id WHERE c.id=$1 AND c.organization_id=$2 FOR UPDATE OF c",
          [id, p.organizationId],
        )
      ).rows;
      const current = rows[0];
      if (!current || (p.role === "resident" && current.property_id !== p.propertyId))
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
        "INSERT INTO audit_events(id,organization_id,actor_id,action,entity_id,detail) VALUES($1,$2,$3,'credential.status_changed',$4,$5)",
        [
          randomUUID(),
          p.organizationId,
          p.id,
          id,
          JSON.stringify({ previous: current.status, status }),
        ],
      );
    });
  }
  async configuration(): Promise<Configuration> {
    // The demonstration device is bound to one organization/site. No caller-supplied tenant.
    return this.transaction(async (q) => {
      const version = (
        await q("SELECT config_version FROM organizations WHERE id=$1 FOR SHARE", [
          IDS.organization,
        ])
      ).rows[0].config_version;
      const records = (
        await q(
          "SELECT c.*,v.id AS vehicle_id,v.plate AS vehicle_plate,v.active FROM credentials c JOIN assignments a ON a.credential_id=c.id AND a.organization_id=c.organization_id AND a.ended_at IS NULL JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id WHERE c.organization_id=$1 ORDER BY c.id",
          [IDS.organization],
        )
      ).rows;
      return {
        schema_version: 1,
        organization_id: IDS.organization,
        edge_id: IDS.edge,
        site_id: IDS.site,
        version,
        generated_at: new Date().toISOString(),
        credentials: records.map((c) => ({
          id: c.id,
          format: c.format,
          value: c.value,
          status: c.active ? c.status : "suspended",
          vehicle_id: c.vehicle_id,
          vehicle_plate: c.vehicle_plate,
          lane_ids: [IDS.lane],
          valid_from: new Date(c.valid_from).toISOString(),
          valid_until: c.valid_until ? new Date(c.valid_until).toISOString() : null,
        })),
      };
    });
  }
  async ingest(events: AccessEvent[]) {
    return this.transaction(async (q) => {
      for (const e of events) {
        if (
          e.organization_id !== IDS.organization ||
          e.edge_id !== IDS.edge ||
          e.lane_id !== IDS.lane
        )
          throw new BadRequestException("Device scope mismatch.");
        if (
          e.vehicle_id &&
          !(
            await q("SELECT id FROM vehicles WHERE id=$1 AND organization_id=$2", [
              e.vehicle_id,
              IDS.organization,
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
  async heartbeat(payload: any) {
    if (payload.edge_id !== IDS.edge || payload.organization_id !== IDS.organization)
      throw new BadRequestException("Device scope mismatch.");
    await this.query(
      "INSERT INTO edge_heartbeats(edge_id,organization_id,payload) VALUES($1,$2,$3) ON CONFLICT(edge_id) DO UPDATE SET payload=$3,received_at=now()",
      [IDS.edge, IDS.organization, JSON.stringify(payload)],
    );
    return { ok: true };
  }
}
