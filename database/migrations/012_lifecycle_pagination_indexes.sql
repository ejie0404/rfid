CREATE INDEX IF NOT EXISTS properties_by_label_ci
  ON properties(organization_id,lower(label),id);
CREATE INDEX IF NOT EXISTS properties_by_resident_name_ci
  ON properties(organization_id,lower(resident_name),id);
CREATE INDEX IF NOT EXISTS properties_by_label_prefix
  ON properties(organization_id,lower(label) text_pattern_ops);
CREATE INDEX IF NOT EXISTS properties_by_resident_prefix
  ON properties(organization_id,lower(resident_name) text_pattern_ops);
CREATE INDEX IF NOT EXISTS memberships_by_property_page
  ON property_memberships(organization_id,property_id,started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS occupancies_by_org_page
  ON property_occupancies(organization_id,started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS vehicle_changes_by_status_page
  ON vehicle_change_requests(organization_id,status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS vehicle_changes_by_prior_plate
  ON vehicle_change_requests(organization_id,lower(prior_plate) text_pattern_ops);
CREATE INDEX IF NOT EXISTS vehicle_changes_by_proposed_plate
  ON vehicle_change_requests(organization_id,lower(proposed_plate) text_pattern_ops);
CREATE INDEX IF NOT EXISTS replacements_by_status_page
  ON credential_replacement_requests(organization_id,status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS retirements_by_status_page
  ON vehicle_retirement_requests(organization_id,status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS move_outs_by_status_page
  ON scheduled_move_outs(organization_id,status,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS vehicles_by_plate_prefix
  ON vehicles(organization_id,lower(plate) text_pattern_ops);
