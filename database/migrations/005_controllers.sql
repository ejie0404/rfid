CREATE TABLE IF NOT EXISTS controller_enrollment_grants (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 site_id uuid NOT NULL,
 token_hash char(64) NOT NULL UNIQUE,
 controller_name text NOT NULL,
 created_by text NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,site_id) REFERENCES sites(organization_id,id)
);
CREATE INDEX IF NOT EXISTS controller_grants_by_org
 ON controller_enrollment_grants(organization_id,created_at DESC);

CREATE TABLE IF NOT EXISTS controller_enrollment_grant_lanes (
 organization_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 lane_id uuid NOT NULL,
 PRIMARY KEY(grant_id,lane_id),
 FOREIGN KEY(organization_id,grant_id)
   REFERENCES controller_enrollment_grants(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,lane_id)
   REFERENCES lanes(organization_id,id)
);

CREATE TABLE IF NOT EXISTS controllers (
 id uuid PRIMARY KEY,
 installation_id uuid NOT NULL UNIQUE,
 organization_id uuid NOT NULL,
 site_id uuid NOT NULL,
 name text NOT NULL,
 credential_hash char(64) NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 protocol_version integer NOT NULL DEFAULT 1 CHECK(protocol_version>0),
 software_version text,
 hardware_mode text NOT NULL DEFAULT 'simulator' CHECK(hardware_mode IN ('simulator','hikvision')),
 config_version integer NOT NULL DEFAULT 0 CHECK(config_version>=0),
 pending_events integer NOT NULL DEFAULT 0 CHECK(pending_events>=0),
 last_seen_at timestamptz,
 last_reported_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,site_id) REFERENCES sites(organization_id,id)
);
CREATE INDEX IF NOT EXISTS controllers_by_org
 ON controllers(organization_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS controller_lanes (
 organization_id uuid NOT NULL,
 controller_id uuid NOT NULL,
 lane_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(controller_id,lane_id),
 FOREIGN KEY(organization_id,controller_id)
   REFERENCES controllers(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,lane_id)
   REFERENCES lanes(organization_id,id)
);
CREATE INDEX IF NOT EXISTS controller_lanes_by_lane ON controller_lanes(lane_id);
