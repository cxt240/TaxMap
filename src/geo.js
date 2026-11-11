function ringContains(ring, [x, y]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

export function geometryContains(geometry, point) {
  const polygons =
    geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  return polygons.some((rings) => ringContains(rings[0], point) && !rings.slice(1).some((hole) => ringContains(hole, point)));
}

function geometryArea(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((sum, rings) => sum + ringArea(rings[0]), 0);
}

export function districtsAt(features, point) {
  const hits = features.filter(
    (feature) => !/\bvfd$/i.test(feature.properties.name) && geometryContains(feature.geometry, point),
  );
  const byKind = new Map();
  for (const hit of hits) {
    const kind = hit.properties.kind;
    const list = byKind.get(kind) ?? [];
    list.push(hit);
    byKind.set(kind, list);
  }
  const chosen = [];
  for (const list of byKind.values()) {
    chosen.push(list.reduce((best, hit) => (geometryArea(hit.geometry) < geometryArea(best.geometry) ? hit : best)));
  }
  return chosen.map((feature) => feature.properties);
}

export function boundsOf(collection) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (pair) => {
    if (!Array.isArray(pair) || pair.length < 2 || typeof pair[0] !== "number") {
      for (const child of pair ?? []) visit(child);
      return;
    }
    west = Math.min(west, pair[0]);
    east = Math.max(east, pair[0]);
    south = Math.min(south, pair[1]);
    north = Math.max(north, pair[1]);
  };
  for (const feature of collection.features) visit(feature.geometry.coordinates);
  return [west, south, east, north];
}
