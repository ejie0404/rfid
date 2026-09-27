/**
 * Customer onboarding in real mode: a platform administrator creates a village, then invites its
 * first HOA administrator. Nothing here depends on demonstration data, so this is the path a
 * hosted staging or pilot environment uses.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createApp } from "../apps/api/dist/app.js";

const PASSWORD = "correct-horse-battery-staple";
const OPERATOR_EMAIL = "operator@onboarding.example";
let app, store, identity;
const state = {};
const call = (method, url, body, token) =>
  app.inject({
    method,
    url,
    headers: { host: "localhost", ...(token ? { authorization: "Bearer " + token } : {}) },
    ...(body === undefined ? {} : { payload: body }),
  });
async function signIn(email) {
  const response = await call("POST", "/auth/login", { email, password: PASSWORD });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
const organizationCount = async () =>
  (await store.query("SELECT count(*)::int AS count FROM organizations")).rows[0].count;
const createVillage = (name, token = state.operatorToken) =>
  call("POST", "/platform/organizations", name === undefined ? {} : { name }, token);

before(async () => {
  ({ app, store, identity } = await createApp({ test: true, demo: false }));
  const operator = await identity.createOperator({
    email: OPERATOR_EMAIL,
    name: "Onboarding operator",
    password: PASSWORD,
  });
  state.operatorId = operator.user_id;
  state.operatorToken = (await signIn(OPERATOR_EMAIL)).token;
});
after(async () => {
  await app?.close();
  await store?.close();
});

test("a platform administrator creates a village and onboards its first administrator", async () => {
  const created = await createVillage("  Palm   Grove Village ");
  assert.equal(created.statusCode, 201, created.body);
  const village = created.json();
  assert.match(village.id, /^[0-9a-f-]{36}$/);
  const expected = {
    id: village.id,
    name: "Palm Grove Village",
    config_version: 1,
    members: 0,
    properties: 0,
  };
  assert.deepEqual(village, expected, "surrounding and repeated spaces are normalized");

  const listing = await call("GET", "/platform/organizations", undefined, state.operatorToken);
  assert.equal(listing.statusCode, 200);
  assert.deepEqual(
    listing.json().find((row) => row.id === village.id),
    expected,
  );

  const audit = (
    await store.query(
      "SELECT action,actor_id,entity_id,detail FROM audit_events WHERE organization_id=$1",
      [village.id],
    )
  ).rows;
  assert.equal(audit.length, 1, "creating the village records one audit event");
  assert.equal(audit[0].action, "organization.created");
  assert.equal(audit[0].actor_id, state.operatorId);
  assert.equal(audit[0].entity_id, village.id);
  const detail =
    typeof audit[0].detail === "string" ? JSON.parse(audit[0].detail) : audit[0].detail;
  assert.deepEqual(detail, { name: "Palm Grove Village" });

  const invitation = await call(
    "POST",
    "/invitations",
    { email: "first-admin@onboarding.example", role: "hoa_admin", organization_id: village.id },
    state.operatorToken,
  );
  assert.equal(invitation.statusCode, 201, invitation.body);
  assert.equal(invitation.json().organization_id, village.id);
  const accepted = await call("POST", "/auth/invitations/accept", {
    token: invitation.json().token,
    name: "First administrator",
    password: PASSWORD,
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(accepted.json().principal.organizationId, village.id);
  assert.equal(accepted.json().principal.role, "hoa_admin");
  state.villageId = village.id;
  state.adminToken = accepted.json().token;

  const snapshot = await call("GET", "/snapshot", undefined, state.adminToken);
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.equal(snapshot.json().organization.name, "Palm Grove Village");
  const after = await call("GET", "/platform/organizations", undefined, state.operatorToken);
  assert.equal(after.json().find((row) => row.id === village.id).members, 1);
});

test("only a platform administrator outside support access can create a village", async () => {
  const before = await organizationCount();
  assert.equal((await createVillage("Anonymous Village", null)).statusCode, 401);
  assert.equal(
    (await createVillage("Customer Village", state.adminToken)).statusCode,
    403,
    "a village administrator cannot create other customers",
  );

  await identity.createUser({
    email: "support@onboarding.example",
    name: "Platform support",
    password: PASSWORD,
    platformRole: "platform_support",
  });
  const support = await signIn("support@onboarding.example");
  assert.equal(
    (await call("GET", "/platform/organizations", undefined, support.token)).statusCode,
    200,
    "platform support can read the customer list",
  );
  assert.equal((await createVillage("Support Village", support.token)).statusCode, 403);

  const grant = await call(
    "POST",
    `/platform/organizations/${state.villageId}/support-access`,
    { reason: "Check the first administrator's onboarding", minutes: 15 },
    state.operatorToken,
  );
  assert.equal(grant.statusCode, 201, grant.body);
  const scoped = await call(
    "POST",
    "/auth/scope",
    { organization_id: state.villageId },
    state.operatorToken,
  );
  assert.equal(scoped.statusCode, 201, scoped.body);
  const refused = await createVillage("Support Session Village", scoped.json().token);
  assert.equal(refused.statusCode, 403, "a support session stays read-only");
  assert.match(refused.json().message, /read-only/);
  assert.equal(await organizationCount(), before);

  // Entering support scope replaced the operator's platform session, so sign in again.
  state.operatorToken = (await signIn(OPERATOR_EMAIL)).token;
});

test("village names are validated and repeated submissions create one village", async () => {
  const before = await organizationCount();
  for (const name of [undefined, "", "   ", 42, "x".repeat(101)])
    assert.equal((await createVillage(name)).statusCode, 400, `name ${JSON.stringify(name)}`);

  const duplicate = await createVillage("palm grove   VILLAGE");
  assert.equal(duplicate.statusCode, 409, "names are compared without case or spacing");
  assert.match(duplicate.json().message, /already exists/);
  assert.equal(await organizationCount(), before);

  // A double-clicked form creates one village.
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => createVillage("Cedar Heights")),
  );
  assert.deepEqual(
    attempts.map((response) => response.statusCode).sort(),
    [201, 409, 409, 409, 409],
  );
  assert.equal(await organizationCount(), before + 1);
});

// PGlite runs one transaction at a time, so only real PostgreSQL can hold two submissions at the
// check-then-insert step together. Holding the creation lock from outside makes that deterministic.
test(
  "concurrent submissions of one village name are serialized by PostgreSQL",
  { skip: process.env.SMARTGATE_TEST_POSTGRES !== "true", timeout: 20_000 },
  async () => {
    const lockKey = [0x5347, 0x4f52];
    const before = await organizationCount();
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    let held = false;
    try {
      await holder.query("SELECT pg_advisory_lock($1, $2)", lockKey);
      held = true;
      const attempts = [createVillage("Mango Grove"), createVillage("mango   GROVE")];
      let waiting = 0;
      for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        waiting = (
          await holder.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND wait_event_type='Lock' AND wait_event='advisory'",
          )
        ).rows[0].count;
        if (waiting >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(waiting, 2, "both submissions wait at the village-creation lock");
      await holder.query("SELECT pg_advisory_unlock($1, $2)", lockKey);
      held = false;
      const statuses = (await Promise.all(attempts)).map((response) => response.statusCode);
      assert.deepEqual(statuses.sort(), [201, 409]);
      assert.equal(await organizationCount(), before + 1);
    } finally {
      if (held) await holder.query("SELECT pg_advisory_unlock($1, $2)", lockKey).catch(() => {});
      await holder.end();
    }
  },
);
