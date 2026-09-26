CREATE TABLE IF NOT EXISTS scheduled_move_outs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  property_id uuid NOT NULL,
  occupancy_id uuid NOT NULL,
  requested_by text NOT NULL,
  reason text NOT NULL DEFAULT '',
  effective_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  configuration_version integer NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  executed_by text,
  completed_configuration_version integer,
  FOREIGN KEY (organization_id, property_id, occupancy_id)
    REFERENCES property_occupancies(organization_id, property_id, id),
  UNIQUE (organization_id, id),
  CHECK (
    (status = 'scheduled' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND executed_by IS NOT NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_scheduled_move_out_per_occupancy
  ON scheduled_move_outs(organization_id, occupancy_id)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS due_scheduled_move_outs
  ON scheduled_move_outs(effective_at, id)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS scheduled_move_outs_work_queue
  ON scheduled_move_outs(organization_id, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS scheduled_move_out_controller_targets (
  organization_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  revision integer NOT NULL,
  controller_id uuid NOT NULL,
  configuration_version integer NOT NULL,
  PRIMARY KEY (organization_id, schedule_id, revision, controller_id),
  FOREIGN KEY (organization_id, schedule_id)
    REFERENCES scheduled_move_outs(organization_id, id),
  FOREIGN KEY (organization_id, controller_id)
    REFERENCES controllers(organization_id, id)
);
CREATE INDEX IF NOT EXISTS scheduled_move_out_targets_by_controller
  ON scheduled_move_out_controller_targets(organization_id, controller_id, configuration_version);
