CREATE TABLE IF NOT EXISTS property_occupancies (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 property_id uuid NOT NULL,
 started_at timestamptz NOT NULL,
 ended_at timestamptz,
 end_reason text NOT NULL DEFAULT '',
 required_config_version integer,
 created_by uuid REFERENCES users(id),
 ended_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,property_id) REFERENCES properties(organization_id,id),
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,property_id,id),
 CHECK(ended_at IS NULL OR ended_at>started_at),
 CHECK(required_config_version IS NULL OR required_config_version>0)
);

ALTER TABLE property_memberships ADD COLUMN IF NOT EXISTS occupancy_id uuid;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS occupancy_id uuid;

-- Existing records predate occupancy history. Group them into one legacy occupancy per property,
-- keeping active residents, vehicles, and assignments attached to an open period.
INSERT INTO property_occupancies(id,organization_id,property_id,started_at,ended_at)
SELECT gen_random_uuid(),p.organization_id,p.id,
       COALESCE(LEAST(MIN(pm.started_at),MIN(a.started_at)),now()),
       CASE
         WHEN COALESCE(bool_or(pm.id IS NOT NULL AND pm.ended_at IS NULL),false)
           OR COALESCE(bool_or(v.active),false)
           OR COALESCE(bool_or(a.id IS NOT NULL AND a.ended_at IS NULL),false)
           THEN NULL
         ELSE GREATEST(
           COALESCE(MAX(pm.ended_at),now()),
           COALESCE(MAX(a.ended_at),now()),
           COALESCE(LEAST(MIN(pm.started_at),MIN(a.started_at)),now())+interval '1 microsecond'
         )
       END
FROM properties p
LEFT JOIN property_memberships pm
  ON pm.organization_id=p.organization_id AND pm.property_id=p.id
LEFT JOIN vehicles v
  ON v.organization_id=p.organization_id AND v.property_id=p.id
LEFT JOIN assignments a
  ON a.organization_id=v.organization_id AND a.vehicle_id=v.id
GROUP BY p.organization_id,p.id;

UPDATE property_memberships pm
SET occupancy_id=o.id
FROM property_occupancies o
WHERE pm.occupancy_id IS NULL
  AND o.organization_id=pm.organization_id AND o.property_id=pm.property_id;

UPDATE vehicles v
SET occupancy_id=o.id
FROM property_occupancies o
WHERE v.occupancy_id IS NULL
  AND o.organization_id=v.organization_id AND o.property_id=v.property_id;

ALTER TABLE property_memberships ALTER COLUMN occupancy_id SET NOT NULL;
ALTER TABLE vehicles ALTER COLUMN occupancy_id SET NOT NULL;
ALTER TABLE property_memberships
  ADD CONSTRAINT property_memberships_occupancy_fk
  FOREIGN KEY(organization_id,property_id,occupancy_id)
  REFERENCES property_occupancies(organization_id,property_id,id);
ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_occupancy_fk
  FOREIGN KEY(organization_id,property_id,occupancy_id)
  REFERENCES property_occupancies(organization_id,property_id,id);

-- Keep every occupant period. A partial index prevents duplicate current membership while allowing
-- a person to return to the same property in a later occupancy.
ALTER TABLE property_memberships
  DROP CONSTRAINT IF EXISTS property_memberships_membership_id_property_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS active_property_membership
  ON property_memberships(membership_id,property_id) WHERE ended_at IS NULL;

-- A household may enroll the same plate again after a move-out, while old vehicle rows and events
-- remain available for history.
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_organization_id_plate_key;
CREATE UNIQUE INDEX IF NOT EXISTS active_vehicle_plate
  ON vehicles(organization_id,plate) WHERE active;

CREATE UNIQUE INDEX IF NOT EXISTS one_active_occupancy_per_property
  ON property_occupancies(organization_id,property_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS occupancy_history_by_property
  ON property_occupancies(organization_id,property_id,started_at DESC);
CREATE INDEX IF NOT EXISTS memberships_by_occupancy
  ON property_memberships(organization_id,occupancy_id,ended_at);
CREATE INDEX IF NOT EXISTS vehicles_by_occupancy
  ON vehicles(organization_id,occupancy_id,active);

CREATE TABLE IF NOT EXISTS occupancy_controller_targets (
 organization_id uuid NOT NULL,
 occupancy_id uuid NOT NULL,
 controller_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(occupancy_id,controller_id),
 FOREIGN KEY(organization_id,occupancy_id)
   REFERENCES property_occupancies(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,controller_id)
   REFERENCES controllers(organization_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS occupancy_targets_by_controller
  ON occupancy_controller_targets(organization_id,controller_id);
