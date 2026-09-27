import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Store } from "./store.js";
import { Identity } from "./identity.js";
import { Sessions } from "./session.js";
import { controllers } from "./routes.js";
import {
  createTrustedProxyMatcher,
  loadRuntimeConfig,
  normalizeRequestHost,
} from "./runtime-config.js";
import { attemptRule, RequestAttemptLimiter } from "./request-limiter.js";

export interface CreateOptions {
  test?: boolean;
  logger?: boolean;
  /** Demonstration mode seeds the fictional village and enables the demo sign-in shortcut. */
  demo?: boolean;
  /**
   * Turns on the privileged-account MFA policy for this app. It can only add the requirement;
   * production always enforces it. Demonstration mode never does, because its accounts are shared.
   */
  requirePrivilegedMfa?: boolean;
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
  const config = loadRuntimeConfig(process.env, { test: options.test });
  if (config.production && options.demo !== undefined)
    throw new Error(
      "Invalid SmartGate runtime configuration: production demo mode is controlled by SMARTGATE_DEMO.",
    );
  const demo = options.demo ?? (options.test ? true : config.demo);
  const store = new Store();
  const identity = new Identity(store, {
    requirePrivilegedMfa:
      !demo && (config.requirePrivilegedMfa || options.requirePrivilegedMfa === true),
  });
  const sessions = new Sessions(identity);
  // One address check decides both client-IP attribution and forwarded-Host acceptance.
  const isTrustedProxy = createTrustedProxyMatcher(config.trustedProxies);
  const adapter = new FastifyAdapter({
    bodyLimit: 256 * 1024,
    trustProxy: config.trustedProxies.length ? isTrustedProxy : false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    buildModule(store, identity, sessions),
    adapter,
    { logger: options.logger ? ["error", "warn", "log"] : false },
  );
  const allowedOrigins = new Set(config.allowedOrigins);
  const allowedHosts = new Set(config.allowedHosts);
  const attemptLimiter = new RequestAttemptLimiter();
  app.enableCors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  });
  adapter.getInstance().addHook("onRequest", async (req, reply) => {
    const forwardedHost = req.headers["x-forwarded-host"];
    const hostHeader =
      isTrustedProxy(req.raw.socket.remoteAddress) && typeof forwardedHost === "string"
        ? forwardedHost
        : req.headers.host;
    const host = normalizeRequestHost(hostHeader);
    if (!host || !allowedHosts.has(host))
      return reply.code(403).send({ message: "Host not allowed" });
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
      return reply.code(403).send({ message: "Origin not allowed" });
    // Routing has already run, so throttle the handler the router selected. Percent-encoded or
    // otherwise equivalent spellings of a path reach that handler and must share its limit.
    const rule = attemptRule(req.method, req.routeOptions.url);
    if (rule) {
      const decision = attemptLimiter.take(`${rule.name}:${req.ip}`, rule.maximum, rule.windowMs);
      if (!decision.allowed)
        return reply
          .header("Retry-After", String(decision.retryAfterSeconds))
          .code(429)
          .send({ message: "Too many attempts. Try again later." });
    }
  });
  await store.start({
    test: options.test,
    demo,
    // A test run is throwaway state by default; pointing it at a real server is explicit.
    memory: options.test === true && process.env.SMARTGATE_TEST_POSTGRES !== "true",
  });
  await app.init();
  await adapter.getInstance().ready();
  return { app, store, identity, sessions, demo, config };
}
