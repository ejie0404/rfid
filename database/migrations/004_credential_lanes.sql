-- Which lanes a credential may be used at. The edge already evaluates a credential's lane list, so
-- recording policy here makes gate scoping enforceable and lets a guard's view be limited to the
-- station they are on duty at.
--
-- A credential with no rows is authorized at every lane of its organization, which is the current
-- implicit default. Recording rows narrows it.

CREATE TABLE IF NOT EXISTS credential_lanes (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL,
 credential_id uuid NOT NULL, lane_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,credential_id) REFERENCES credentials(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,lane_id) REFERENCES lanes(organization_id,id) ON DELETE CASCADE,
 UNIQUE(credential_id,lane_id)
);
CREATE INDEX IF NOT EXISTS credential_lanes_by_lane ON credential_lanes(lane_id);
