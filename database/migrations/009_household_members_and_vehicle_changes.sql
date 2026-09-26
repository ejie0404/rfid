ALTER TABLE invitations
  ADD COLUMN resident_relationship text
  CHECK(resident_relationship IS NULL OR resident_relationship IN ('owner','tenant','family_member','occupant'));

-- Older invitations could make every accepted resident a primary contact. Keep the earliest
-- active contact per occupancy before enforcing the rule for new writes.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY organization_id,occupancy_id ORDER BY started_at,id
  ) AS contact_rank
  FROM property_memberships
  WHERE ended_at IS NULL AND is_primary_contact
)
UPDATE property_memberships pm
SET is_primary_contact=false
FROM ranked r
WHERE pm.id=r.id AND r.contact_rank>1;

CREATE UNIQUE INDEX one_primary_contact_per_occupancy
  ON property_memberships(organization_id,occupancy_id)
  WHERE ended_at IS NULL AND is_primary_contact;

CREATE TABLE vehicle_change_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  property_id uuid NOT NULL,
  occupancy_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  prior_plate text NOT NULL,
  prior_make text NOT NULL,
  prior_color text NOT NULL,
  proposed_plate text NOT NULL,
  proposed_make text NOT NULL,
  proposed_color text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected','cancelled')),
  decision_note text NOT NULL DEFAULT '',
  decided_by uuid REFERENCES users(id),
  required_config_version integer CHECK(required_config_version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY(organization_id,property_id,occupancy_id)
    REFERENCES property_occupancies(organization_id,property_id,id),
  FOREIGN KEY(organization_id,vehicle_id) REFERENCES vehicles(organization_id,id),
  UNIQUE(organization_id,id),
  CHECK(
    (status='pending' AND decided_by IS NULL AND resolved_at IS NULL
      AND required_config_version IS NULL)
    OR (status<>'pending' AND decided_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX one_pending_vehicle_change_per_vehicle
  ON vehicle_change_requests(organization_id,vehicle_id) WHERE status='pending';
CREATE INDEX vehicle_changes_by_occupancy
  ON vehicle_change_requests(organization_id,occupancy_id,created_at DESC);
CREATE INDEX vehicle_changes_by_status
  ON vehicle_change_requests(organization_id,status,created_at DESC);

CREATE TABLE vehicle_change_controller_targets (
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  controller_id uuid NOT NULL,
  PRIMARY KEY(request_id,controller_id),
  FOREIGN KEY(organization_id,request_id)
    REFERENCES vehicle_change_requests(organization_id,id) ON DELETE CASCADE,
  FOREIGN KEY(organization_id,controller_id)
    REFERENCES controllers(organization_id,id) ON DELETE CASCADE
);
