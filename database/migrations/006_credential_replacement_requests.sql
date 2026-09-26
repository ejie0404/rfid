CREATE TABLE IF NOT EXISTS credential_replacement_requests (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 property_id uuid NOT NULL,
 vehicle_id uuid NOT NULL,
 credential_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','issued','rejected')),
 required_config_version integer NOT NULL CHECK(required_config_version>0),
 replacement_credential_id uuid,
 decision_note text NOT NULL DEFAULT '',
 decided_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 FOREIGN KEY(organization_id,property_id) REFERENCES properties(organization_id,id),
 FOREIGN KEY(organization_id,vehicle_id) REFERENCES vehicles(organization_id,id),
 FOREIGN KEY(organization_id,credential_id) REFERENCES credentials(organization_id,id),
 FOREIGN KEY(organization_id,replacement_credential_id)
   REFERENCES credentials(organization_id,id),
 CHECK(
   (status='pending' AND replacement_credential_id IS NULL AND decided_by IS NULL AND resolved_at IS NULL)
   OR (status='issued' AND replacement_credential_id IS NOT NULL AND decided_by IS NOT NULL AND resolved_at IS NOT NULL)
   OR (status='rejected' AND replacement_credential_id IS NULL AND decided_by IS NOT NULL AND resolved_at IS NOT NULL)
 )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_replacement_per_credential
 ON credential_replacement_requests(organization_id,credential_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS replacement_requests_by_property
 ON credential_replacement_requests(organization_id,property_id,created_at DESC);
CREATE INDEX IF NOT EXISTS replacement_requests_by_org_status
 ON credential_replacement_requests(organization_id,status,created_at DESC);
