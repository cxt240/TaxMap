const CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export async function geocode(address) {
  const text = normalize(address);
  const exact = await census(text);
  if (exact) return { ...exact, approximate: false, note: null };

  const parsed = parseAddress(text);
  if (!parsed) return null;
  const nearest = await nearestPublished(parsed);
  if (!nearest) return null;
  return {
    ...nearest.hit,
    approximate: true,
    note: `${parsed.number} ${parsed.street} is not in the address file. The pin is the nearest published number, ${nearest.hit.label}.`,
  };
}

async function nearestPublished(parsed) {
  const line = (number) => `${number} ${parsed.street}${parsed.rest}`;
  const tight = [];
  for (let delta = -120; delta <= 120; delta += 10) {
    const number = parsed.number + delta;
    if (number > 0 && number !== parsed.number) tight.push(number);
  }
  let hits = await probe(tight, line);
  if (!hits.length) {
    const coarse = [];
    for (let delta = -800; delta <= 800; delta += 100) {
      const number = Math.round(parsed.number / 100) * 100 + delta;
      if (number > 0 && number !== parsed.number) coarse.push(number);
    }
    hits = await probe(coarse, line);
  }
  hits.sort((a, b) => Math.abs(a.number - parsed.number) - Math.abs(b.number - parsed.number));
  return hits[0] ?? null;
}

async function probe(numbers, line) {
  const hits = await Promise.all(
    numbers.map(async (number) => {
      const hit = await census(line(number));
      return hit ? { number, hit } : null;
    }),
  );
  return hits.filter(Boolean);
}

function normalize(address) {
  return address
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bRoad\b/gi, "Rd")
    .replace(/\bStreet\b/gi, "St")
    .replace(/\bDrive\b/gi, "Dr")
    .replace(/\bLane\b/gi, "Ln")
    .replace(/,?\s+TX\b/i, ", TX")
    .replace(/,?\s+Texas\b/i, ", TX");
}

function parseAddress(text) {
  const match = text.match(/^(\d+)\s+([^,]+)/);
  if (!match) return null;
  const rest = text.slice(match[0].length).replace(/^,\s*/, "");
  return { number: Number(match[1]), street: match[2].trim(), rest: rest ? `, ${rest}` : "" };
}

async function census(address) {
  const url = new URL(CENSUS);
  url.searchParams.set("address", address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const body = await fetch(url).then((response) => response.json());
  const match = body?.result?.addressMatches?.[0];
  if (!match?.coordinates) return null;
  return { lng: match.coordinates.x, lat: match.coordinates.y, label: match.matchedAddress };
}
