import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Store } from "./store.js";
import { Identity } from "./identity.js";
import { Sessions } from "./session.js";
import { controllers } from "./routes.js";

export interface CreateOptions {
  test?: boolean;
  logger?: boolean;
  /** Demonstration mode seeds the fictional village and enables the demo sign-in shortcut. */
  demo?: boolean;
}
function buildModule(store: Store, identity: Identity, sessions: Sessions) {
  @Module({
    controllers,
    providers: [
      { provide: Store, useValue: store },
      { provide: Identity, useValue: identity },
      { provide: Sessions, useValue: sessions },
    ],
  })
  class AppModule {}
  return AppModule;
}
export async function createApp(options: CreateOptions = {}) {
  // The deployment boundary is unchanged: this repository still refuses production mode and
  // binds loopback only. A real deployment is a separate, reviewed release.
  if (!options.test && process.env.NODE_ENV === "production")
    throw new Error("This prototype refuses production mode. Use a reviewed deployment.");
  const demo = options.demo ?? (options.test ? true : process.env.SMARTGATE_DEMO === "true");
  const store = new Store();
  const identity = new Identity(store);
  const sessions = new Sessions(identity);
  const adapter = new FastifyAdapter({ bodyLimit: 256 * 1024 });
  const app = await NestFactory.create<NestFastifyApplication>(
    buildModule(store, identity, sessions),
    adapter,
    { logger: options.logger ? ["error", "warn", "log"] : false },
  );
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
  await store.start({
    test: options.test,
    demo,
    // A test run is throwaway state by default; pointing it at a real server is explicit.
    memory: options.test === true && process.env.SMARTGATE_TEST_POSTGRES !== "true",
  });
  await app.init();
  await adapter.getInstance().ready();
  return { app, store, identity, sessions, demo };
}
