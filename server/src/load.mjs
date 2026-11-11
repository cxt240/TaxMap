import fs from "node:fs";

const exemptions = {
  school: { exemption_amount: 140000, exemption_percent: 0 },
  city: { exemption_amount: 0, exemption_percent: 0.2 },
  county: { exemption_amount: 0, exemption_percent: 0.2 },
  health: { exemption_amount: 0, exemption_percent: 0.2 },
};

export async function loadJurisdictions(pool, dataDir) {
  const districtsFile = `${dataDir}/districts.geojson`;
  const countywideFile = `${dataDir}/countywide.json`;
  const districts = fs.existsSync(districtsFile)
    ? JSON.parse(fs.readFileSync(districtsFile, "utf8"))
    : { features: [] };
  const countywide = fs.existsSync(countywideFile) ? JSON.parse(fs.readFileSync(countywideFile, "utf8")) : [];
  if (!districts.features?.length) console.log("district overlay: none");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE rate_years, jurisdictions, jurisdiction_parts RESTART IDENTITY CASCADE");
    for (const feature of districts.features) {
      const name = feature.properties?.name;
      if (!name || /\bvfd$/i.test(name) || !feature.geometry) continue;
      await client.query(
        `INSERT INTO jurisdiction_parts (name, kind, tax_year, inputs, geom, state, source)
         VALUES ($1, $2, $3, $4::jsonb, ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)), 'TX', 'detail')`,
        [
          name,
          feature.properties.kind,
          feature.properties.year,
          JSON.stringify(inputsFor(feature.properties)),
          JSON.stringify(feature.geometry),
        ],
      );
    }
    await insertIncoming(client, process.env.INCOMING_DIR ?? "/incoming");
    await client.query(`
      INSERT INTO jurisdictions (state, name, kind, source, geom)
      SELECT state, name, kind, max(source),
             ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_UnaryUnion(ST_Collect(geom))), 3))
      FROM jurisdiction_parts
      GROUP BY state, name, kind
    `);
    await client.query(`
      INSERT INTO rate_years (jurisdiction_id, tax_year, inputs)
      SELECT DISTINCT ON (j.id) j.id, p.tax_year, p.inputs
      FROM jurisdictions j
      JOIN jurisdiction_parts p ON p.state = j.state AND p.name = j.name AND p.kind = j.kind
      WHERE j.countywide = false
      ORDER BY j.id, (
        p.inputs->>'rate_per_100' IS NULL
        AND p.inputs->>'mills' IS NULL
        AND p.inputs->>'effective_mills' IS NULL
        AND p.inputs->>'rate_per_1000' IS NULL
      ), p.tax_year DESC NULLS LAST
    `);
    for (const entity of countywide) {
      const inserted = await client.query(
        `INSERT INTO jurisdictions (state, name, kind, countywide, source) VALUES ('TX', $1, $2, true, 'detail') RETURNING id`,
        [entity.name, entity.kind],
      );
      await client.query(`INSERT INTO rate_years (jurisdiction_id, tax_year, inputs) VALUES ($1, $2, $3::jsonb)`, [
        inserted.rows[0].id,
        entity.year,
        JSON.stringify(inputsFor(entity)),
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function inputsFor(entity) {
  const extra = exemptions[entity.kind] ?? { exemption_amount: 0, exemption_percent: 0 };
  return { state: "TX", rate_per_100: entity.rate, ...extra };
}

export async function loadLevyAreas(pool, mapDir) {
  const file = `${mapDir}/levy-areas.geojson`;
  if (!fs.existsSync(file)) {
    console.log("levy areas: none");
    return;
  }
  const collection = JSON.parse(fs.readFileSync(file, "utf8"));
  const features = collection.features ?? [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE map_areas RESTART IDENTITY");
    const size = 25;
    for (let offset = 0; offset < features.length; offset += size) {
      const slice = features.slice(offset, offset + size).filter((feature) => feature.geometry && Number.isFinite(feature.properties?.rate));
      if (!slice.length) continue;
      await client.query(
        `INSERT INTO map_areas (rate, state, partial, label, geom)
         SELECT rate, state, partial, label, geom
         FROM (
           SELECT rate, state, partial, label,
                  ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(g), 4326)), 3)) AS geom
           FROM unnest($1::float8[], $2::text[], $3::int[], $4::text[], $5::text[])
             AS t(rate, state, partial, label, g)
         ) AS rows
         WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)`,
        [
          slice.map((feature) => feature.properties.rate),
          slice.map((feature) => feature.properties.state ?? null),
          slice.map((feature) => feature.properties.partial ?? 0),
          slice.map((feature) => feature.properties.label ?? null),
          slice.map((feature) => JSON.stringify(feature.geometry)),
        ],
      );
    }
    await client.query("COMMIT");
    console.log(`levy areas: ${features.length}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertIncoming(client, dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".geojson"));
  for (const file of files) {
    const collection = JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8"));
    for (const feature of collection.features ?? []) {
      const props = feature.properties ?? {};
      if (!props.name || !feature.geometry) continue;
      await client.query(
        `INSERT INTO jurisdiction_parts (name, kind, tax_year, inputs, geom, state, source)
         VALUES ($1, $2, $3, $4::jsonb, ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)), $6, $7)`,
        [
          props.name,
          props.kind,
          props.tax_year,
          JSON.stringify(props.inputs),
          JSON.stringify(feature.geometry),
          props.state,
          props.source ?? "incoming",
        ],
      );
    }
    console.log(`loaded ${file}`);
  }
}
