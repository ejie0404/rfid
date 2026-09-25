-- Step 2: real users, organization membership, sessions, invitations, and MFA.
-- Organization scope is derived from these rows, never from a request body.

CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY,
 email text NOT NULL UNIQUE,
 name text NOT NULL,
 password_hash text,
 status text NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','active','suspended','disabled')),
 platform_role text CHECK(platform_role IN ('platform_admin','platform_support')),
 mfa_secret text,
 mfa_confirmed_at timestamptz,
 mfa_last_step bigint,
 failed_attempts integer NOT NULL DEFAULT 0,
 locked_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 -- An active account must have a credential, so a half-created user cannot sign in.
 CHECK(status<>'active' OR password_hash IS NOT NULL),
 -- A confirmed MFA enrolment must retain both halves of its state.
 CHECK(mfa_confirmed_at IS NULL OR mfa_secret IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS users_platform_role ON users(platform_role) WHERE platform_role IS NOT NULL;

CREATE TABLE IF NOT EXISTS sites (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL, code text NOT NULL,
 UNIQUE(organization_id,code), UNIQUE(organization_id,id)
);

CREATE TABLE IF NOT EXISTS organization_memberships (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('hoa_admin','guard','resident')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 UNIQUE(organization_id,user_id,role), UNIQUE(organization_id,id)
);
CREATE INDEX IF NOT EXISTS membership_user ON organization_memberships(user_id) WHERE status='active';

CREATE TABLE IF NOT EXISTS property_memberships (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL,
 property_id uuid NOT NULL, membership_id uuid NOT NULL,
 relationship text NOT NULL CHECK(relationship IN ('owner','tenant','family_member','occupant')),
 is_primary_contact boolean NOT NULL DEFAULT false,
 started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 FOREIGN KEY(organization_id,property_id) REFERENCES properties(organization_id,id),
 FOREIGN KEY(organization_id,membership_id) REFERENCES organization_memberships(organization_id,id),
 UNIQUE(membership_id,property_id)
);

CREATE TABLE IF NOT EXISTS site_assignments (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL,
 site_id uuid NOT NULL, membership_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 FOREIGN KEY(organization_id,site_id) REFERENCES sites(organization_id,id),
 FOREIGN KEY(organization_id,membership_id) REFERENCES organization_memberships(organization_id,id),
 UNIQUE(membership_id,site_id)
);

-- Support access is a separate, revocable grant so platform staff never read a customer
-- organization implicitly. Declared before sessions so a session can reference its grant.
CREATE TABLE IF NOT EXISTS support_access_grants (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 user_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL, granted_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS support_grant_user ON support_access_grants(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE,
 user_id uuid NOT NULL REFERENCES users(id), membership_id uuid,
 support_grant_id uuid REFERENCES support_access_grants(id),
 organization_id uuid REFERENCES organizations(id),
 mfa_satisfied boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 revoke_reason text, user_agent text, created_ip text,
 FOREIGN KEY(membership_id) REFERENCES organization_memberships(id),
 -- A session is scoped by its membership, or by an explicit support grant, or neither.
 CHECK(NOT(membership_id IS NOT NULL AND support_grant_id IS NOT NULL)),
 CHECK(membership_id IS NULL OR organization_id IS NOT NULL),
 CHECK(support_grant_id IS NULL OR organization_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS session_live ON sessions(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mfa_challenges (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE,
 user_id uuid NOT NULL REFERENCES users(id), membership_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 FOREIGN KEY(membership_id) REFERENCES organization_memberships(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS challenge_live ON mfa_challenges(token_hash) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 code_hash text NOT NULL UNIQUE, used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invitations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 email text NOT NULL, role text NOT NULL CHECK(role IN ('hoa_admin','guard','resident')),
 token_hash text NOT NULL UNIQUE, invited_by text NOT NULL,
 site_id uuid, property_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 accepted_at timestamptz, revoked_at timestamptz,
 FOREIGN KEY(organization_id,site_id) REFERENCES sites(organization_id,id),
 FOREIGN KEY(organization_id,property_id) REFERENCES properties(organization_id,id),
 CHECK(expires_at>created_at),
 -- A guard invitation binds a site; a resident invitation binds a household.
 CHECK(role<>'guard' OR site_id IS NOT NULL),
 CHECK(role<>'resident' OR property_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS invitation_org ON invitations(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS invitation_live ON invitations(token_hash) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Every elevation of platform access is attributable to a grant.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS support_grant_id uuid;
