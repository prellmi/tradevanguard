// Build web/data/universe.json from CCP's Static Data Export (SDE).
//
// The SDE is a ~100 MB zip of JSONL tables (~600 MB unpacked). Only a handful of
// tables are streamed straight out of the zip and reduced to a ~2 MB file with
// regions, systems, stargates, NPC stations and item volumes.
//
// Usage: node tools/build-universe.mjs [output] [--zip local-sde.zip] [--force]

import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync,
         readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

const SDE_BASE = "https://developers.eveonline.com/static-data/tranquility";
// Wormhole, Abyssal and other special regions start here; they have no stargates.
const FIRST_SPECIAL_REGION_ID = 11_000_000;
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
               "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];

// ---------- minimal zip reader (deflate entries, streamed) ----------

/** Map of file name -> {offset, compressedSize, method} from the zip's central directory. */
function readZipDirectory(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const tailSize = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailSize);
    readSync(fd, tail, 0, tailSize, size - tailSize);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error(`${path} is not a zip file`);
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    const dir = Buffer.alloc(dirSize);
    readSync(fd, dir, 0, dirSize, dirOffset);

    const entries = new Map();
    for (let p = 0, i = 0; i < count; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt zip central directory");
      const method = dir.readUInt16LE(p + 10);
      const compressedSize = dir.readUInt32LE(p + 20);
      const nameLength = dir.readUInt16LE(p + 28);
      const extraLength = dir.readUInt16LE(p + 30);
      const commentLength = dir.readUInt16LE(p + 32);
      const localOffset = dir.readUInt32LE(p + 42);
      const name = dir.toString("utf-8", p + 46, p + 46 + nameLength);
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("Zip64 is not supported");
      entries.set(name.split("/").pop(), { localOffset, compressedSize, method });
      p += 46 + nameLength + extraLength + commentLength;
    }

    // Data starts after each entry's local header, whose extra field may differ from the directory's.
    for (const entry of entries.values()) {
      const header = Buffer.alloc(30);
      readSync(fd, header, 0, 30, entry.localOffset);
      entry.dataOffset = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** Yield parsed rows of `<table>.jsonl`; with `mustContain`, other lines are skipped unparsed. */
async function* rows(zipPath, entries, table, mustContain = null) {
  const entry = entries.get(`${table}.jsonl`);
  if (!entry) throw new Error(`SDE table ${table} not found`);
  let stream = createReadStream(zipPath, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1 });
  if (entry.method === 8) stream = stream.pipe(createInflateRaw());
  else if (entry.method !== 0) throw new Error(`Unsupported zip compression method ${entry.method}`);
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (line.trim() && (mustContain === null || line.includes(mustContain))) yield JSON.parse(line);
  }
}

// ---------- reduction ----------

const en = (names) => names?.en ?? "";

/** Rebuild the in-game NPC station name, e.g. 'Jita IV - Moon 4 - Caldari Navy Assembly Plant'. */
function stationName(station, systems, corps, operations, celestialNames) {
  let name = systems[station.solarSystemID][0];
  const planet = station.celestialIndex;
  if (celestialNames.has(station.orbitID)) {
    name = celestialNames.get(station.orbitID);
  } else if (planet) {
    name += ` ${planet < ROMAN.length ? ROMAN[planet] : planet}`;
    if (station.orbitIndex) name += ` - Moon ${station.orbitIndex}`;
  }
  name += ` - ${corps.get(station.ownerID) ?? "?"}`;
  if (station.useOperationName && operations.has(station.operationID)) name += ` ${operations.get(station.operationID)}`;
  return name;
}

