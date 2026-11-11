import fs from "node:fs";
import http from "node:http";
import pg from "pg";
import { geocode } from "./geocode.mjs";
import { loadLevyAreas, loadJurisdictions } from "./load.mjs";
import { selectRows, summarize } from "./tax.mjs";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const dataDir = process.env.DATA_DIR ?? "/data";
const kindOrder = ["school", "city", "town", "township", "county", "health", "college", "hospital", "flood", "port", "education", "state_education", "mud", "esd", "wcid", "special"];

const lookupSql = `
  SELECT DISTINCT ON (j.kind)
    j.name, j.kind, j.state, j.source, r.tax_year, r.inputs
  FROM jurisdictions j
  JOIN rate_years r ON r.jurisdiction_id = j.id
  WHERE j.countywide = false
    AND j.geom IS NOT NULL
    AND ST_Intersects(j.geom, ST_SetSRID(ST_Point($1, $2), 4326))
  ORDER BY j.kind,
    CASE WHEN r.inputs->>'basis' = 'census-acs' THEN 1 ELSE 0 END,
    ST_Area(j.geom::geography)
`;

function finestCensus(rows) {
  const rank = { city: 0, town: 1, township: 2, county: 3 };
  let best = null;
  let bestRank = Infinity;
  for (const row of rows) {
    if (row.inputs?.basis !== "census-acs") continue;
    const score = rank[row.kind] ?? 9;
    if (score < bestRank) {
      best = row;
      bestRank = score;
    }
  }
  if (!best) return rows;
  return rows.filter((row) => row.inputs?.basis !== "census-acs" || row === best);
}

function rowsForBill(rows) {
  const ranked = finestCensus(rows);
  const hasStatutoryBill = ranked.some((row) => row.inputs?.stack === "total" && row.inputs?.basis !== "census-acs");
  if (!hasStatutoryBill) return ranked;
  return ranked.filter((row) => row.inputs?.basis !== "census-acs");
}

async function rowsAt(lng, lat) {
  const spatial = await pool.query(lookupSql, [lng, lat]);
  const spatialRows = rowsForBill(spatial.rows);
  if (!spatialRows.length) return [];
  const detailed = spatialRows.some((row) => row.source === "detail");
  if (!detailed) {
    spatialRows.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind));
    return spatialRows;
  }
  const countywide = await pool.query(
    `SELECT j.name, j.kind, j.state, j.source, r.tax_year, r.inputs
     FROM jurisdictions j
     JOIN rate_years r ON r.jurisdiction_id = j.id
     WHERE j.countywide AND j.state = $1`,
    [spatialRows[0].state],
  );
  const names = new Set(spatialRows.map((row) => row.name));
  const rows = [...spatialRows, ...countywide.rows.filter((row) => !names.has(row.name))];
  rows.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind));
  return rows;
}

async function lookup(url) {
  const price = Number(url.searchParams.get("price") ?? 650000);
  const homestead = url.searchParams.get("homestead") !== "0";
  let lng = Number(url.searchParams.get("lng"));
  let lat = Number(url.searchParams.get("lat"));
  let label = null;
  let approximate = false;
  let note = null;
  const address = url.searchParams.get("address");
  if (address) {
    const place = await geocode(address);
    if (!place) return { status: 404, body: { error: "No match for that address." } };
    lng = place.lng;
    lat = place.lat;
    label = place.label;
    approximate = place.approximate;
    note = place.note;
  }
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return { status: 400, body: { error: "Give an address or a map point." } };
  }
  const rows = await rowsAt(lng, lat);
  const chosen = selectRows(rows);
  const bill = summarize(chosen, price, homestead);
  return {
    status: 200,
    body: { label, approximate, note, lng, lat, price, homestead, state: chosen[0]?.state?.trim() ?? null, ...coverage(chosen), ...bill },
  };
}

