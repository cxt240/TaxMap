# TaxMap

A map of residential property-tax rates for the United States. Color is the tax as a percent of price, on one scale from 0.15% to 3.6%. Where the map uses Census estimates, counties are the broad fill and cities and towns are smaller polygons drawn on top, so they show as you zoom in. Where a published levy stack is loaded, the map uses that stack. Otherwise it uses the Census median. One unnamed county has district polygons stacked over the statewide layer.

Most of this project was written by an AI coding assistant. The tax rates were gathered by AI agents from public sources. The numbers can be wrong, incomplete, or out of date. They are not a bill, a tax opinion, or a substitute for the county assessor or treasurer. Census figures are medians of what owners paid, not the statutory levy.

## Report a rate

If you have the actual rate for a place, file a GitHub issue. Include the place, the tax year, the residential rate you paid or the official figure, and a link to the assessor or treasurer page.

An issue is not applied automatically. Updating the map means checking that source, putting the published residential figure in the rate tables, and rebuilding the map. A single place with a published bill is a small data change. A statewide levy table is larger.

## Run

```bash
docker compose up --build
```

Open http://localhost:8080. Compose starts PostGIS, the lookup API, and nginx for the map. The first start loads the polygons into PostGIS and can take several minutes.

`npm run dev` runs the Vite dev server. Address lookup is the API on the Docker stack. Vite has no `/api` proxy.

The map colors are GeoJSON copied into the web image at build time. After regenerating those files, run `docker compose up --build` again so nginx serves the new map. The API reads `public/` and `data/incoming/general/` from mounted volumes when its container starts.

## How rates are loaded

Map colors come from files built ahead of time. Address search is the exception: the API calls a geocoder.

`npm run data:update` does four steps:

1. **Unnamed county.** Downloads the workbook linked from that county's truth-in-taxation page into `data/rates-YYYY.xls`, and simplified polygons from the county tax-map site: school districts, city limits, municipal utility districts, emergency-service districts, water-control districts, and the county outline.
2. **Census.** `scripts/fetch-census-rates.mjs` reads American Community Survey 2020–2024 tables for median real estate tax and median home value, for counties, places, and county subdivisions, and writes `data/incoming/census/rates.csv`. The percent is median tax divided by median home value. When the published median tax is $10,001, that percent is a lower bound.
3. **Unnamed county stack.** `scripts/build-areas.mjs` keeps the newest numeric total for each jurisdiction and intersects the polygons so each piece has one school district, one city, one municipal utility district, one water-control district, and one emergency-service district at most, plus the countywide units. It writes `public/rate-areas.geojson`, `public/districts.geojson`, `public/countywide.json`, and `public/meta.json`. Names are normalized, and a few aliases align GIS labels with the rate table. A district with no posted rate is left out of the colored total. Outlines whose names end in VFD are left out of the database.
4. **Loaded tables.** `scripts/build-general.mjs` joins the Census rates and the levy tables under `data/incoming/` to Census TIGER shapes. It writes `data/incoming/general/states.geojson`. A published levy stack is kept where one is loaded. Otherwise the map uses the Census medians. A full community bill from a county sheet is drawn on top where one is loaded.

`npm run data` rebuilds only the unnamed-county stack. Rebuild the country map with `node scripts/build-map-layer.mjs`, which writes `public/state-areas.geojson` from `states.geojson`. `npm run data:update` does not run that step.

On startup the API loads the unnamed county's districts and every GeoJSON file in `data/incoming/general/` into PostGIS (`jurisdiction_parts`, `jurisdictions`, `rate_years`).

## What the map shows

The page is a MapLibre map on the CARTO Positron basemap. On load it fetches `state-areas.geojson` and `rate-areas.geojson` and paints both with the same yellow-to-brown ramp, from 0.15% of price to 3.6%.

- **Country view.** For Census areas, each county is colored by median tax divided by median home value for owner-occupied homes (homes with a mortgage when both medians are published, otherwise all owner-occupied homes). That figure is what owners paid, applied as a flat percent of the offer.
- **Zoomed-in cities.** Census places are separate polygons on top of the county. In the town and township areas handled by `scripts/build-general.mjs`, a town polygon is drawn where a city does not already cover it. A city or town rate replaces the county rate for that land. The lookup keeps the finest of city, town, township, and county.
- **Levy or Census.** Where a published levy stack is loaded, that stack is converted to a percent of price and drawn. Mill levies use the residential assessment ratio stored in the loader. A town table uses municipal, county, local education, and state education rates, converted with that town's equalization ratio when one is on file. Otherwise the fill is the Census median. A full residential community rate from a county sheet is drawn on top where one is loaded. A school-only rate stays in the pin and off the fill.
- **Unnamed county.** `rate-areas.geojson` is the stacked district layer and is drawn over the statewide polygons. Its color is the sum of adopted rates before the homestead sketch.

## Lookup

A click, an address, or a pasted latitude and longitude calls `GET /api/lookup`. PostGIS returns the jurisdictions that contain the point, and the API turns each stored input into dollars and a percent of the offer. The default offer is $650,000.

Address search uses the Census geocoder. If that house number is missing, the API pins the nearest published number on the street and says so.

A pin lists separate lines only when the loaded file published the pieces:

- A Census area is one median for the place, town, or county.
- The unnamed county lists the districts at the point, including a special district when its boundary matched. A line with no rate is marked "not posted."
- Where a statewide levy file is loaded, the pin lists the pieces that file published for the point, including districts assigned to that whole county. Partial-county utility districts belong to the unnamed county layer, and they are absent from a statewide file that does not include them.
- Where the loaded file lists school, city, and county, the pin lists those. Where a regional flood district covers the point, the pin lists it too.
- Where the loaded file lists municipal, county, local education, and state education, the pin lists those. Village districts are left out. With no equalization ratio on file, the percent is of assessed value.
- Where a county sheet was loaded, the pin lists one full community total, using the sheet's percent of market when it publishes one. Otherwise the pin is the school district Class I rate, assessed at 35% of price. City, county, library, and career-center levies are outside that school-only figure.

Where a homestead sketch is loaded, the panel can sketch $140,000 off the school base, and 20% off the city, county, and health district. Other districts stay on the full price. The map color stays the before-exemption percent. The sketch leaves out the 10% homestead appraisal cap.

## Tax years

Each file keeps its own year. The unnamed county workbook is multi-year, and each jurisdiction uses the latest year with a numeric adopted total. Census figures are the 2020–2024 American Community Survey. The panel prints the year when it is not 2026. A levy that is missing from the loaded file is missing from the map. Refresh with `npm run data:update`, then `node scripts/build-map-layer.mjs`.
