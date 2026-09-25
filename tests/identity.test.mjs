/**
 * Step 2 acceptance checks: real authentication, organization membership, and tenant scope.
 *
 * These run against a real-mode application (no demonstration seed, no demonstration sign-in)
 * because the demonstration shortcut must not be able to reach anything these tests do not.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import { totpCode } from "../apps/api/dist/crypto.js";

let app, store;
const PASSWORD = "correct-horse-battery";
const state = {};
const call = (method, url, body, token) =>
  app.inject({
    method,
    url,
    headers: { host: "localhost", ...(token ? { authorization: "Bearer " + token } : {}) },
    ...(body === undefined ? {} : { payload: body }),
  });
async function seedVehicle(organization, property, plate, value) {
  const vehicle = randomUUID(),
    credential = randomUUID();
  await store.query(
    "INSERT INTO vehicles(id,organization_id,property_id,plate,make,color) VALUES($1,$2,$3,$4,'Toyota','White')",
    [vehicle, organization, property, plate],
  );
  await store.query(
    "INSERT INTO credentials(id,organization_id,format,value,status,valid_from) VALUES($1,$2,'epc',$3,'active',now())",
    [credential, organization, value],
  );
  await store.query(
    "INSERT INTO assignments(id,organization_id,credential_id,vehicle_id) VALUES($1,$2,$3,$4)",
    [randomUUID(), organization, credential, vehicle],
  );
  return { vehicle, credential };
}
async function inviteAndAccept(input, adminToken, password = PASSWORD) {
  const invitation = await call("POST", "/invitations", input, adminToken);
  assert.equal(invitation.statusCode, 201, invitation.body);
  const accepted = await call("POST", "/auth/invitations/accept", {
    token: invitation.json().token,
    name: input.name ?? "Invited member",
    password,
  });
  assert.equal(accepted.statusCode, 201, accepted.body);
  return { invitation: invitation.json(), session: accepted.json() };
}

before(async () => {
  process.env.SMARTGATE_SETUP_TOKEN = "one-time-setup-token";
  ({ app, store } = await createApp({ test: true, demo: false }));
});
after(async () => {
  await app?.close();
  await store?.close();
});

test("real mode refuses the demonstration shortcut and starts with no data", async () => {
  assert.equal((await call("POST", "/demo/session", { profile: "admin" })).statusCode, 400);
  const organizations = await store.query("SELECT count(*)::int AS count FROM organizations");
  assert.equal(organizations.rows[0].count, 0);
  const users = await store.query("SELECT count(*)::int AS count FROM users");
  assert.equal(users.rows[0].count, 0);
  const status = await call("GET", "/setup/status");
  assert.equal(status.json().demo, false);
  assert.equal(status.json().operator_configured, false);
});

test("the first platform administrator needs the operator token and cannot be created twice", async () => {
  const unauthorized = await call("POST", "/setup/operator", {
    token: "wrong-token",
    email: "ops@example.com",
    name: "Operations",
    password: PASSWORD,
  });
  assert.equal(unauthorized.statusCode, 401);
  const created = await call("POST", "/setup/operator", {
    token: "one-time-setup-token",
    email: "ops@example.com",
    name: "Operations",
    password: PASSWORD,
  });
  assert.equal(created.statusCode, 201, created.body);
  const second = await call("POST", "/setup/operator", {
    token: "one-time-setup-token",
    email: "second@example.com",
    name: "Second operator",
    password: PASSWORD,
  });
  assert.equal(second.statusCode, 409);
  const weak = await call("POST", "/auth/login", {
    email: "ops@example.com",
    password: "short",
  });
  assert.equal(weak.statusCode, 401);
  const login = await call("POST", "/auth/login", {
    email: "ops@example.com",
    password: PASSWORD,
  });
  assert.equal(login.statusCode, 201, login.body);
  state.platformToken = login.json().token;
  assert.equal(login.json().principal.organizationId, null);
  assert.equal(login.json().platform_role, "platform_admin");
});

test("two villages operate simultaneously and cannot read or change each other", async () => {
  state.orgA = randomUUID();
  state.orgB = randomUUID();
  await store.query("INSERT INTO organizations(id,name) VALUES($1,'Village A'),($2,'Village B')", [
    state.orgA,
    state.orgB,
  ]);
  state.propertyA1 = randomUUID();
  state.propertyA2 = randomUUID();
  state.propertyB = randomUUID();
  for (const [property, organization, label, resident] of [
    [state.propertyA1, state.orgA, "Lot 1", "Resident One"],
    [state.propertyA2, state.orgA, "Lot 2", "Resident Two"],
    [state.propertyB, state.orgB, "Lot 9", "Resident Nine"],
  ])
    await store.query(
      "INSERT INTO properties(id,organization_id,label,resident_name) VALUES($1,$2,$3,$4)",
      [property, organization, label, resident],
    );
  state.vehicleA1 = await seedVehicle(state.orgA, state.propertyA1, "AAA 1111", "AA11");
  await seedVehicle(state.orgA, state.propertyA2, "BBB 2222", "BB22");
  await seedVehicle(state.orgB, state.propertyB, "CCC 3333", "CC33");

  // A platform administrator onboards each customer's first HOA administrator.
  const adminA = await inviteAndAccept(
    { email: "hoa-a@example.com", role: "hoa_admin", organization_id: state.orgA },
    state.platformToken,
  );
  const adminB = await inviteAndAccept(
    { email: "hoa-b@example.com", role: "hoa_admin", organization_id: state.orgB },
    state.platformToken,
  );
  state.adminAToken = adminA.session.token;
  state.adminBToken = adminB.session.token;
  assert.equal(adminA.session.principal.organizationId, state.orgA);
  assert.equal(adminA.session.principal.role, "hoa_admin");

  // A platform administrator may only onboard an HOA administrator, never a household member.
  const overreach = await call(
    "POST",
    "/invitations",
    {
      email: "resident@example.com",
      role: "resident",
      property_id: state.propertyA1,
      organization_id: state.orgA,
    },
    state.platformToken,
  );
  assert.equal(overreach.statusCode, 403);

  const snapshotA = await call("GET", "/snapshot", undefined, state.adminAToken);
  const snapshotB = await call("GET", "/snapshot", undefined, state.adminBToken);
  assert.equal(snapshotA.json().organization.id, state.orgA);
  assert.equal(snapshotB.json().organization.id, state.orgB);
  assert.equal(snapshotA.json().vehicles.length, 2);
  assert.equal(snapshotB.json().vehicles.length, 1);
  assert.equal(
    snapshotA.json().vehicles.some((v) => v.plate === "CCC 3333"),
    false,
  );

  // Cross-village mutation is not found rather than forbidden, so existence is not disclosed.
  const crossVillage = await call(
    "POST",
    "/credentials/" + state.vehicleA1.credential + "/status",
    { status: "suspended" },
    state.adminBToken,
  );
  assert.equal(crossVillage.statusCode, 404);
  // A sameness check: the owning village can do it.
  assert.equal(
    (
      await call(
        "POST",
        "/credentials/" + state.vehicleA1.credential + "/status",
        { status: "suspended" },
        state.adminAToken,
      )
    ).statusCode,
    201,
  );
});

test("guards read their assigned station but cannot perform HOA administration", async () => {
  state.site = randomUUID();
  await store.query(
    "INSERT INTO sites(id,organization_id,name,code) VALUES($1,$2,'Main entrance','MAIN')",
    [state.site, state.orgA],
  );
  const guard = await inviteAndAccept(
    { email: "guard-a@example.com", role: "guard", site_id: state.site },
    state.adminAToken,
  );
  state.guardToken = guard.session.token;
  assert.deepEqual(guard.session.principal.sites, [state.site]);
  assert.equal(guard.session.principal.role, "guard");

  assert.equal(
    (
      await call(
        "POST",
        "/enrollments",
        {
          resident: "Someone",
          property: "Lot 3",
          plate: "DDD 4444",
          make: "Honda",
          color: "Blue",
          format: "epc",
          value: "DD44",
        },
        state.guardToken,
      )
    ).statusCode,
    403,
  );
  assert.equal((await call("GET", "/invitations", undefined, state.guardToken)).statusCode, 403);
  assert.equal((await call("GET", "/memberships", undefined, state.guardToken)).statusCode, 403);
  assert.equal((await call("GET", "/audit", undefined, state.guardToken)).statusCode, 403);
  assert.equal(
    (
      await call(
        "POST",
        "/invitations",
        { email: "x@example.com", role: "resident", property_id: state.propertyA1 },
        state.guardToken,
      )
    ).statusCode,
    403,
  );
  // A guard may still look up vehicles and activity for the site they are on duty at.
  assert.equal((await call("GET", "/snapshot", undefined, state.guardToken)).statusCode, 200);

  // The guard invitation must be bound to a site, so an unbound one is rejected.
  assert.equal(
    (
      await call(
        "POST",
        "/invitations",
        { email: "guard-c@example.com", role: "guard" },
        state.adminAToken,
      )
    ).statusCode,
    400,
  );
});

test("a resident sees only the households they hold a membership for", async () => {
  const residentOne = await inviteAndAccept(
    { email: "one@example.com", role: "resident", property_id: state.propertyA1 },
    state.adminAToken,
  );
  const residentTwo = await inviteAndAccept(
    { email: "two@example.com", role: "resident", property_id: state.propertyA2 },
    state.adminAToken,
  );
  state.residentOneToken = residentOne.session.token;
  state.residentTwoToken = residentTwo.session.token;
  assert.deepEqual(residentOne.session.principal.properties, [state.propertyA1]);

  const one = await call("GET", "/snapshot", undefined, state.residentOneToken);
  const two = await call("GET", "/snapshot", undefined, state.residentTwoToken);
  assert.deepEqual(
    one.json().vehicles.map((v) => v.plate),
    ["AAA 1111"],
  );
  assert.deepEqual(
    two.json().vehicles.map((v) => v.plate),
    ["BBB 2222"],
  );
  // A resident cannot reach the other household's credential at all.
  const otherHousehold = await call(
    "POST",
    "/credentials/" + state.vehicleA1.credential + "/status",
    { status: "lost" },
    state.residentTwoToken,
  );
  assert.equal(otherHousehold.statusCode, 404);
  // A resident may report their own tag lost but may not reactivate or suspend it.
  assert.equal(
    (
      await call(
        "POST",
        "/credentials/" + state.vehicleA1.credential + "/status",
        { status: "lost" },
        state.residentOneToken,
      )
    ).statusCode,
    201,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/credentials/" + state.vehicleA1.credential + "/status",
        { status: "suspended" },
        state.residentOneToken,
      )
    ).statusCode,
    403,
  );
});

test("revoking a session or removing a membership ends access immediately", async () => {
  const second = await call("POST", "/auth/login", {
    email: "hoa-a@example.com",
    password: PASSWORD,
  });
  const otherToken = second.json().token;
  assert.equal((await call("GET", "/snapshot", undefined, otherToken)).statusCode, 200);
  const sessions = await call("GET", "/auth/sessions", undefined, state.adminAToken);
  const target = sessions.json().find((row) => !row.revoked_at && row.id !== undefined);
  assert.ok(target);
  // Revoke every session except the one making the request, then confirm they stop working.
  const current = await call("GET", "/auth/session", undefined, state.adminAToken);
  assert.ok(current.json().principal.sessionId);
  assert.equal(
    (
      await call(
        "POST",
        "/auth/sessions/" + second.json().principal.sessionId + "/revoke",
        undefined,
        state.adminAToken,
      )
    ).statusCode,
    201,
  );
  assert.equal((await call("GET", "/snapshot", undefined, otherToken)).statusCode, 401);

  // An expired session is refused even though it was never revoked.
  const expired = await call("POST", "/auth/login", {
    email: "guard-a@example.com",
    password: PASSWORD,
  });
  const expiredToken = expired.json().token;
  await store.query("UPDATE sessions SET expires_at=now() - interval '1 minute' WHERE id=$1", [
    expired.json().principal.sessionId,
  ]);
  assert.equal((await call("GET", "/snapshot", undefined, expiredToken)).statusCode, 401);

  // Removing the membership removes access even though the session row is otherwise valid.
  const memberships = await call("GET", "/memberships", undefined, state.adminAToken);
  const guardMembership = memberships.json().find((row) => row.role === "guard");
  assert.ok(guardMembership, JSON.stringify(memberships.json()));
  assert.equal(
    (
      await call(
        "POST",
        "/memberships/" + guardMembership.id + "/revoke",
        { reason: "no longer on duty at this site" },
        state.adminAToken,
      )
    ).statusCode,
    201,
  );
  assert.equal((await call("GET", "/snapshot", undefined, state.guardToken)).statusCode, 401);
  const audit = await store.query(
    "SELECT detail FROM audit_events WHERE action='membership.revoked'",
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].detail.reason, "no longer on duty at this site");
});

test("multi-factor authentication is required once enrolled and refuses a replayed code", async () => {
  const enrollment = await call("POST", "/auth/mfa/enroll", undefined, state.adminAToken);
  assert.equal(enrollment.statusCode, 201, enrollment.body);
  const secret = enrollment.json().secret;
  assert.equal(typeof secret, "string");
  assert.equal(
    (await call("POST", "/auth/mfa/confirm", { code: "000000" }, state.adminAToken)).statusCode,
    400,
  );
  const confirmed = await call(
    "POST",
    "/auth/mfa/confirm",
    { code: totpCode(secret) },
    state.adminAToken,
  );
  assert.equal(confirmed.statusCode, 201, confirmed.body);
  assert.equal(confirmed.json().recovery_codes.length, 10);
  state.mfaSecret = secret;
  state.recoveryCodes = [...confirmed.json().recovery_codes];

  const login = await call("POST", "/auth/login", {
    email: "hoa-a@example.com",
    password: PASSWORD,
  });
  assert.equal(login.json().mfa_required, true);
  assert.equal(login.json().token, undefined);
  const challenge = login.json().challenge;
  assert.equal(
    (await call("POST", "/auth/mfa/verify", { challenge, code: "123456" })).statusCode,
    401,
  );
  const code = totpCode(secret);
  const verified = await call("POST", "/auth/mfa/verify", { challenge, code });
  assert.equal(verified.statusCode, 201, verified.body);
  assert.equal(verified.json().principal.role, "hoa_admin");
  state.adminAToken = verified.json().token;

  // The same code cannot be presented again in its own window.
  const replay = await call("POST", "/auth/login", {
    email: "hoa-a@example.com",
    password: PASSWORD,
  });
  assert.equal(
    (await call("POST", "/auth/mfa/verify", { challenge: replay.json().challenge, code }))
      .statusCode,
    401,
  );
  // A one-time recovery code works, and only once.
  const recovery = confirmed.json().recovery_codes[0];
  const viaRecovery = await call("POST", "/auth/login", {
    email: "hoa-a@example.com",
    password: PASSWORD,
  });
  assert.equal(
    (
      await call("POST", "/auth/mfa/verify", {
        challenge: viaRecovery.json().challenge,
        code: recovery,
      })
    ).statusCode,
    201,
  );
  const reused = await call("POST", "/auth/login", {
    email: "hoa-a@example.com",
    password: PASSWORD,
  });
  assert.equal(
    (
      await call("POST", "/auth/mfa/verify", {
        challenge: reused.json().challenge,
        code: recovery,
      })
    ).statusCode,
    401,
  );
});

test("platform support access is explicit, time-limited, read-only and audited", async () => {
  assert.equal((await call("GET", "/snapshot", undefined, state.platformToken)).statusCode, 403);
  const organizations = await call(
    "GET",
    "/platform/organizations",
    undefined,
    state.platformToken,
  );
  assert.equal(organizations.statusCode, 200);
  assert.equal(organizations.json().length, 2);

  // Without a grant, a platform session cannot enter the customer organization.
  assert.equal(
    (await call("POST", "/auth/scope", { organization_id: state.orgA }, state.platformToken))
      .statusCode,
    403,
  );
  const grant = await call(
    "POST",
    "/platform/organizations/" + state.orgA + "/support-access",
    { reason: "Investigate a denied tag reported at the gate", minutes: 30 },
    state.platformToken,
  );
  assert.equal(grant.statusCode, 201, grant.body);
  state.supportGrantId = grant.json().support_grant_id;
  const scoped = await call(
    "POST",
    "/auth/scope",
    { organization_id: state.orgA },
    state.platformToken,
  );
  assert.equal(scoped.statusCode, 201, scoped.body);
  const supportToken = scoped.json().token;
  assert.equal(scoped.json().principal.supportGrantId, state.supportGrantId);
  // Read-only: diagnosis is permitted, changing the customer's data is not.
  assert.equal((await call("GET", "/snapshot", undefined, supportToken)).statusCode, 200);
  assert.equal(
    (
      await call(
        "POST",
        "/credentials/" + state.vehicleA1.credential + "/status",
        { status: "active" },
        supportToken,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/enrollments",
        {
          resident: "X",
          property: "Lot 7",
          plate: "EEE 5555",
          make: "Kia",
          color: "Red",
          format: "epc",
          value: "EE55",
        },
        supportToken,
      )
    ).statusCode,
    403,
  );
  const elevations = await store.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE action='support.access_granted'",
  );
  assert.equal(elevations.rows[0].count, 1);

  // Entering the customer organization replaces the platform session token, so the unelevated
  // token from before the grant is no longer usable.
  assert.equal((await call("GET", "/snapshot", undefined, state.platformToken)).statusCode, 401);

  // Ending support access is done from a platform session, and it also ends the elevated session.
  const operatorSession = await call("POST", "/auth/login", {
    email: "ops@example.com",
    password: PASSWORD,
  });
  assert.equal(
    (
      await call(
        "POST",
        "/platform/support-access/" + state.supportGrantId + "/revoke",
        undefined,
        operatorSession.json().token,
      )
    ).statusCode,
    201,
  );
  assert.equal((await call("GET", "/snapshot", undefined, supportToken)).statusCode, 401);
  // The revocation is audited too, and the customer is unreachable again.
  const revocations = await store.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE action='support.access_revoked'",
  );
  assert.equal(revocations.rows[0].count, 1);
  assert.equal(
    (
      await call(
        "POST",
        "/auth/scope",
        { organization_id: state.orgA },
        operatorSession.json().token,
      )
    ).statusCode,
    403,
  );
});

test("changing a password invalidates the account's other sessions", async () => {
  const other = await call("POST", "/auth/login", {
    email: "hoa-b@example.com",
    password: PASSWORD,
  });
  const otherToken = other.json().token;
  assert.equal((await call("GET", "/snapshot", undefined, otherToken)).statusCode, 200);
  const wrong = await call(
    "POST",
    "/auth/password",
    { current_password: "not-the-password", new_password: "a-longer-new-passphrase" },
    state.adminBToken,
  );
  assert.equal(wrong.statusCode, 401);
  const changed = await call(
    "POST",
    "/auth/password",
    { current_password: PASSWORD, new_password: "a-longer-new-passphrase" },
    state.adminBToken,
  );
  assert.equal(changed.statusCode, 201, changed.body);
  assert.equal((await call("GET", "/snapshot", undefined, otherToken)).statusCode, 401);
  // The session that made the change survives, and the new password works.
  assert.equal((await call("GET", "/snapshot", undefined, state.adminBToken)).statusCode, 200);
  const relogin = await call("POST", "/auth/login", {
    email: "hoa-b@example.com",
    password: "a-longer-new-passphrase",
  });
  assert.equal(relogin.statusCode, 201, relogin.body);
  // The old password no longer works.
  assert.equal(
    (await call("POST", "/auth/login", { email: "hoa-b@example.com", password: PASSWORD }))
      .statusCode,
    401,
  );
});

test("an invitation cannot be used to take over an existing account", async () => {
  const invitation = await call(
    "POST",
    "/invitations",
    { email: "two@example.com", role: "resident", property_id: state.propertyA2 },
    state.adminAToken,
  );
  assert.equal(invitation.statusCode, 201, invitation.body);
  const takeover = await call("POST", "/auth/invitations/accept", {
    token: invitation.json().token,
    name: "Not the resident",
    password: "attacker-chosen-passphrase",
  });
  assert.equal(takeover.statusCode, 403);
  // The existing credential still works and the account was not modified.
  assert.equal(
    (await call("POST", "/auth/login", { email: "two@example.com", password: PASSWORD }))
      .statusCode,
    201,
  );
  // Accepting while signed in as that account works.
  const accepted = await call(
    "POST",
    "/auth/invitations/accept",
    { token: invitation.json().token },
    state.residentTwoToken,
  );
  assert.equal(accepted.statusCode, 201, accepted.body);
  // The token is single-use.
  assert.equal(
    (
      await call("POST", "/auth/invitations/accept", {
        token: invitation.json().token,
        name: "Again",
        password: "another-long-passphrase",
      })
    ).statusCode,
    401,
  );
});

test("a customer administrator cannot enumerate other customers", async () => {
  const operator = await call("POST", "/auth/login", {
    email: "ops@example.com",
    password: PASSWORD,
  });
  assert.equal(operator.statusCode, 201, operator.body);
  const listing = await call("GET", "/platform/organizations", undefined, operator.json().token);
  assert.equal(listing.statusCode, 200);
  assert.equal(listing.json().length, 2);
  // A village administrator holds organization.read for its own village, not for the fleet.
  const asVillageAdmin = await call("GET", "/platform/organizations", undefined, state.adminAToken);
  assert.equal(asVillageAdmin.statusCode, 403);
  assert.equal(
    (await call("GET", "/platform/organizations", undefined, state.residentOneToken)).statusCode,
    403,
  );
});

test("a session that has not passed MFA cannot be used once MFA is enabled", async () => {
  const current = await call("GET", "/auth/session", undefined, state.adminAToken);
  const sessionId = current.json().principal.sessionId;
  assert.ok(sessionId);
  // Simulate any session that exists for an MFA-enabled account without verification.
  await store.query("UPDATE sessions SET mfa_satisfied=false WHERE id=$1", [sessionId]);
  assert.equal((await call("GET", "/snapshot", undefined, state.adminAToken)).statusCode, 403);
  await store.query("UPDATE sessions SET mfa_satisfied=true WHERE id=$1", [sessionId]);
  assert.equal((await call("GET", "/snapshot", undefined, state.adminAToken)).statusCode, 200);

  // Accepting an invitation while verified must hand back a session that is also verified.
  const invitation = await call(
    "POST",
    "/invitations",
    { email: "hoa-a@example.com", role: "hoa_admin", organization_id: state.orgB },
    (await call("POST", "/auth/login", { email: "ops@example.com", password: PASSWORD })).json()
      .token,
  );
  assert.equal(invitation.statusCode, 201, invitation.body);
  const accepted = await call(
    "POST",
    "/auth/invitations/accept",
    { token: invitation.json().token },
    state.adminAToken,
  );
  assert.equal(accepted.statusCode, 201, accepted.body);
  const secondVillage = await call("GET", "/snapshot", undefined, accepted.json().token);
  assert.equal(secondVillage.statusCode, 200, "the issued session must be usable");
  assert.equal(secondVillage.json().organization.id, state.orgB);

  // A scope change must carry the verification state rather than satisfy or drop it.
  const scoped = await call(
    "POST",
    "/auth/scope",
    { organization_id: state.orgA },
    accepted.json().token,
  );
  assert.equal(scoped.statusCode, 201, scoped.body);
  assert.equal((await call("GET", "/snapshot", undefined, scoped.json().token)).statusCode, 200);
  state.adminAToken = scoped.json().token;
});

test("concurrent MFA submissions cannot both succeed", async () => {
  const challengeFor = async () =>
    (await call("POST", "/auth/login", { email: "hoa-a@example.com", password: PASSWORD })).json()
      .challenge;
  // Each race starts from a fresh time step, because the suite runs inside a single step window
  // and the step consumed earlier is deliberately no longer reusable.
  const freshStep = () =>
    store.query("UPDATE users SET mfa_last_step=NULL WHERE email=$1", ["hoa-a@example.com"]);

  // The same challenge twice: the row is claimed once, so exactly one submission wins.
  const shared = await challengeFor();
  await freshStep();
  const code = totpCode(state.mfaSecret);
  const both = await Promise.all([
    call("POST", "/auth/mfa/verify", { challenge: shared, code }),
    call("POST", "/auth/mfa/verify", { challenge: shared, code }),
  ]);
  assert.equal(both.filter((response) => response.statusCode === 201).length, 1);

  // The same code against two challenges: the time step is claimed once, so exactly one wins.
  const [first, second] = await Promise.all([challengeFor(), challengeFor()]);
  await freshStep();
  const reused = totpCode(state.mfaSecret);
  const raced = await Promise.all([
    call("POST", "/auth/mfa/verify", { challenge: first, code: reused }),
    call("POST", "/auth/mfa/verify", { challenge: second, code: reused }),
  ]);
  assert.equal(
    raced.filter((response) => response.statusCode === 201).length,
    1,
    "one code must not authenticate two sessions",
  );

  // A recovery code is single-use, including under concurrency.
  const [third, fourth] = await Promise.all([challengeFor(), challengeFor()]);
  const recovery = state.recoveryCodes[1];
  const recovered = await Promise.all([
    call("POST", "/auth/mfa/verify", { challenge: third, code: recovery }),
    call("POST", "/auth/mfa/verify", { challenge: fourth, code: recovery }),
  ]);
  assert.equal(
    recovered.filter((response) => response.statusCode === 201).length,
    1,
    "a recovery code must not be redeemable twice",
  );
});

test("a guard's data is limited to the assigned station and fails closed without one", async () => {
  const otherSite = randomUUID();
  await store.query(
    "INSERT INTO sites(id,organization_id,name,code) VALUES($1,$2,'Service gate','SERVICE')",
    [otherSite, state.orgA],
  );
  const myLane = randomUUID();
  const otherLane = randomUUID();
  await store.query(
    "INSERT INTO lanes(id,organization_id,site_id,name,direction) VALUES($1,$2,$3,'Entry','entry'),($4,$2,$5,'Entry','entry')",
    [myLane, state.orgA, state.site, otherLane, otherSite],
  );
  const recordEvent = (laneId, value) =>
    store.query(
      "INSERT INTO access_events(event_id,organization_id,edge_id,vehicle_id,payload) VALUES($1,$2,$3,NULL,$4)",
      [
        randomUUID(),
        state.orgA,
        randomUUID(),
        JSON.stringify({
          schema_version: 1,
          event_id: randomUUID(),
          organization_id: state.orgA,
          lane_id: laneId,
          observed_at: new Date().toISOString(),
          edge_sequence: 1,
          format: "epc",
          value,
          credential_id: null,
          vehicle_id: null,
          vehicle_plate: null,
          decision: "denied",
          reason: "UNKNOWN_CREDENTIAL",
          barrier_outcome: "not_requested",
          passage_confirmed: false,
          config_version: 1,
          offline: false,
        }),
      ],
    );
  await recordEvent(myLane, "AAAA1111");
  await recordEvent(otherLane, "BBBB2222");
  // A vehicle with no credential can never be authorized, so a station need not see it.
  await store.query(
    "INSERT INTO vehicles(id,organization_id,property_id,plate,make,color) VALUES($1,$2,$3,'ZZZ 9999','Kia','Red')",
    [randomUUID(), state.orgA, state.propertyA1],
  );

  const guard = await inviteAndAccept(
    { email: "guard-station@example.com", role: "guard", site_id: state.site },
    state.adminAToken,
  );
  const guardToken = guard.session.token;
  const view = await call("GET", "/snapshot", undefined, guardToken);
  assert.equal(view.statusCode, 200, view.body);
  const body = view.json();
  assert.deepEqual(
    body.sites.map((site) => site.id),
    [state.site],
    "only the assigned station",
  );
  assert.deepEqual(body.properties, [], "a guard does not receive the household roster");
  const seen = body.events.map((event) => event.value);
  assert.ok(seen.includes("AAAA1111"), "activity at the assigned station is visible");
  assert.ok(!seen.includes("BBBB2222"), "another station's activity is not visible");
  assert.ok(
    !body.vehicles.map((vehicle) => vehicle.plate).includes("ZZZ 9999"),
    "a vehicle with no credential is not part of the station lookup",
  );
  // A tag authorized only at another station's lane is not part of this station's lookup, while a
  // tag with no recorded policy is authorized everywhere.
  const elsewhere = await seedVehicle(state.orgA, state.propertyA2, "YYY 8888", "YY88");
  await store.query(
    "INSERT INTO credential_lanes(id,organization_id,credential_id,lane_id) VALUES($1,$2,$3,$4)",
    [randomUUID(), state.orgA, elsewhere.credential, otherLane],
  );
  const narrowed = (await call("GET", "/snapshot", undefined, guardToken)).json();
  const plates = narrowed.vehicles.map((vehicle) => vehicle.plate);
  assert.ok(!plates.includes("YYY 8888"), "another station's tag is not in this lookup");
  assert.ok(plates.includes("AAA 1111"), "an unpoliced tag is authorized at every lane");
  // The station lookup carries no household data and no raw tag value.
  assert.deepEqual(Object.keys(narrowed.vehicles[0]).sort(), [
    "color",
    "credential_status",
    "format",
    "id",
    "make",
    "plate",
  ]);
  // The village administrator still receives the full record.
  const adminView = (await call("GET", "/snapshot", undefined, state.adminAToken)).json();
  assert.equal(adminView.vehicles[0].resident_name !== undefined, true);

  // With the assignment withdrawn there is nothing to show, so it must fail closed.
  await store.query("UPDATE site_assignments SET revoked_at=now() WHERE membership_id=$1", [
    guard.session.principal.membershipId,
  ]);
  assert.equal((await call("GET", "/snapshot", undefined, guardToken)).statusCode, 403);
  state.stationGuard = guard.session.principal.membershipId;
});

test("re-inviting a member whose access was withdrawn restores their scope", async () => {
  // A guard whose station assignment was withdrawn regains it on re-invitation.
  const guardInvite = await call(
    "POST",
    "/invitations",
    { email: "guard-station@example.com", role: "guard", site_id: state.site },
    state.adminAToken,
  );
  assert.equal(guardInvite.statusCode, 201, guardInvite.body);
  const guardSession = await call("POST", "/auth/login", {
    email: "guard-station@example.com",
    password: PASSWORD,
  });
  assert.equal(guardSession.statusCode, 201, guardSession.body);
  const guardAccepted = await call(
    "POST",
    "/auth/invitations/accept",
    { token: guardInvite.json().token },
    guardSession.json().token,
  );
  assert.equal(guardAccepted.statusCode, 201, guardAccepted.body);
  assert.deepEqual(
    guardAccepted.json().principal.sites,
    [state.site],
    "the station assignment must be restored, not left revoked",
  );
  assert.equal(
    (await call("GET", "/snapshot", undefined, guardAccepted.json().token)).statusCode,
    200,
  );

  // A resident whose membership was withdrawn regains the household on re-invitation.
  const resident = await inviteAndAccept(
    { email: "rejoin@example.com", role: "resident", property_id: state.propertyA1 },
    state.adminAToken,
  );
  const scopeBefore = (await call("GET", "/snapshot", undefined, resident.session.token)).json()
    .vehicles.length;
  assert.ok(scopeBefore >= 1, "the household should be visible before access is withdrawn");
  const people = await call("GET", "/memberships", undefined, state.adminAToken);
  const target = people.json().find((person) => person.email === "rejoin@example.com");
  assert.ok(target, JSON.stringify(people.json()));
  assert.equal(
    (
      await call(
        "POST",
        "/memberships/" + target.id + "/revoke",
        { reason: "withdrawn for the test" },
        state.adminAToken,
      )
    ).statusCode,
    201,
  );
  assert.equal((await call("GET", "/snapshot", undefined, resident.session.token)).statusCode, 401);
  const ended = await store.query(
    "SELECT ended_at FROM property_memberships WHERE membership_id=$1",
    [target.id],
  );
  assert.ok(ended.rows[0]?.ended_at, "revocation must end the household assignment");

  const again = await call(
    "POST",
    "/invitations",
    { email: "rejoin@example.com", role: "resident", property_id: state.propertyA1 },
    state.adminAToken,
  );
  assert.equal(again.statusCode, 201, again.body);

  // The invitation token on its own must not issue a session as this person.
  const anonymous = await call("POST", "/auth/invitations/accept", {
    token: again.json().token,
  });
  assert.equal(anonymous.statusCode, 403, anonymous.body);
  assert.equal(anonymous.json().token, undefined);

  // The withdrawn account can sign in with its own password, but holds nothing.
  const signIn = await call("POST", "/auth/login", {
    email: "rejoin@example.com",
    password: PASSWORD,
  });
  assert.equal(signIn.statusCode, 201, signIn.body);
  assert.equal(signIn.json().principal.organizationId, null);
  assert.equal(signIn.json().principal.role, "unaffiliated");
  assert.deepEqual(signIn.json().memberships, []);
  assert.equal(
    (await call("GET", "/snapshot", undefined, signIn.json().token)).statusCode,
    403,
    "an unaffiliated session grants no village data",
  );
  assert.equal((await call("GET", "/invitations", undefined, signIn.json().token)).statusCode, 403);

  // Knowing who they are, they can accept the invitation and regain their household.
  const returned = await call(
    "POST",
    "/auth/invitations/accept",
    { token: again.json().token },
    signIn.json().token,
  );
  assert.equal(returned.statusCode, 201, returned.body);
  const restored = await call("GET", "/snapshot", undefined, returned.json().token);
  assert.equal(restored.statusCode, 200);
  assert.equal(
    restored.json().vehicles.length,
    scopeBefore,
    "the household scope must be restored to exactly what it was",
  );
});
