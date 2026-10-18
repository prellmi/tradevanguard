// Static universe: systems, stations, item types and the stargate jump graph.
// Loads web/data/universe.json, built by tools/build-universe.mjs.

/** Security status as shown in game: rounded to one decimal, but never 0.0 for positive values. */
export function displaySecurity(sec) {
  if (sec > 0 && sec < 0.05) return 0.1;
  return Math.floor(sec * 10 + 0.5) / 10;
}

export class Universe {
  constructor(raw) {
    this.build = raw.build;
    this.regions = new Map(Object.entries(raw.regions).map(([id, name]) => [Number(id), name]));
    this.systems = new Map(Object.entries(raw.systems).map(([id, [name, security, regionId]]) =>
      [Number(id), { id: Number(id), name, security, regionId, displaySecurity: displaySecurity(security) }]));
    this.stations = new Map(Object.entries(raw.stations).map(([id, [name, systemId]]) =>
      [Number(id), { id: Number(id), name, systemId }]));
    this.types = new Map(Object.entries(raw.types).map(([id, [name, volume]]) =>
      [Number(id), { id: Number(id), name, volume }]));
    this.neighbors = new Map();
    for (const [a, b] of raw.gates) {
      if (!this.neighbors.has(a)) this.neighbors.set(a, []);
      if (!this.neighbors.has(b)) this.neighbors.set(b, []);
      this.neighbors.get(a).push(b);
      this.neighbors.get(b).push(a);
    }
    this.byName = new Map([...this.systems.values()].map((s) => [s.name.toLowerCase(), s]));
    this.distanceCache = new Map();
  }

  systemByName(name) {
    const key = name.trim().toLowerCase();
    const system = this.byName.get(key);
    if (system) return system;
    const matches = [...this.byName.values()].filter((s) => s.name.toLowerCase().startsWith(key))
      .map((s) => s.name).sort();
    const hint = matches.length ? ` Did you mean: ${matches.slice(0, 8).join(", ")}?` : "";
    throw new Error(`Unknown system '${name}'.${hint}`);
  }

  /**
   * Jump counts from `origin` to every reachable system (Map systemId -> jumps).
   * The route only enters systems whose displayed security is at least `minSecurity`;
   * the origin itself is always allowed.
   */
  distancesFrom(origin, minSecurity = -1, maxJumps = null) {
    const key = `${origin}:${minSecurity}:${maxJumps}`;
    const cached = this.distanceCache.get(key);
    if (cached) return cached;

    const dist = new Map([[origin, 0]]);
    const queue = [origin];
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      const d = dist.get(current);
      if (maxJumps !== null && d >= maxJumps) continue;
      for (const next of this.neighbors.get(current) ?? []) {
        if (!dist.has(next) && this.systems.get(next).displaySecurity >= minSecurity) {
          dist.set(next, d + 1);
          queue.push(next);
        }
      }
    }
    this.distanceCache.set(key, dist);
    return dist;
  }

  /** Shortest jump count between two systems, or null if unreachable under the security filter. */
  jumps(a, b, minSecurity = -1) {
    return this.distancesFrom(a, minSecurity).get(b) ?? null;
  }
}
