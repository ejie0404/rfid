import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Req,
  Inject,
  Module,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { IDS, DEMO_EDGE_TOKEN, validateProtocol, type AccessEvent } from "@smartgate/contracts";
import { can, type Permission, type Principal } from "@smartgate/permissions";
import { Store } from "./store.js";

const profiles: Record<string, Principal> = {
  admin: {
    id: "demo-admin",
    organizationId: IDS.organization,
    role: "hoa_admin",
    name: "Village administrator",
  },
  guard: {
    id: "demo-guard",
    organizationId: IDS.organization,
    role: "guard",
    name: "Main gate guard",
  },
  resident: {
    id: "demo-resident",
    organizationId: IDS.organization,
    role: "resident",
    propertyId: IDS.property,
    name: "Andrea Santos",
  },
  other: {
    id: "demo-other",
    organizationId: IDS.otherOrganization,
    role: "hoa_admin",
    name: "Cedar Heights administrator",
  },
};
class Sessions {
  entries = new Map<string, { principal: Principal; expires: number }>();
  create(profile: string) {
    const principal = profiles[profile];
    if (!principal) throw new BadRequestException("Unknown demonstration profile.");
    const now = Date.now();
    for (const [k, v] of this.entries) if (v.expires <= now) this.entries.delete(k);
    if (this.entries.size > 1000) throw new BadRequestException("Too many local sessions.");
    const token = randomBytes(32).toString("hex");
    this.entries.set(token, { principal, expires: now + 3600000 });
    return { token, principal };
  }
  get(req: FastifyRequest, permission?: Permission) {
    const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const session = this.entries.get(token);
    if (!session || session.expires < Date.now()) throw new UnauthorizedException();
    if (permission && !can(session.principal.role, permission)) throw new ForbiddenException();
    return session.principal;
  }
  edge(req: FastifyRequest) {
    if (req.headers.authorization !== "Bearer " + DEMO_EDGE_TOKEN)
      throw new UnauthorizedException();
  }
}
function stringField(value: unknown, label: string, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new BadRequestException("Invalid " + label);
  return value.trim();
}
@Controller()
class API {
  constructor(
    @Inject(Store) private readonly store: Store,
    @Inject(Sessions) private readonly sessions: Sessions,
  ) {}
  @Get("health") health() {
    return { status: "ok", mode: "local-demo", protocol: 1 };
  }
  @Post("demo/session") session(@Body() body: any) {
    return this.sessions.create(stringField(body?.profile, "profile", 20));
  }
  @Post("session/logout") logout(@Req() req: FastifyRequest) {
    this.sessions.entries.delete(req.headers.authorization?.replace(/^Bearer /, "") || "");
    return { ok: true };
  }
  @Get("snapshot") snapshot(@Req() req: FastifyRequest) {
    return this.store.snapshot(this.sessions.get(req, "vehicle.read"));
  }
  @Post("enrollments") enroll(@Req() req: FastifyRequest, @Body() body: any) {
    const p = this.sessions.get(req, "enrollment.write");
    const format = body?.format ?? "epc";
    if (!["epc", "wiegand26", "wiegand34"].includes(format))
      throw new BadRequestException("Invalid credential format.");
    const value = stringField(body?.value, "credential", 64).toUpperCase();
    if (
      !/^[0-9A-F]+$/.test(value) ||
      (format === "epc" && value.length % 2 !== 0) ||
      (format === "wiegand26" && value.length !== 6) ||
      (format === "wiegand34" && value.length !== 8)
    )
      throw new BadRequestException("Credential must match the selected format.");
    return this.store.enroll(p, {
      resident: stringField(body?.resident, "resident"),
      property: stringField(body?.property, "property"),
      plate: stringField(body?.plate, "plate", 20).toUpperCase(),
      make: stringField(body?.make, "make", 60),
      color: stringField(body?.color, "color", 40),
      format,
      value,
    });
  }
  @Post("credentials/:id/status") status(
    @Req() req: FastifyRequest,
    @Param("id") id: string,
    @Body() body: any,
  ) {
    const p = this.sessions.get(req);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new BadRequestException("Invalid credential id.");
    if (!["active", "suspended", "lost", "revoked"].includes(body?.status))
      throw new BadRequestException("Invalid status.");
    if (p.role === "resident" && body.status !== "lost") throw new ForbiddenException();
    if (p.role !== "resident" && !can(p.role, "credential.manage")) throw new ForbiddenException();
    return this.store
      .status(p, id, body.status)
      .then(() => ({ ok: true, delivery: "pending_edge_acknowledgement" }));
  }
  @Get("edge/v1/configuration") config(@Req() req: FastifyRequest) {
    this.sessions.edge(req);
    return this.store.configuration();
  }
  @Post("edge/v1/events") events(@Req() req: FastifyRequest, @Body() body: any) {
    this.sessions.edge(req);
    if (
      !Array.isArray(body?.events) ||
      body.events.length > 100 ||
      !body.events.length ||
      body.events.some((e: unknown) => !validateProtocol("access-event", e))
    )
      throw new BadRequestException("Invalid event batch.");
    return this.store.ingest(body.events as AccessEvent[]);
  }
  @Post("edge/v1/heartbeat") heartbeat(@Req() req: FastifyRequest, @Body() body: any) {
    this.sessions.edge(req);
    if (!validateProtocol("heartbeat", body)) throw new BadRequestException("Invalid heartbeat.");
    return this.store.heartbeat(body);
  }
}
@Module({ controllers: [API], providers: [Store, Sessions] })
class AppModule {}
export async function createApp(options: { test?: boolean; logger?: boolean } = {}) {
  if (
    !options.test &&
    (process.env.SMARTGATE_DEMO !== "true" || process.env.NODE_ENV === "production")
  )
    throw new Error("This prototype requires SMARTGATE_DEMO=true and refuses production mode.");
  const adapter = new FastifyAdapter({ bodyLimit: 256 * 1024 });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: options.logger ? ["error", "warn", "log"] : false,
  });
  const allowed = new Set(
    [3000, 3001, 3002, 4200].flatMap((p) => ["http://127.0.0.1:" + p, "http://localhost:" + p]),
  );
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  adapter.getInstance().addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host || "").split(":")[0] ?? "";
    if (!["localhost", "127.0.0.1"].includes(host))
      return reply.code(403).send({ message: "Local prototype only" });
    if (req.headers.origin && !allowed.has(req.headers.origin))
      return reply.code(403).send({ message: "Origin not allowed" });
  });
  const store = app.get(Store);
  await store.start(options.test);
  await app.init();
  await adapter.getInstance().ready();
  return { app, store };
}
