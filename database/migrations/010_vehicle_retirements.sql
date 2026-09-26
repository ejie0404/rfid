CREATE TABLE IF NOT EXISTS vehicle_retirement_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  property_id uuid NOT NULL,
  occupancy_id uuid NOT NULL,
  vehicle_id uuid NOT NULL,
  requested_by text NOT NULL,
  source text NOT NULL CHECK (source IN ('resident', 'hoa')),
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decision_note text NOT NULL DEFAULT '',
  decided_by text,
  resolved_at timestamptz,
  required_config_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, property_id, occupancy_id)
    REFERENCES property_occupancies(organization_id, property_id, id),
  FOREIGN KEY (organization_id, vehicle_id)
    REFERENCES vehicles(organization_id, id),
  UNIQUE (organization_id, id),
  CHECK (
    (status = 'pending' AND decided_by IS NULL AND resolved_at IS NULL
      AND required_config_version IS NULL)
    OR
    (status <> 'pending' AND decided_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_vehicle_retirement
  ON vehicle_retirement_requests(organization_id, vehicle_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS vehicle_retirements_by_occupancy
  ON vehicle_retirement_requests(organization_id, occupancy_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS vehicle_retirements_work_queue
  ON vehicle_retirement_requests(organization_id, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS vehicle_retirement_controller_targets (
  organization_id uuid NOT NULL,
  request_id uuid NOT NULL,
  controller_id uuid NOT NULL,
  PRIMARY KEY (organization_id, request_id, controller_id),
  FOREIGN KEY (organization_id, request_id)
    REFERENCES vehicle_retirement_requests(organization_id, id),
  FOREIGN KEY (organization_id, controller_id)
    REFERENCES controllers(organization_id, id)
);
