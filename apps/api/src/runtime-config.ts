import { BlockList, isIP } from "node:net";

const LOCAL_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:3001",
  "http://localhost:3001",
  "http://127.0.0.1:3002",
  "http://localhost:3002",
  "http://127.0.0.1:4200",
  "http://localhost:4200",
];
const LOCAL_HOSTS = ["127.0.0.1", "localhost"];

export interface RuntimeConfig {
  production: boolean;
  demo: boolean;
  host: string;
  port: number;
  allowedOrigins: readonly string[];
  allowedHosts: readonly string[];
  trustedProxies: readonly string[];
  /** Privileged roles must enroll MFA before acting. Always on in production. */
  requirePrivilegedMfa: boolean;
}

function fail(message: string): never {
  throw new Error("Invalid SmartGate runtime configuration: " + message);
}

function csv(value: string | undefined, name: string): string[] {
  if (value === undefined || value.trim() === "") return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry))
    fail(`${name} must be a comma-separated list without empty entries.`);
  if (new Set(entries).size !== entries.length) fail(`${name} must not contain duplicates.`);
  return entries;
}

function normalizeOrigin(value: string, production: boolean): string {
  if (value.includes("*"))
    return fail("SMARTGATE_ALLOWED_ORIGINS must contain exact origins without wildcards.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("SMARTGATE_ALLOWED_ORIGINS contains an invalid origin.");
  }
  if (
    value !== url.origin ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return fail(
      "SMARTGATE_ALLOWED_ORIGINS must contain exact origins without paths, credentials, or wildcards.",
    );
  if (production && url.protocol !== "https:")
    return fail("SMARTGATE_ALLOWED_ORIGINS must use HTTPS in production.");
  if (
    !production &&
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return fail("HTTP origins are allowed only for local development.");
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return fail("SMARTGATE_ALLOWED_ORIGINS must use HTTP or HTTPS.");
  return url.origin;
}

function normalizeAllowedHost(value: string): string {
  if (value.includes("*") || value.includes(","))
    return fail("SMARTGATE_ALLOWED_HOSTS must contain exact host names, not wildcards.");
  let url: URL;
  try {
    url = new URL("http://" + value);
  } catch {
    return fail("SMARTGATE_ALLOWED_HOSTS contains an invalid host.");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.host.toLowerCase() !== value.toLowerCase()
  )
    return fail("SMARTGATE_ALLOWED_HOSTS must contain exact host names with an optional port.");
  return url.host.toLowerCase();
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 4100;
  if (!/^\d+$/.test(value)) return fail("PORT must be an integer between 1 and 65535.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    return fail("PORT must be an integer between 1 and 65535.");
  return port;
}

function parseBindHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (/[:/\\\s]/.test(host) && isIP(host) === 0)
    return fail("HOST must be a bind host name or IP address without a port.");
  if (
    isIP(host) === 0 &&
    !/^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
      host,
    )
  )
    return fail("HOST must be a valid bind host name or IP address.");
  return host;
}

function parseDatabaseUrl(value: string | undefined): void {
  if (!value) fail("DATABASE_URL is required in production.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    fail("DATABASE_URL must point to an external PostgreSQL database.");
}

function parseTrustedProxies(value: string | undefined): string[] {
  const proxies = csv(value, "SMARTGATE_TRUSTED_PROXIES");
  for (const address of proxies) {
    if (isIP(address) === 0)
      fail("SMARTGATE_TRUSTED_PROXIES accepts individual IP addresses only.");
  }
  return proxies;
}

const addressFamily = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4");

/**
 * Matches a peer address against the configured proxies by parsed value, not text. IPv4 and
 * IPv4-mapped IPv6, compressed and expanded IPv6, and letter case compare equal. The deprecated
 * IPv4-compatible form (`::a.b.c.d`) is a distinct address and does not match. The API uses this
 * one check for Fastify's `trustProxy` and for forwarded-Host acceptance, so they cannot disagree.
 */
export function createTrustedProxyMatcher(
  addresses: readonly string[],
): (address: string | undefined) => boolean {
  const trusted = new BlockList();
  for (const address of addresses) trusted.addAddress(address, addressFamily(address));
  return (address) =>
    !!address && isIP(address) !== 0 && trusted.check(address, addressFamily(address));
}

export function normalizeRequestHost(value: string | undefined): string | undefined {
  if (!value || value.includes(",") || value.includes("*") || /[\s/@\\]/.test(value))
    return undefined;
  try {
    const host = new URL("http://" + value);
    if (
      host.username ||
      host.password ||
      host.pathname !== "/" ||
      host.search ||
      host.hash ||
      host.host.toLowerCase() !== value.toLowerCase()
    )
      return undefined;
    return host.host.toLowerCase();
  } catch {
    return undefined;
  }
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { test?: boolean } = {},
): RuntimeConfig {
  const production = env.NODE_ENV === "production" && options.test !== true;
  const demoValue = env.SMARTGATE_DEMO;
  if (demoValue !== undefined && demoValue !== "true" && demoValue !== "false")
    fail("SMARTGATE_DEMO must be either true or false.");
  const demo = demoValue === "true";
  const mfaValue = env.SMARTGATE_REQUIRE_PRIVILEGED_MFA;
  if (mfaValue !== undefined && mfaValue !== "true" && mfaValue !== "false")
    fail("SMARTGATE_REQUIRE_PRIVILEGED_MFA must be either true or false.");

  if (production) {
    parseDatabaseUrl(env.DATABASE_URL);
    if (demoValue !== "false")
      fail("SMARTGATE_DEMO must be explicitly set to false in production.");
    if (mfaValue === "false")
      fail("SMARTGATE_REQUIRE_PRIVILEGED_MFA cannot be disabled in production.");
    if (env.SMARTGATE_SKIP_MIGRATIONS !== "true")
      fail(
        "SMARTGATE_SKIP_MIGRATIONS must be true in production; migrate with the migration role first.",
      );
    if (!env.HOST?.trim()) fail("HOST must be explicitly set in production.");
    if (!env.SMARTGATE_ALLOWED_ORIGINS?.trim())
      fail("SMARTGATE_ALLOWED_ORIGINS must list the exact production frontend origins.");
    if (!env.SMARTGATE_ALLOWED_HOSTS?.trim())
      fail("SMARTGATE_ALLOWED_HOSTS must list the exact public API host names.");
  }

  const host = parseBindHost(env.HOST);
  const port = parsePort(env.PORT);
  const origins = csv(env.SMARTGATE_ALLOWED_ORIGINS, "SMARTGATE_ALLOWED_ORIGINS");
  const allowedOrigins = (origins.length ? origins : LOCAL_ORIGINS).map((origin) =>
    normalizeOrigin(origin, production),
  );
  const hosts = csv(env.SMARTGATE_ALLOWED_HOSTS, "SMARTGATE_ALLOWED_HOSTS");
  const localHosts = LOCAL_HOSTS.flatMap((localHost) => [localHost, `${localHost}:${port}`]);
  const allowedHosts = (hosts.length ? hosts : localHosts).map(normalizeAllowedHost);
  const trustedProxies = parseTrustedProxies(env.SMARTGATE_TRUSTED_PROXIES);

  if (production && (!allowedOrigins.length || !allowedHosts.length))
    fail("production requires at least one allowed origin and host.");

  const requirePrivilegedMfa = production || mfaValue === "true";
  return {
    production,
    demo,
    host,
    port,
    allowedOrigins,
    allowedHosts,
    trustedProxies,
    requirePrivilegedMfa,
  };
}
