// Browser client for the public market endpoints of the EVE Swagger Interface (ESI).
// Requests carry no custom headers, so they are CORS "simple requests" without preflight;
// browsers can't set User-Agent, so the app identifies itself with the `user_agent` query
// parameter instead.

const ESI_BASE = "https://esi.evetech.net";
const ERROR_LIMIT_FLOOR = 20;
const HISTORY_KEEP_DAYS = 90;

export class ESIError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function expiresOf(resp) {
  const header = resp.headers.get("Expires");
  const time = header ? Date.parse(header) : NaN;
  return Number.isFinite(time) ? time : Date.now() + 300_000;
}

/** Runs at most `limit` async tasks at once. */
function limiter(limit) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export class ESIClient {
  /**
   * @param {object} options
   * @param {string} options.userAgent  identifies the app to CCP
   * @param {{get(key): Promise<any>, set(key, value): Promise<void>}} options.store  persistent cache
   * @param {Function} [options.fetch]  injectable for tests
   */
  constructor({ userAgent, store, concurrency = 16, fetch = globalThis.fetch.bind(globalThis) }) {
    this.userAgent = userAgent;
    this.store = store;
    this.fetch = fetch;
    this.limit = limiter(concurrency);
    this.pauseUntil = 0;
    this.history = new Map();  // regionId -> Map typeId -> [expires, rows]
  }

  async get(path, params = {}) {
    const url = new URL(path, ESI_BASE);
    for (const [key, value] of Object.entries({ ...params, user_agent: this.userAgent })) {
      url.searchParams.set(key, value);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const delay = this.pauseUntil - Date.now();
      if (delay > 0) await sleep(delay);
      let resp;
      try {
        resp = await this.limit(() => this.fetch(url));
      } catch {
        await sleep(1000 * 2 ** attempt);  // network error
        continue;
      }
      this.trackErrorLimit(resp);
      if (resp.ok) return resp;
      if (resp.status === 420 || resp.status === 429) {
        const wait = Number(resp.headers.get("Retry-After") ?? 60) * 1000;
        this.pauseUntil = Math.max(this.pauseUntil, Date.now() + wait);
        continue;
      }
      if (resp.status >= 500) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new ESIError(`ESI ${resp.status} for ${path}: ${(await resp.text()).slice(0, 200)}`, resp.status);
    }
    throw new ESIError(`ESI request ${path} failed after retries`);
  }

  trackErrorLimit(resp) {
    const remain = resp.headers.get("X-Esi-Error-Limit-Remain");
    if (remain !== null && Number(remain) < ERROR_LIMIT_FLOOR) {
      const reset = Number(resp.headers.get("X-Esi-Error-Limit-Reset") ?? 60);
      this.pauseUntil = Math.max(this.pauseUntil, Date.now() + reset * 1000);
    }
  }

  /** All buy and sell orders in a region: {orders, expires}. `onPage(done, total)` reports progress. */
  async regionOrders(regionId, onPage = () => {}) {
    // ESI may refresh the data while we page through it; retry for a consistent snapshot.
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await this.fetchRegion(regionId, onPage);
      if (result.consistent) break;
    }
    return { orders: result.orders, expires: result.expires };
  }

  async fetchRegion(regionId, onPage) {
    const path = `/markets/${regionId}/orders/`;
    const first = await this.get(path, { order_type: "all", page: 1 });
    const pages = Number(first.headers.get("X-Pages") ?? 1);
    let done = 1;
    onPage(done, pages);
    let rest;
    try {
      rest = await Promise.all(Array.from({ length: pages - 1 }, (_, k) =>
        this.get(path, { order_type: "all", page: k + 2 }).then((resp) => {
          onPage(++done, pages);
          return resp;
        })));
    } catch (err) {
      if (err.status === 404) return { orders: [], expires: 0, consistent: false };  // page count shrank
      throw err;
    }
    const responses = [first, ...rest];
    const consistent = new Set(responses.map((r) => r.headers.get("Last-Modified"))).size === 1;
    const orders = [];
    for (const resp of responses) {
      for (const o of await resp.json()) {
        orders.push({
          order_id: o.order_id, type_id: o.type_id, location_id: o.location_id, system_id: o.system_id,
          price: o.price, volume_remain: o.volume_remain, min_volume: o.min_volume,
          is_buy_order: o.is_buy_order, range: o.range,
        });
      }
    }
    return { orders, expires: Math.min(...responses.map(expiresOf)), consistent };
  }

  /** CCP's universe-wide average price per type (one request): Map typeId -> price. */
  async averagePrices() {
    const cached = await this.store.get("prices");
    if (cached && cached.expires > Date.now()) return new Map(cached.data);
    const resp = await this.get("/markets/prices/");
    const data = (await resp.json()).filter((p) => p.average_price).map((p) => [p.type_id, p.average_price]);
    await this.store.set("prices", { expires: expiresOf(resp), data });
    return new Map(data);
  }

  /**
   * Daily [date, averagePrice, volume] rows per type for the last HISTORY_KEEP_DAYS days.
   * ESI serves history one type per request and refreshes it once a day at downtime, so each
   * region's histories are kept in memory and in one store entry.
   */
  async regionHistory(regionId, typeIds, onProgress = () => {}) {
    const cache = await this.regionHistoryCache(regionId);
    const now = Date.now();
    const wanted = [...new Set(typeIds)];
    const missing = wanted.filter((t) => !cache.has(t) || cache.get(t)[0] <= now);
    if (missing.length) {
      let done = 0;
      const fetched = await Promise.all(missing.map((t) => this.fetchHistory(regionId, t).then((entry) => {
        onProgress(++done, missing.length);
        return entry;
      })));
      missing.forEach((t, k) => cache.set(t, fetched[k]));
      for (const [t, [expires]] of cache) if (expires <= now) cache.delete(t);  // prune expired
      await this.store.set(`history-${regionId}`, [...cache.entries()]);
    }
    return new Map(wanted.map((t) => [t, cache.get(t)[1]]));
  }

  async regionHistoryCache(regionId) {
    if (!this.history.has(regionId)) {
      const stored = await this.store.get(`history-${regionId}`);
      this.history.set(regionId, new Map(stored ?? []));
    }
    return this.history.get(regionId);
  }

  async fetchHistory(regionId, typeId) {
    let raw, expires;
    try {
      const resp = await this.get(`/markets/${regionId}/history/`, { type_id: typeId });
      expires = expiresOf(resp);
      raw = await resp.json();
    } catch (err) {
      if (err.status !== 404) throw err;  // 404 = not a market type; cache the empty answer
      raw = [];
      expires = Date.now() + 86_400_000;
    }
    const cutoff = new Date(Date.now() - HISTORY_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    return [expires, raw.filter((d) => d.date >= cutoff).map((d) => [d.date, d.average, d.volume])];
  }
}

/**
 * Persistent key-value store on IndexedDB. Falls back to memory when IndexedDB is unavailable
 * or fails (e.g. private browsing), so scans still work, just without the cache across visits.
 */
export function indexedDbStore(name = "tradevanguard") {
  const fallback = memoryStore();
  const open = new Promise((resolve) => {
    try {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("cache");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  const run = (mode, action, fallbackAction) => open.then((db) => {
    if (!db) return fallbackAction();
    return new Promise((resolve) => {
      const request = action(db.transaction("cache", mode).objectStore("cache"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(fallbackAction());
    });
  });
  return {
    get: (key) => run("readonly", (store) => store.get(key), () => fallback.get(key)),
    set: (key, value) => run("readwrite", (store) => store.put(value, key), () => fallback.set(key, value)),
  };
}

/** In-memory store for tests or when IndexedDB is unavailable. */
export function memoryStore() {
  const data = new Map();
  return {
    get: async (key) => data.get(key),
    set: async (key, value) => { data.set(key, value); },
  };
}
