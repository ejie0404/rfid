/**
 * Privileged-account MFA policy: platform staff and village administrators must enroll an
 * authenticator before their session can do anything except finish enrollment. Guards and
 * residents are unaffected, demonstration mode never enforces it, and production cannot disable it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../apps/api/dist/app.js";
import { totpCode } from "../apps/api/dist/crypto.js";
import { loadRuntimeConfig } from "../apps/api/dist/runtime-config.js";

const PASSWORD = "correct-horse-battery-staple";
const OPERATOR_EMAIL = "operator@mfa-policy.example";
let app, store, identity;
const state = {};
const call = (method, url, body, token) =>
  app.inject({
    method,
    url,
    headers: { host: "localhost", ...(token ? { authorization: "Bearer " + token } : {}) },
    ...(body === undefined ? {} : { payload: body }),
  });
const assertSetupRequired = (response, label) => {
  assert.equal(response.statusCode, 403, `${label}: ${response.body}`);
  assert.equal(response.json().code, "MFA_SETUP_REQUIRED", label);
};
async function enroll(token) {
  const started = await call("POST", "/auth/mfa/enroll", undefined, token);
  assert.equal(started.statusCode, 201, started.body);
  const secret = started.json().secret;
  const confirmed = await call("POST", "/auth/mfa/confirm", { code: totpCode(secret) }, token);
  assert.equal(confirmed.statusCode, 201, confirmed.body);
  return secret;
}

before(async () => {
  ({ app, store, identity } = await createApp({
    test: true,
    demo: false,
    requirePrivilegedMfa: true,
  }));
  await identity.createOperator({ email: OPERATOR_EMAIL, name: "Operator", password: PASSWORD });
});
after(async () => {
  await app?.close();
  await store?.close();
});

test("a platform administrator without MFA can only reach account setup routes", async () => {
  const login = await call("POST", "/auth/login", { email: OPERATOR_EMAIL, password: PASSWORD });
  assert.equal(login.statusCode, 201, login.body);
  assert.equal(login.json().mfa_setup_required, true);
  const token = login.json().token;

  assertSetupRequired(
    await call("GET", "/platform/organizations", undefined, token),
    "customer list",
  );
  assertSetupRequired(
    await call("POST", "/platform/organizations", { name: "Early Village" }, token),
    "village creation",
  );
  const session = await call("GET", "/auth/session", undefined, token);
  assert.equal(session.statusCode, 200, session.body);
  assert.equal(session.json().mfa_setup_required, true);
  assert.equal((await call("GET", "/auth/sessions", undefined, token)).statusCode, 200);

  const secret = await enroll(token);
  const after = await call("GET", "/auth/session", undefined, token);
  assert.equal(after.json().mfa_setup_required, false, "the enrolling session is now verified");
  assert.equal((await call("GET", "/platform/organizations", undefined, token)).statusCode, 200);
  state.operatorToken = token;
  state.operatorSecret = secret;

  const again = await call("POST", "/auth/login", { email: OPERATOR_EMAIL, password: PASSWORD });
  assert.equal(again.json().mfa_required, true, "later sign-ins need a code");
  assert.equal(again.json().token, undefined);
});

test("a new village administrator must enroll before managing the village", async () => {
  const village = await call(
    "POST",
    "/platform/organizations",
    { name: "Policy Village" },
    state.operatorToken,
  );
  assert.equal(village.statusCode, 201, village.body);
  const invitation = await call(
    "POST",
    "/invitations",
    { email: "admin@mfa-policy.example", role: "hoa_admin", organization_id: village.json().id },
    state.operatorToken,
  );
  assert.equal(invitation.statusCode, 201, invitation.body);
  const accepted = await call("POST", "/auth/invitations/accept", {
    token: invitation.json().token,
    name: "Village administrator",
    password: PASSWORD,
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json().principal.role, "hoa_admin");
  assert.equal(accepted.json().mfa_setup_required, true);
  const token = accepted.json().token;

  assertSetupRequired(await call("GET", "/snapshot", undefined, token), "village snapshot");
  assertSetupRequired(
    await call("POST", "/sites", { name: "Main gate", code: "MAIN" }, token),
    "site creation",
  );
  const sites = await store.query("SELECT count(*)::int AS count FROM sites");
  assert.equal(sites.rows[0].count, 0, "a refused request changes nothing");

  await enroll(token);
  assert.equal((await call("GET", "/snapshot", undefined, token)).statusCode, 200);
  const site = await call("POST", "/sites", { name: "Main gate", code: "MAIN" }, token);
  assert.equal(site.statusCode, 201, site.body);
  state.adminToken = token;
  state.siteId = site.json().site_id;
});

test("a guard is not required to enroll MFA", async () => {
  const invitation = await call(
    "POST",
    "/invitations",
    { email: "guard@mfa-policy.example", role: "guard", site_id: state.siteId },
    state.adminToken,
  );
  assert.equal(invitation.statusCode, 201, invitation.body);
  const accepted = await call("POST", "/auth/invitations/accept", {
    token: invitation.json().token,
    name: "Gate guard",
    password: PASSWORD,
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json().principal.role, "guard");
  assert.equal(accepted.json().mfa_setup_required, false);
  const snapshot = await call("GET", "/snapshot", undefined, accepted.json().token);
  assert.equal(snapshot.statusCode, 200, snapshot.body);
});

test("demonstration mode never enforces the policy on its shared accounts", async () => {
  const demo = await createApp({ test: true, demo: true, requirePrivilegedMfa: true });
  try {
    const session = await demo.app.inject({
      method: "POST",
      url: "/demo/session",
      headers: { host: "localhost" },
      payload: { profile: "admin" },
    });
    assert.equal(session.statusCode, 201, session.body);
    assert.equal(session.json().mfa_setup_required, false);
    const snapshot = await demo.app.inject({
      method: "GET",
      url: "/snapshot",
      headers: { host: "localhost", authorization: "Bearer " + session.json().token },
    });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
  } finally {
    await demo.app.close();
    await demo.store.close();
  }
});

test("production always requires privileged MFA and refuses to disable it", () => {
  const production = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://smartgate:secret@db.example.test:5432/smartgate",
    SMARTGATE_DEMO: "false",
    SMARTGATE_SKIP_MIGRATIONS: "true",
    HOST: "0.0.0.0",
    SMARTGATE_ALLOWED_ORIGINS: "https://control.example.test",
    SMARTGATE_ALLOWED_HOSTS: "api.example.test",
  };
  assert.equal(loadRuntimeConfig(production).requirePrivilegedMfa, true);
  assert.equal(
    loadRuntimeConfig({ ...production, SMARTGATE_REQUIRE_PRIVILEGED_MFA: "true" })
      .requirePrivilegedMfa,
    true,
  );
  assert.throws(
    () => loadRuntimeConfig({ ...production, SMARTGATE_REQUIRE_PRIVILEGED_MFA: "false" }),
    /cannot be disabled in production/,
  );
  assert.equal(loadRuntimeConfig({}).requirePrivilegedMfa, false, "optional in development");
  assert.equal(
    loadRuntimeConfig({ SMARTGATE_REQUIRE_PRIVILEGED_MFA: "true" }).requirePrivilegedMfa,
    true,
  );
  assert.throws(
    () => loadRuntimeConfig({ SMARTGATE_REQUIRE_PRIVILEGED_MFA: "yes" }),
    /either true or false/,
  );
});