function coverage(rows) {
  const state = rows[0]?.state?.trim();
  if (rows.some((row) => row.inputs?.basis === "census-acs")) {
    const area = rows.find((row) => row.inputs?.basis === "census-acs");
    const capped = Number(area?.inputs?.median_tax) >= 10000;
    const where =
      area?.kind === "city" ? "this place" : area?.kind === "town" || area?.kind === "township" ? "this town" : "this county";
    const homes =
      area?.inputs?.universe === "all-owners" ? "owner-occupied homes" : "owner-occupied homes with a mortgage";
    return {
      scope: "census",
      coverageNote:
        `Census Bureau American Community Survey, 2020–2024. The rate is median real estate tax divided by median home value for ${homes} in ${where}, when both figures are published. It is applied as a flat percent of the offer. It is the tax current owners pay, not the statutory levy on a new purchase.${capped ? " The median tax is top-coded at $10,001, so this percent is a lower bound." : ""}`,
    };
  }
  if (rows.some((row) => row.inputs?.schedule === "vt-homestead")) {
    return {
      scope: "full",
      coverageNote:
        "Homestead education, municipal, and local-agreement rates from the Vermont Department of Taxes for tax year 2025, converted from listed value with this town's common level of appraisal. Sub-municipal districts and the income-based property tax credit are not included.",
    };
  }
  if (rows.some((row) => row.inputs?.schedule === "md-fy2027")) {
    return {
      scope: "full",
      coverageNote:
        "State, county, and municipal real-property rates for fiscal year 2027 from the Maryland State Department of Assessments and Taxation. Rates are per $100 of full assessed value, and the county rate includes schools. The homestead credit cap is not applied.",
    };
  }
  if (rows.some((row) => row.inputs?.stack === "total")) {
    const beforeCredits = rows.some((row) => row.inputs?.credits === "before");
    const sheetCredits = rows.some((row) => row.inputs?.credits === "after");
    return {
      scope: "full",
      coverageNote: beforeCredits
        ? "Full residential effective rate for this community from the county tax-rate sheet. The sheet did not publish an after-credit percent, so this is before the 10% non-business credit and the 2.5% owner-occupancy credit."
        : sheetCredits
          ? "Full residential bill for this community from the county tax-rate sheet, after the sheet's non-business and owner-occupancy credits."
          : "Full residential bill for this community: school, city, county, and the other local levies, after the homeowner credits on the county tax-rate sheet.",
    };
  }
  if (state === "OH") {
    return {
      scope: "school",
      coverageNote:
        "School district Class I rate only. City, county, library, and career-center levies are not included. The countywide average millage is not added, because that average already includes school taxes.",
    };
  }
  if (state === "CO") {
    const flood = rows.some((row) => row.kind === "special");
    return {
      scope: "partial",
      coverageNote: flood
        ? "School, city, and county levies, plus the Mile High flood district inside Denver. Other special districts are omitted."
        : "School, city, and county levies that have a boundary. Special districts are omitted.",
    };
  }
  if (state === "NH") {
    const ratios = rows.flatMap((row) => row.inputs?.components ?? []).map((component) => Number(component.equalization_ratio ?? 1));
    const applied = ratios.some((ratio) => ratio > 0 && ratio < 1);
    return applied
      ? {
          scope: "town",
          coverageNote:
            "Municipal, county, local education, and state education, converted from assessed value to the sale price with this town's 2025 equalization ratio. Village districts are omitted.",
        }
      : {
          scope: "town",
          percentBasis: "assessed",
          coverageNote:
            "Municipal, county, local education, and state education rates per $1,000 of assessed value. No 2025 equalization ratio is on file for this town, so the percent is of assessed value. Village districts are omitted.",
        };
  }
  if (rows.some((row) => row.source === "detail")) {
    return {
      scope: "parcel",
      coverageNote: "Districts at this point. A special district is included when its boundary matched.",
    };
  }
  if (state === "TX") {
    return {
      scope: "partial",
      coverageNote: rows.some((row) => ["college", "hospital", "flood", "port", "education"].includes(row.kind))
        ? "School, city, and county, plus the college, hospital, flood, port, and education districts the Comptroller shows covering this whole county. Utility districts and other special districts that cover only part of the county are not included."
        : "School, city, and county rates. Municipal utility districts and other special districts are not in the statewide file.",
    };
  }
  return { scope: "partial", coverageNote: "Districts with both a rate and a boundary. This may not be the whole bill." };
}

