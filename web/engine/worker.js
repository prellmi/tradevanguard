// Web Worker hosting the market engine, so downloads and number crunching never block the page.
// Messages in:  {id, type: "scan" | "station" | "systems" | "status", params}
// Messages out: {id, progress} while working, then {id, result} or {id, error}

import { ESIClient, indexedDbStore } from "./esi.js";
import { Market } from "./market.js";
import { Universe } from "./universe.js";

const USER_AGENT = "tradevanguard-web (+https://github.com/prellmi/tradevanguard)";

const ready = (async () => {
  const resp = await fetch(new URL("../data/universe.json", import.meta.url));
  if (!resp.ok) throw new Error(`Could not load universe data (${resp.status}). Run 'npm run build:data'.`);
  const universe = new Universe(await resp.json());
  return new Market(universe, new ESIClient({ userAgent: USER_AGENT, store: indexedDbStore() }));
})();

const handlers = {
  scan: (market, params, progress) => market.scan(params, progress),
  station: (market, params, progress) => market.stationScan(params, progress),
  systems: (market, params) => market.systems(params.q ?? "", Number(params.limit ?? 10)),
  status: (market) => market.status(),
};

self.onmessage = async ({ data: { id, type, params } }) => {
  try {
    const market = await ready;
    const progress = (text) => self.postMessage({ id, progress: text });
    const result = await handlers[type](market, params ?? {}, progress);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message ?? String(err) });
  }
};
