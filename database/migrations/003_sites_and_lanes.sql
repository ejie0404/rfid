-- Sites own lanes. Recording lanes lets a guard's view be limited to the station they are
-- assigned to, and gives controller enrollment a real lane to reference.

CREATE TABLE IF NOT EXISTS lanes (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL,
 site_id uuid NOT NULL, name text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('entry','exit','bidirectional')),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,site_id) REFERENCES sites(organization_id,id)
);
CREATE INDEX IF NOT EXISTS lanes_by_site ON lanes(site_id);