async function buildUniverse(zipPath, build) {
  const entries = readZipDirectory(zipPath);
  const table = (name, mustContain) => rows(zipPath, entries, name, mustContain);

  const regions = {};
  for await (const r of table("mapRegions")) if (r._key < FIRST_SPECIAL_REGION_ID) regions[r._key] = en(r.name);

  const systems = {};
  for await (const s of table("mapSolarSystems")) {
    if (s.regionID in regions) systems[s._key] = [en(s.name), s.securityStatus, s.regionID];
  }

  const gateSet = new Set();
  for await (const g of table("mapStargates")) {
    const a = g.solarSystemID, b = g.destination.solarSystemID;
    if (a in systems && b in systems) gateSet.add(a < b ? `${a},${b}` : `${b},${a}`);
  }
  const gates = [...gateSet].map((pair) => pair.split(",").map(Number)).sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  const corps = new Map();
  for await (const c of table("npcCorporations")) corps.set(c._key, en(c.name));
  const operations = new Map();
  for await (const o of table("stationOperations")) operations.set(o._key, en(o.operationName));

  // Celestials with a lore name, e.g. 'Amarr VIII (Oris)'; only those lines are parsed.
  const celestialNames = new Map();
  for (const name of ["mapPlanets", "mapMoons"]) {
    for await (const c of table(name, '"uniqueName"')) celestialNames.set(c._key, en(c.uniqueName));
  }

  const stations = {};
  for await (const s of table("npcStations")) {
    if (s.solarSystemID in systems) {
      stations[s._key] = [stationName(s, systems, corps, operations, celestialNames), s.solarSystemID];
    }
  }

  // Items on the market are always packaged, so prefer the packaged volume.
  const types = {};
  for await (const t of table("types")) {
    if (t.published && t.marketGroupID) types[t._key] = [en(t.name), t.packagedVolume ?? t.volume ?? 0];
  }

  return { build, regions, systems, gates, stations, types };
}

// ---------- download & CLI ----------

async function latestBuild() {
  const resp = await fetch(`${SDE_BASE}/latest.jsonl`);
  if (!resp.ok) throw new Error(`SDE index: HTTP ${resp.status}`);
  return JSON.parse((await resp.text()).split("\n")[0]).buildNumber;
}

async function download(url, dest) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`SDE download: HTTP ${resp.status}`);
  const total = Number(resp.headers.get("Content-Length") ?? 0);
  let done = 0, lastShown = -1;
  const progress = new TransformStream({
    transform(chunk, controller) {
      done += chunk.length;
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (pct !== lastShown && pct % 10 === 0) {
        console.log(`Downloading SDE: ${pct}%`);
        lastShown = pct;
      }
      controller.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(resp.body.pipeThrough(progress)), createWriteStream(`${dest}.part`));
  renameSync(`${dest}.part`, dest);
}

function parseArgs(argv) {
  const args = { output: "web/data/universe.json", zip: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--zip") args.zip = argv[++i];
    else if (argv[i] === "--force") args.force = true;
    else args.output = argv[i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(args.output), { recursive: true });

  let zipPath = args.zip;
  let build;
  if (zipPath) {
    build = Number(zipPath.match(/(\d{6,})/)?.[1] ?? 0);
  } else {
    build = await latestBuild();
    const current = existsSync(args.output) ? JSON.parse(readFileSync(args.output, "utf-8")).build : null;
    if (current === build && !args.force) {
      console.log(`${args.output} is up to date (SDE build ${build})`);
      return;
    }
    zipPath = `${dirname(args.output)}/sde-${build}.zip`;
    await download(`${SDE_BASE}/eve-online-static-data-${build}-jsonl.zip`, zipPath);
  }

  console.log("Reducing SDE …");
  const universe = await buildUniverse(zipPath, build);
  const json = JSON.stringify(universe);
  writeFileSync(args.output, json);
  if (!args.zip) unlinkSync(zipPath);
  console.log(`Wrote ${args.output} (${(json.length / 1e6).toFixed(1)} MB, SDE build ${build}): ` +
              `${Object.keys(universe.systems).length} systems, ${Object.keys(universe.stations).length} stations, ` +
              `${Object.keys(universe.types).length} item types`);
}

// Set the exit code instead of calling process.exit(), which can crash on Windows
// while fetch still has sockets open.
main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
