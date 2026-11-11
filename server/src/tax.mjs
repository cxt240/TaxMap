const kindRank = { city: 0, town: 1, township: 2, county: 3 };

function finest(rows) {
  return rows.slice().sort((a, b) => {
    const byKind = (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9);
    if (byKind) return byKind;
    return (a.inputs?.basis === "census-acs" ? 1 : 0) - (b.inputs?.basis === "census-acs" ? 1 : 0);
  })[0];
}

export function selectRows(rows) {
  const stacks = rows.filter((row) => row.inputs?.stack === "total");
  if (!stacks.length) {
    const statutory = rows.filter((row) => row.inputs?.basis !== "census-acs");
    return statutory.length ? statutory : rows;
  }
  const statutory = stacks.filter((row) => row.inputs?.basis !== "census-acs");
  const census = stacks.filter((row) => row.inputs?.basis === "census-acs");
  if (!statutory.length) return [finest(census)];
  const bestStatutory = finest(statutory);
  const bestCensus = census.length ? finest(census) : null;
  if (bestCensus && (kindRank[bestCensus.kind] ?? 9) < (kindRank[bestStatutory.kind] ?? 9) && !bestStatutory.inputs?.coversPlaces) {
    return [bestCensus];
  }
  return [bestStatutory];
}

export function linesFor(row, price, homestead) {
  const inputs = row.inputs ?? {};
  const state = inputs.state ?? row.state;
  if (Array.isArray(inputs.components) && inputs.components.length) {
    return inputs.components.map((component) => componentLine(row, component, price));
  }
  if (inputs.piece && inputs.percent_of_market != null) return [pieceLine(row, inputs, price)];
  if (inputs.stack === "total" && inputs.percent_of_market != null) {
    const pct = Number(inputs.percent_of_market);
    if (!Number.isFinite(pct) || price <= 0) return [blank(row, "Rate not posted")];
    const dollars = (price * pct) / 100;
    const detail =
      inputs.basis === "census-acs"
        ? `Census effective rate, ${pct.toFixed(2)}% of home value. Median tax $${Number(inputs.median_tax).toLocaleString("en-US")} on a median value of $${Number(inputs.median_value).toLocaleString("en-US")} for owner-occupied homes${inputs.universe === "mortgaged" ? " with a mortgage" : ""}, American Community Survey 2020–2024.${Number(inputs.median_tax) >= 10000 ? " The median tax is top-coded at $10,001, so this percent is a lower bound." : ""}`
        : inputs.credits === "before"
          ? `Full residential effective rate, ${inputs.effective_mills} mills, ${pct.toFixed(2)}% of market before the non-business and owner-occupancy credits.`
          : inputs.credits === "after"
            ? `Full residential bill, ${inputs.effective_mills} effective mills, ${pct}% of market after the non-business and owner-occupancy credits.`
            : `Full residential bill, ${inputs.effective_mills} effective mills, ${pct}% of market after homeowner credits.`;
    return [
      {
        name: row.name,
        kind: row.kind,
        taxYear: row.tax_year,
        dollars,
        percentOfOffer: pct,
        detail,
        missing: false,
      },
    ];
  }
  if (state === "TX") return [texasLine(row, inputs, price, homestead)];
  if (state === "CO") return [rateOnAssessed(row, inputs, price, inputs.mills, "mills")];
  if (state === "OH") return [rateOnAssessed(row, inputs, price, inputs.effective_mills ?? inputs.voted_mills, "mills")];
  if (state === "NH") return [perThousand(row, inputs, price)];
  return [blank(row, "No tax rule for this state yet")];
}

function blank(row, detail) {
  return {
    name: row.name,
    kind: row.kind,
    taxYear: row.tax_year,
    dollars: null,
    percentOfOffer: null,
    detail,
    missing: true,
  };
}

function pieceLine(row, inputs, price) {
  const pct = Number(inputs.percent_of_market);
  if (!Number.isFinite(pct) || price <= 0) return blank(row, "Rate not posted");
  return {
    name: row.name,
    kind: row.kind,
    taxYear: row.tax_year,
    dollars: (price * pct) / 100,
    percentOfOffer: pct,
    detail: inputs.detail ?? `${pct}% of market value`,
    missing: false,
  };
}

