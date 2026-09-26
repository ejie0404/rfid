ALTER TABLE property_occupancies
  ADD COLUMN IF NOT EXISTS resident_name_at_start text NOT NULL DEFAULT '';

-- Legacy vehicles have only a property link. An active vehicle with no current resident, or
-- activity before the earliest current membership, cannot be assigned to a household safely.
-- Stop startup until its ownership period is reconciled.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM vehicles v
    LEFT JOIN LATERAL (
      SELECT MIN(pm.started_at) AS started_at
      FROM property_memberships pm
      WHERE pm.organization_id=v.organization_id AND pm.property_id=v.property_id
        AND pm.ended_at IS NULL
    ) current_household ON true
    WHERE v.active
      AND (
        current_household.started_at IS NULL
        OR EXISTS (
          SELECT 1 FROM access_events e
          WHERE e.organization_id=v.organization_id AND e.vehicle_id=v.id
            AND e.received_at<current_household.started_at
        )
        OR (
          EXISTS (SELECT 1 FROM property_memberships former
                  WHERE former.organization_id=v.organization_id
                    AND former.property_id=v.property_id AND former.ended_at IS NOT NULL)
          AND EXISTS (SELECT 1 FROM assignments a
                      WHERE a.organization_id=v.organization_id AND a.vehicle_id=v.id
                        AND a.started_at<current_household.started_at)
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Occupancy history is ambiguous: an active legacy vehicle has no current resident or predates the current household. Reconcile the vehicle ownership period before applying migration 008.';
  END IF;
END $$;

CREATE TEMP TABLE occupancy_legacy_archive_map (
  organization_id uuid NOT NULL,
  property_id uuid NOT NULL,
  occupancy_id uuid NOT NULL,
  PRIMARY KEY(organization_id,property_id)
) ON COMMIT DROP;

WITH archive_bounds AS (
  SELECT o.organization_id,o.property_id,gen_random_uuid() AS occupancy_id,
         o.started_at AS fallback_start,
         (SELECT MIN(pm.started_at) FROM property_memberships pm
          WHERE pm.organization_id=o.organization_id AND pm.property_id=o.property_id
            AND pm.ended_at IS NOT NULL) AS member_start,
         (SELECT MAX(pm.ended_at) FROM property_memberships pm
          WHERE pm.organization_id=o.organization_id AND pm.property_id=o.property_id
            AND pm.ended_at IS NOT NULL) AS member_end,
         (SELECT MIN(a.started_at) FROM assignments a
          JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
          WHERE v.organization_id=o.organization_id AND v.property_id=o.property_id
            AND NOT v.active) AS assignment_start,
         (SELECT MAX(a.ended_at) FROM assignments a
          JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
          WHERE v.organization_id=o.organization_id AND v.property_id=o.property_id
            AND NOT v.active) AS assignment_end,
         (SELECT MIN(e.received_at) FROM access_events e
          JOIN vehicles v ON v.id=e.vehicle_id AND v.organization_id=e.organization_id
          WHERE v.organization_id=o.organization_id AND v.property_id=o.property_id
            AND NOT v.active) AS event_start,
         (SELECT MAX(e.received_at) FROM access_events e
          JOIN vehicles v ON v.id=e.vehicle_id AND v.organization_id=e.organization_id
          WHERE v.organization_id=o.organization_id AND v.property_id=o.property_id
            AND NOT v.active) AS event_end,
         COALESCE(
           (SELECT string_agg(DISTINCT u.name, ', ' ORDER BY u.name)
            FROM property_memberships pm
            JOIN organization_memberships m ON m.id=pm.membership_id
            JOIN users u ON u.id=m.user_id
            WHERE pm.organization_id=o.organization_id AND pm.property_id=o.property_id
              AND pm.ended_at IS NOT NULL),
           'Legacy household'
         ) AS resident_name_at_start
  FROM property_occupancies o
  WHERE o.ended_at IS NULL
    AND (
      EXISTS (SELECT 1 FROM property_memberships pm
              WHERE pm.organization_id=o.organization_id AND pm.property_id=o.property_id
                AND pm.ended_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM vehicles v
                 WHERE v.organization_id=o.organization_id AND v.property_id=o.property_id
                   AND NOT v.active)
    )
), archive_candidates AS (
  SELECT organization_id,property_id,occupancy_id,
         COALESCE(LEAST(member_start,assignment_start,event_start),fallback_start) AS started_at,
         GREATEST(member_end,assignment_end,event_end,
                  COALESCE(LEAST(member_start,assignment_start,event_start),fallback_start)
                    + interval '1 microsecond') AS ended_at,
         resident_name_at_start
  FROM archive_bounds
), inserted AS (
  INSERT INTO property_occupancies(
    id,organization_id,property_id,started_at,ended_at,end_reason,resident_name_at_start
  )
  SELECT occupancy_id,organization_id,property_id,started_at,ended_at,
         'Legacy history isolated during migration; household attribution requires review.',
         resident_name_at_start
  FROM archive_candidates
  RETURNING organization_id,property_id,id
)
INSERT INTO occupancy_legacy_archive_map(organization_id,property_id,occupancy_id)
SELECT organization_id,property_id,id FROM inserted;

UPDATE property_memberships pm
SET occupancy_id=archive.occupancy_id
FROM occupancy_legacy_archive_map archive
WHERE pm.organization_id=archive.organization_id AND pm.property_id=archive.property_id
  AND pm.ended_at IS NOT NULL;

UPDATE vehicles v
SET occupancy_id=archive.occupancy_id
FROM occupancy_legacy_archive_map archive
WHERE v.organization_id=archive.organization_id AND v.property_id=archive.property_id
  AND NOT v.active;

UPDATE property_occupancies o
SET started_at=COALESCE(LEAST(
      (SELECT MIN(pm.started_at)
                FROM property_memberships pm
                WHERE pm.organization_id=o.organization_id AND pm.property_id=o.property_id
                  AND pm.ended_at IS NULL),
      (SELECT MIN(a.started_at)
                FROM assignments a
                JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
                WHERE v.organization_id=o.organization_id AND v.occupancy_id=o.id AND v.active
                  AND a.ended_at IS NULL)
    ),o.started_at),
    resident_name_at_start=p.resident_name
FROM properties p
WHERE p.organization_id=o.organization_id AND p.id=o.property_id AND o.ended_at IS NULL;

-- Migration 007 used the migration clock when importing closed properties. Recover the bounds
-- from their memberships, assignments, and events when those timestamps exist.
WITH closed_evidence AS (
  SELECT o.id,o.started_at AS fallback_start,
         (SELECT MIN(pm.started_at) FROM property_memberships pm
          WHERE pm.organization_id=o.organization_id AND pm.occupancy_id=o.id) AS member_start,
         (SELECT MAX(pm.ended_at) FROM property_memberships pm
          WHERE pm.organization_id=o.organization_id AND pm.occupancy_id=o.id) AS member_end,
         (SELECT MIN(a.started_at) FROM assignments a
          JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
          WHERE v.organization_id=o.organization_id AND v.occupancy_id=o.id) AS assignment_start,
         (SELECT MAX(a.ended_at) FROM assignments a
          JOIN vehicles v ON v.id=a.vehicle_id AND v.organization_id=a.organization_id
          WHERE v.organization_id=o.organization_id AND v.occupancy_id=o.id) AS assignment_end,
         (SELECT MIN(e.received_at) FROM access_events e
          JOIN vehicles v ON v.id=e.vehicle_id AND v.organization_id=e.organization_id
          WHERE v.organization_id=o.organization_id AND v.occupancy_id=o.id) AS event_start,
         (SELECT MAX(e.received_at) FROM access_events e
          JOIN vehicles v ON v.id=e.vehicle_id AND v.organization_id=e.organization_id
          WHERE v.organization_id=o.organization_id AND v.occupancy_id=o.id) AS event_end
  FROM property_occupancies o
  WHERE o.ended_at IS NOT NULL AND o.resident_name_at_start=''
), closed_bounds AS (
  SELECT id,
         COALESCE(LEAST(member_start,assignment_start,event_start),fallback_start) AS started_at,
         member_end,assignment_end,event_end
  FROM closed_evidence
)
UPDATE property_occupancies o
SET started_at=b.started_at,
    ended_at=GREATEST(b.member_end,b.assignment_end,b.event_end,
                      b.started_at + interval '1 microsecond')
FROM closed_bounds b
WHERE o.id=b.id;

UPDATE property_occupancies o
SET resident_name_at_start=COALESCE(
      NULLIF((SELECT string_agg(DISTINCT u.name, ', ' ORDER BY u.name)
              FROM property_memberships pm
              JOIN organization_memberships m ON m.id=pm.membership_id
              JOIN users u ON u.id=m.user_id
              WHERE pm.organization_id=o.organization_id AND pm.occupancy_id=o.id),''),
      'Legacy household'
    ),
    end_reason=CASE WHEN o.end_reason='' THEN 'Legacy household history imported.' ELSE o.end_reason END
FROM properties p
WHERE p.organization_id=o.organization_id AND p.id=o.property_id
  AND o.ended_at IS NOT NULL AND o.resident_name_at_start='';
