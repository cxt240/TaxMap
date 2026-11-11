import { useEffect, useRef, useState } from "react";
import { Map, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";

setWorkerUrl(workerUrl);

function money(value) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function percent(value) {
  return value == null ? "—" : `${value.toFixed(2)}%`;
}

function mapIntro(selection) {
  const scale = "Color is the tax as a percent of price, on one scale from 0.15% to 3.6%.";
  if (!selection?.lines?.length) return `${scale} Select a place to see which file colors that state.`;
  if (selection.scope === "census") {
    const kind = selection.lines?.[0]?.kind;
    const area = kind === "city" ? "place" : kind === "town" || kind === "township" ? "town" : "county";
    return `${scale} This ${area} uses the Census 2020–2024 effective rate: median tax paid divided by median home value.`;
  }
  if (selection.state === "TX") {
    return selection.scope === "parcel"
      ? `${scale} This county uses its district layer.`
      : `${scale} This part of Texas uses the Comptroller levy file.`;
  }
  if (selection.state === "NH") return `${scale} This town uses the New Hampshire levy file.`;
  if (selection.state === "CO") return `${scale} This place uses Colorado mill levies.`;
  if (selection.state === "OH") {
    return selection.scope === "full"
      ? `${scale} This community uses the county’s full residential rate.`
      : `${scale} This part of Ohio uses the school district Class I rate only.`;
  }
  return scale;
}

function methodNote(selection) {
  const parts = ["The color is a percent of price, from 0.15% to 3.6%."];
  if (selection.coverageNote) parts.push(selection.coverageNote);
  if (selection.state === "TX") {
    parts.push("The homestead checkbox applies Texas exemption rules on these lines, and the map color is the rate before that sketch.");
  }
  parts.push("This is not a tax bill.");
  return parts.join(" ");
}

const detailZoom = 7;
const countryCenter = [-98.5, 39.5];
const countryZoom = 3.5;

const fillColor = [
  "interpolate",
  ["linear"],
  ["get", "rate"],
  0.15,
  "#ffffe5",
  0.4,
  "#fff7bc",
  1.1,
  "#fec44f",
  1.8,
  "#fe9929",
  2.6,
  "#ec7014",
  3.6,
  "#993404",
];

function normalizePair(lat, lng) {
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat];
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function parseCoordinates(text) {
  const raw = text.trim();
  const pin = raw.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const query = raw.match(/[?&](?:q|ll|query)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  const at = raw.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  const hemisphere = raw.match(/(\d+(?:\.\d+)?)°?\s*([NS])\s*,?\s*(\d+(?:\.\d+)?)°?\s*([EW])/i);
  const pair = raw.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (pin) return normalizePair(Number(pin[1]), Number(pin[2]));
  if (query) return normalizePair(Number(query[1]), Number(query[2]));
  if (at) return normalizePair(Number(at[1]), Number(at[2]));
  if (hemisphere) {
    const lat = Number(hemisphere[1]) * (hemisphere[2].toUpperCase() === "S" ? -1 : 1);
    const lng = Number(hemisphere[3]) * (hemisphere[4].toUpperCase() === "W" ? -1 : 1);
    return normalizePair(lat, lng);
  }
  if (pair) return normalizePair(Number(pair[1]), Number(pair[2]));
  return null;
}

export function App() {
  const mapNode = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const [status, setStatus] = useState("Loading counties…");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [coordinates, setCoordinates] = useState("");
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState(null);
  const [selection, setSelection] = useState(null);
  const [price, setPrice] = useState(650000);
  const [homestead, setHomestead] = useState(true);

  useEffect(() => {
    const map = new Map({
      container: mapNode.current,
      style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
      center: countryCenter,
      zoom: countryZoom,
    });
    map.addControl(new NavigationControl(), "top-right");
    mapRef.current = map;
    map.on("click", (event) => setTarget({ lng: event.lngLat.lng, lat: event.lngLat.lat }));
    let cache = null;
    let timer = 0;
    let requestId = 0;
    let inflight = null;
    let ratesLoaded = false;
    const empty = { type: "FeatureCollection", features: [] };

    function viewInsideCache() {
      if (!cache) return false;
      const bounds = map.getBounds();
      return (
        bounds.getWest() >= cache.west &&
        bounds.getEast() <= cache.east &&
        bounds.getSouth() >= cache.south &&
        bounds.getNorth() <= cache.north
      );
    }

    function showDetailLayers() {
      const visibility = map.getZoom() >= detailZoom ? "visible" : "none";
      if (map.getLayer("detail")) map.setLayoutProperty("detail", "visibility", visibility);
      if (map.getLayer("rates")) map.setLayoutProperty("rates", "visibility", visibility);
    }

    async function loadDetail() {
      if (!map.getSource("detail")) return;
      const show = map.getZoom() >= detailZoom;
      showDetailLayers();
      if (!show) return;
      if (!ratesLoaded) {
        const response = await fetch("/rate-areas.geojson");
        const areas = response.ok ? await response.json() : empty;
        if (map.getZoom() < detailZoom) return;
        map.getSource("rates")?.setData(areas);
        ratesLoaded = true;
        showDetailLayers();
      }
      if (viewInsideCache()) return;
      const bounds = map.getBounds();
      const west = bounds.getWest();
      const south = bounds.getSouth();
      const east = bounds.getEast();
      const north = bounds.getNorth();
      if (!(west < east) || !(south < north)) return;
      const padX = (east - west) * 0.4;
      const padY = (north - south) * 0.4;
      const box = {
        west: west - padX,
        south: Math.max(-85, south - padY),
        east: east + padX,
        north: Math.min(85, north + padY),
      };
      inflight?.abort();
      const abort = new AbortController();
      inflight = abort;
      const id = ++requestId;
      const params = new URLSearchParams({
        west: box.west.toFixed(4),
        south: box.south.toFixed(4),
        east: box.east.toFixed(4),
        north: box.north.toFixed(4),
      });
      try {
        const response = await fetch(`/api/areas?${params}`, { signal: abort.signal });
        const body = await response.json();
        if (id !== requestId) return;
        if (!response.ok) throw new Error(body.error ?? "City detail did not load.");
        cache = box;
        map.getSource("detail")?.setData(body);
      } catch (detailError) {
        if (detailError.name === "AbortError") return;
      }
    }

    function scheduleDetail() {
      showDetailLayers();
      window.clearTimeout(timer);
      timer = window.setTimeout(loadDetail, 200);
    }

    map.on("moveend", scheduleDetail);
    map.on("load", async () => {
      try {
        const counties = await fetch("/county-areas.geojson").then((response) => response.json());
        map.addSource("counties", { type: "geojson", data: counties });
        map.addLayer({
          id: "counties",
          type: "fill",
          source: "counties",
          paint: {
            "fill-color": fillColor,
            "fill-opacity": ["case", ["==", ["get", "partial"], 1], 0.35, 0.72],
            "fill-outline-color": "rgba(80, 40, 10, 0.15)",
          },
        });
        map.addSource("detail", { type: "geojson", data: empty });
        map.addLayer({
          id: "detail",
          type: "fill",
          source: "detail",
          layout: { visibility: map.getZoom() >= detailZoom ? "visible" : "none" },
          paint: { "fill-color": fillColor, "fill-opacity": 1, "fill-outline-color": "rgba(80, 40, 10, 0.25)" },
        });
        map.addSource("rates", { type: "geojson", data: empty });
        map.addLayer({
          id: "rates",
          type: "fill",
          source: "rates",
          layout: { visibility: map.getZoom() >= detailZoom ? "visible" : "none" },
          paint: { "fill-color": fillColor, "fill-opacity": 0.78, "fill-outline-color": "rgba(80, 40, 10, 0.2)" },
        });
        map.getCanvas().style.cursor = "pointer";
        setStatus("");
        scheduleDetail();
      } catch (loadError) {
        setStatus("");
        setError(loadError instanceof Error ? loadError.message : "The map data did not load.");
      }
    });
    return () => {
      window.clearTimeout(timer);
      inflight?.abort();
      markerRef.current?.remove();
      map.remove();
    };
  }, []);

  useEffect(() => {
    if (!target) return;
    const params = new URLSearchParams({
      price: String(Number.isFinite(price) ? price : 0),
      homestead: homestead ? "1" : "0",
    });
    if (target.address) params.set("address", target.address);
    else {
      params.set("lng", String(target.lng));
      params.set("lat", String(target.lat));
    }
    const controller = new AbortController();
    setSearching(true);
    setError("");
    fetch(`/api/lookup?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Lookup failed");
        return body;
      })
      .then((body) => {
        if (!body.label && target.lat != null) {
          body = { ...body, label: `${target.lat.toFixed(5)}, ${target.lng.toFixed(5)}` };
        }
        setSelection(body);
        if (!mapRef.current) return;
        if (!markerRef.current) markerRef.current = new Marker({ color: "#9a3412" }).setLngLat([body.lng, body.lat]).addTo(mapRef.current);
        else markerRef.current.setLngLat([body.lng, body.lat]);
        if (target.address || target.fly) mapRef.current.flyTo({ center: [body.lng, body.lat], zoom: 15 });
      })
      .catch((lookupError) => {
        if (lookupError.name === "AbortError") return;
        setError(lookupError.message);
      })
      .finally(() => setSearching(false));
    return () => controller.abort();
  }, [target, price, homestead]);

  function search(event) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    setTarget({ address: text });
  }

  function searchCoordinates(event) {
    event.preventDefault();
    const point = parseCoordinates(coordinates);
    if (!point) {
      setError("Paste a latitude and longitude, like 39.00, -98.00, or a Google Maps link.");
      return;
    }
    setError("");
    setTarget({ ...point, fly: true });
  }

  return (
    <>
      <div ref={mapNode} className="map" />
      <aside className="panel">
        <h1>Property tax map</h1>
        <p className="sub">{mapIntro(selection)}</p>
        <form onSubmit={search}>
          <input
            type="search"
            value={query}
            placeholder="Address"
            aria-label="Address"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="submit" disabled={searching}>
            {searching ? "…" : "Find"}
          </button>
        </form>
        <form onSubmit={searchCoordinates}>
          <input
            type="text"
            value={coordinates}
            placeholder="39.00, -98.00"
            aria-label="Latitude and longitude"
            onChange={(event) => setCoordinates(event.target.value)}
          />
          <button type="submit" disabled={searching}>
            {searching ? "…" : "Drop"}
          </button>
        </form>
        <p className="hint">In Google Maps, right-click the building and copy the coordinates, or paste the maps link.</p>
        <div className="legend">
          <div className="ramp" />
          <div className="legend-labels">
            <span>0.15% of price</span>
            <span>3.60% of price</span>
          </div>
        </div>
        {status && <p className="empty">{status}</p>}
        {error && <p className="error">{error}</p>}
        {selection && !selection.lines.length && (
          <div className="place">
            <p className="empty">That point is outside the states loaded so far.</p>
          </div>
        )}
        {selection && selection.lines.length > 0 && (
          <div className="place">
            {selection.label && <p className="sub">{selection.label}</p>}
            {selection.note && <p className="note">{selection.note}</p>}
            <p className="total">
              {percent(selection.scenarioPercent)}{" "}
              <span>{selection.percentBasis === "assessed" ? "of assessed value" : "of this offer"}</span>
            </p>
            <table className="stack">
              <tbody>
                {selection.lines.map((line) => (
                  <tr key={line.name}>
                    <td>
                      {line.name}
                      {line.taxYear && line.taxYear !== 2026 ? ` (${line.taxYear})` : ""}
                      <div className="sub">{line.detail}</div>
                    </td>
                    <td className={line.missing ? "missing" : undefined}>
                      {line.dollars == null ? "not posted" : money(line.dollars)}
                      <div className="sub">{percent(line.percentOfOffer)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="estimate">
              <label>
                Offer price
                <input
                  type="number"
                  min="0"
                  step="1000"
                  value={price}
                  onChange={(event) => setPrice(Number(event.target.value))}
                />
              </label>
              {selection.state === "TX" && (
                <label className="homestead">
                  <input type="checkbox" checked={homestead} onChange={(event) => setHomestead(event.target.checked)} />
                  Rough homestead exemptions
                </label>
              )}
              <div className="row">
                <span>{homestead && selection.state === "TX" ? "With Texas homestead sketch" : "Listed districts"}</span>
                <strong>{money(selection.totalDollars)}</strong>
              </div>
              {selection.state === "TX" && (
                <div className="row">
                  <span>Before exemptions</span>
                  <strong>{percent(selection.basePercent)}</strong>
                </div>
              )}
            </div>
            <p className="note">{methodNote(selection)}</p>
          </div>
        )}
      </aside>
    </>
  );
}
