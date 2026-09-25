CREATE TABLE IF NOT EXISTS organizations (
 id uuid PRIMARY KEY, name text NOT NULL, config_version integer NOT NULL DEFAULT 1 CHECK(config_version>0)
);
CREATE TABLE IF NOT EXISTS properties (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 label text NOT NULL, resident_name text NOT NULL, UNIQUE(organization_id,id)
);
CREATE TABLE IF NOT EXISTS vehicles (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), property_id uuid NOT NULL,
 plate text NOT NULL, make text NOT NULL, color text NOT NULL, active boolean NOT NULL DEFAULT true,
 FOREIGN KEY(organization_id,property_id) REFERENCES properties(organization_id,id),
 UNIQUE(organization_id,plate), UNIQUE(organization_id,id)
);
CREATE TABLE IF NOT EXISTS credentials (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 format text NOT NULL CHECK(format IN ('epc','wiegand26','wiegand34')), value text NOT NULL,
 status text NOT NULL CHECK(status IN ('active','suspended','lost','revoked')),
 valid_from timestamptz NOT NULL, valid_until timestamptz,
 UNIQUE(organization_id,format,value), UNIQUE(organization_id,id),
 CHECK(valid_until IS NULL OR valid_until>valid_from)
);
CREATE TABLE IF NOT EXISTS assignments (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 credential_id uuid NOT NULL, vehicle_id uuid NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 FOREIGN KEY(organization_id,credential_id) REFERENCES credentials(organization_id,id),
 FOREIGN KEY(organization_id,vehicle_id) REFERENCES vehicles(organization_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_assignment ON assignments(credential_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS audit_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 actor_id text NOT NULL, action text NOT NULL, entity_id uuid NOT NULL, detail jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_events (
 event_id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), edge_id uuid NOT NULL,
 vehicle_id uuid, payload jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_org_time ON access_events(organization_id,received_at DESC);
CREATE TABLE IF NOT EXISTS edge_heartbeats (
 edge_id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);