function displayRate(row) {
  const inputs = row.inputs ?? {};
  const state = String(row.state ?? "").trim();
  if (inputs.basis === "census-acs" || (inputs.stack === "total" && inputs.percent_of_market != null)) {
    const rate = Number(inputs.percent_of_market);
    return Number.isFinite(rate) ? rate : null;
  }
  if (state === "NH") {
    const rate = (inputs.components ?? []).reduce((sum, component) => {
      const ratio = Number(component.equalization_ratio ?? 1);
      return sum + (Number(component.rate_per_1000 || 0) / 10) * ratio;
    }, 0);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  }
  if (state === "OH" && inputs.stack === "total" && inputs.percent_of_market != null) {
    const rate = Number(inputs.percent_of_market);
    return Number.isFinite(rate) ? rate : null;
  }
  return null;
}

function paintRank(row) {
  const inputs = row.inputs ?? {};
  if (inputs.basis === "census-acs") return row.kind === "city" ? 1 : 0;
  return 2;
}

const placeSql = `
  SELECT j.name, j.kind, j.state, r.inputs, ST_AsGeoJSON(j.geom)::json AS geometry
  FROM jurisdictions j
  JOIN rate_years r ON r.jurisdiction_id = j.id
  WHERE j.countywide = false
    AND j.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
    AND j.kind IN ('city', 'town', 'township')
    AND j.state NOT IN ('TX', 'CO')
    AND (
      j.state <> 'OH'
      OR r.inputs->>'basis' = 'census-acs'
      OR (r.inputs->>'stack' = 'total' AND r.inputs ? 'percent_of_market')
    )
  ORDER BY CASE
    WHEN r.inputs->>'basis' = 'census-acs' AND j.kind = 'city' THEN 1
    WHEN r.inputs->>'basis' = 'census-acs' THEN 0
    ELSE 2
  END, j.id
`;

const levySql = `
  SELECT rate, state, partial, label, ST_AsGeoJSON(geom)::json AS geometry
  FROM map_areas
  WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
`;

async function areasIn(url) {
  const west = Number(url.searchParams.get("west"));
  const south = Number(url.searchParams.get("south"));
  const east = Number(url.searchParams.get("east"));
  const north = Number(url.searchParams.get("north"));
  if (![west, south, east, north].every(Number.isFinite) || !(west < east) || !(south < north)) {
    return { status: 400, body: { error: "Give a west, south, east, and north bounding box." } };
  }
  if (east - west > 60 || north - south > 40) {
    return { status: 200, body: { type: "FeatureCollection", features: [] } };
  }
  const [places, levies] = await Promise.all([
    pool.query(placeSql, [west, south, east, north]),
    pool.query(levySql, [west, south, east, north]),
  ]);
  const features = [];
  for (const row of places.rows) {
    const rate = displayRate(row);
    if (!Number.isFinite(rate) || !row.geometry) continue;
    features.push({
      type: "Feature",
      properties: {
        rate: Math.round(rate * 1000) / 1000,
        state: String(row.state ?? "").trim(),
        partial: 0,
        label: row.name,
        rank: paintRank(row),
      },
      geometry: row.geometry,
    });
  }
  features.sort((a, b) => a.properties.rank - b.properties.rank);
  for (const feature of features) delete feature.properties.rank;
  for (const row of levies.rows) {
    if (!row.geometry || !Number.isFinite(Number(row.rate))) continue;
    features.push({
      type: "Feature",
      properties: {
        rate: Number(row.rate),
        state: String(row.state ?? "").trim(),
        partial: row.partial ?? 0,
        label: row.label,
      },
      geometry: row.geometry,
    });
  }
  return { status: 200, body: { type: "FeatureCollection", features } };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if (url.pathname === "/api/health") return send(response, 200, { ok: true });
    if (url.pathname === "/api/lookup") {
      const result = await lookup(url);
      return send(response, result.status, result.body);
    }
    if (url.pathname === "/api/areas") {
      const result = await areasIn(url);
      return send(response, result.status, result.body);
    }
    send(response, 404, { error: "Not found" });
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : "Lookup failed" });
  }
});

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const schema = fs.readFileSync(new URL("../sql/schema.sql", import.meta.url), "utf8");
for (let attempt = 1; attempt <= 30; attempt++) {
  try {
    await pool.query(schema);
    break;
  } catch (error) {
    if (attempt === 30) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
await loadJurisdictions(pool, dataDir);
await loadLevyAreas(pool, process.env.MAP_DIR ?? "/map");
server.listen(3000, () => console.log("taxmap api listening on 3000"));
