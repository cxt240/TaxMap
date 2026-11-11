CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS jurisdiction_parts (
  name text NOT NULL,
  kind text NOT NULL,
  tax_year integer,
  inputs jsonb NOT NULL,
  geom geometry(Geometry, 4326),
  state char(2),
  source text
);

CREATE TABLE IF NOT EXISTS jurisdictions (
  id serial PRIMARY KEY,
  state char(2) NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  countywide boolean NOT NULL DEFAULT false,
  geom geometry(MultiPolygon, 4326)
);

CREATE TABLE IF NOT EXISTS rate_years (
  jurisdiction_id integer PRIMARY KEY REFERENCES jurisdictions (id) ON DELETE CASCADE,
  tax_year integer,
  inputs jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS jurisdictions_geom_idx ON jurisdictions USING gist (geom);

CREATE TABLE IF NOT EXISTS map_areas (
  id serial PRIMARY KEY,
  rate double precision NOT NULL,
  state char(2),
  partial integer NOT NULL DEFAULT 0,
  label text,
  geom geometry(MultiPolygon, 4326)
);

CREATE INDEX IF NOT EXISTS map_areas_geom_idx ON map_areas USING gist (geom);

ALTER TABLE jurisdiction_parts ADD COLUMN IF NOT EXISTS state char(2);
ALTER TABLE jurisdiction_parts ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE jurisdictions ADD COLUMN IF NOT EXISTS source text;