function componentLine(row, component, price) {
  const parent = row.inputs ?? {};
  const child = {
    ...row,
    name: component.name ?? row.name,
    kind: component.kind ?? row.kind,
    inputs: { state: component.state ?? parent.state, ...component },
  };
  delete child.inputs.components;
  return linesFor(child, price, false)[0];
}

function rateOnAssessed(row, inputs, price, mills, label) {
  const ratio = Number(inputs.assessment_ratio);
  if (mills == null || !Number.isFinite(ratio) || price <= 0) return blank(row, "Rate not posted");
  const dollars = price * ratio * Number(mills) / 1000;
  return {
    name: row.name,
    kind: row.kind,
    taxYear: row.tax_year,
    dollars,
    percentOfOffer: (dollars / price) * 100,
    detail: `${Number(mills).toFixed(3)} ${label} on ${Math.round(ratio * 1000) / 10}% of price${
      inputs.state === "OH" ? ". This is the school district Class I rate, not the city or library" : ""
    }`,
    missing: false,
  };
}

function perThousand(row, inputs, price) {
  const rate = Number(inputs.rate_per_1000);
  const equalization = Number(inputs.equalization_ratio ?? 1);
  if (!Number.isFinite(rate) || price <= 0) return blank(row, "Rate not posted");
  const dollars = price * equalization * rate / 1000;
  const ratioPct = Math.round(equalization * 1000) / 10;
  return {
    name: row.name,
    kind: row.kind,
    taxYear: row.tax_year,
    dollars,
    percentOfOffer: (dollars / price) * 100,
    detail:
      equalization > 0 && equalization < 1
        ? `$${rate.toFixed(2)} per $1,000 of assessed value, times the ${ratioPct}% equalization ratio`
        : `$${rate.toFixed(2)} per $1,000 of assessed value`,
    missing: false,
  };
}

function texasLine(row, inputs, price, homestead) {
  const rate = inputs.rate_per_100;
  if (rate == null || !Number.isFinite(price) || price <= 0) {
    return {
      name: row.name,
      kind: row.kind,
      taxYear: row.tax_year,
      dollars: null,
      percentOfOffer: null,
      detail: "Rate not posted",
      missing: true,
    };
  }
  let taxable = price;
  let detail = `$${Number(rate).toFixed(4)} per $100`;
  if (homestead) {
    const amount = Number(inputs.exemption_amount) || 0;
    const percent = Number(inputs.exemption_percent) || 0;
    if (amount > 0) {
      taxable = Math.max(0, price - amount);
      detail += `, minus $${amount.toLocaleString("en-US")} homestead`;
    } else if (percent > 0) {
      taxable = price * (1 - percent);
      detail += `, ${Math.round(percent * 100)}% homestead`;
    }
  }
  const dollars = (taxable / 100) * Number(rate);
  return {
    name: row.name,
    kind: row.kind,
    taxYear: row.tax_year,
    dollars,
    percentOfOffer: (dollars / price) * 100,
    detail,
    missing: false,
  };
}

export function summarize(rows, price, homestead) {
  const active = selectRows(rows);
  const lines = active.flatMap((row) => linesFor(row, price, homestead));
  const counted = lines.filter((line) => line.dollars != null);
  const totalDollars = counted.reduce((sum, line) => sum + line.dollars, 0);
  const fullDollars = active
    .flatMap((row) => linesFor({ ...row, inputs: withoutExemptions(row.inputs) }, price, false))
    .reduce((sum, line) => sum + (line.dollars ?? 0), 0);
  return {
    lines,
    totalDollars,
    scenarioPercent: price > 0 ? (totalDollars / price) * 100 : null,
    basePercent: price > 0 ? (fullDollars / price) * 100 : null,
    missing: lines.some((line) => line.missing),
  };
}

function withoutExemptions(inputs) {
  return { ...inputs, exemption_amount: 0, exemption_percent: 0 };
}
