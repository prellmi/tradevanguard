// Compare the browser engine with the Python results on identical cached ESI data (no network).
// Usage: node web/tests/parity/compare.mjs PYTHON_RESULTS.json
// Reads the Python app's caches in data/cache, so run a few Python scans first.

import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { Market } from "../../engine/market.js";
import { Universe } from "../../engine/universe.js";

const root = new URL("../../../", import.meta.url);
const ORDER_FIELDS = ["order_id", "type_id", "location_id", "system_id", "price", "volume_remain",
                      "min_volume", "is_buy_order", "range"];

function readCache(name) {
  const path = new URL(`data/cache/${name}`, root);
  if (!existsSync(path)) return null;
  return JSON.parse(gunzipSync(readFileSync(path)).toString("utf-8")).data;
}

const cachedEsi = {
  async regionOrders(regionId) {
    const rows = readCache(`orders-${regionId}.json.gz`) ?? [];
    return { orders: rows.map((r) => Object.fromEntries(ORDER_FIELDS.map((f, i) => [f, r[i]]))),
             expires: Date.now() + 86_400_000 };
  },
  async regionHistory(regionId, typeIds) {
    const cached = new Map((readCache(`history-${regionId}.json.gz`) ?? []).map(([t, , rows]) => [t, rows]));
    return new Map([...typeIds].map((t) => [t, cached.get(t) ?? []]));
  },
  async averagePrices() {
    return new Map(readCache("prices.json.gz") ?? []);
  },
};

// Python rounds half-to-even and JavaScript half-up, so allow differences in the last rounded digit.
function close(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= Math.max(0.011, Math.abs(a) * 1e-9);
  }
  return a === b;
}

function diff(expected, actual, path, out) {
  if (out.length >= 10) return;
  if (expected === null || typeof expected !== "object") {
    if (!close(expected, actual)) out.push(`${path}: python ${JSON.stringify(expected)} vs js ${JSON.stringify(actual)}`);
    return;
  }
  if (Array.isArray(expected) && (!Array.isArray(actual) || expected.length !== actual.length)) {
    out.push(`${path}: python length ${expected.length} vs js ${actual?.length}`);
  }
  for (const key of Object.keys(expected)) {
    if (key === "elapsed") continue;
    diff(expected[key], actual?.[key], `${path}.${key}`, out);
  }
}

const universe = new Universe(JSON.parse(readFileSync(new URL("web/data/universe.json", root), "utf-8")));
const scenarios = JSON.parse(readFileSync(new URL("scenarios.json", import.meta.url), "utf-8"));
const python = JSON.parse(readFileSync(process.argv[2], "utf-8"));
let failures = 0;

for (const { name, type, params } of scenarios) {
  const market = new Market(universe, cachedEsi);
  const js = type === "scan" ? await market.scan(params) : await market.stationScan(params);
  const problems = [];
  diff(python[name], js, name, problems);
  const count = (js.opportunities ?? js.trades).length;
  if (problems.length) {
    failures++;
    console.log(`FAIL ${name} (${count} results)\n  ${problems.join("\n  ")}`);
  } else {
    console.log(`ok   ${name}: ${count} results identical (${js.order_count.toLocaleString()} orders)`);
  }
}
process.exit(failures ? 1 : 0);
