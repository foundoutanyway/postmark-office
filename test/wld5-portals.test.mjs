// wld5-portals.test.mjs — the office's half of WLD-5: portals and the dungeon.
//
// The passage, the dungeon's rules and what a standpoint sees are the world
// clone's (postmark-world tools/portals.mjs, world-verbs.mjs; tested there).
// What is under test here is the office's own half: the reach at the portal,
// the pen, the landing written as the deposit's zero-length stop, the refusals
// as bounces with their fields, the `into` pick on the door's schema, the exit
// card withheld, and the walk fence. It leans on the REAL clone's verbs, so a
// drift between the two repos reds here, and it skips (saying why) on a clone
// that predates WLD-5.
//
// The world is the ruled instance in miniature (Darko 2026-10-13 20:22): the
// Grounds are the dungeon; the Gilded Doors' outside face leads into the
// vestibule; the inside face is the exit and lands at the Approach.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { enterViaOffice, exitViaOffice, CROSSING_TOOLS } from "../src/world-crossings.mjs";
import { walkFenceRefusal } from "../src/world-movement.mjs";
import { NO_WORLD, worldClone } from "./fixture-paths.mjs";

const CLONE = worldClone();
const HAVE = !!CLONE && existsSync(join(CLONE, "tools", "portals.mjs"));
const SKIP = !HAVE && (CLONE ? `the world clone at ${CLONE} predates WLD-5 (no tools/portals.mjs)` : NO_WORLD);
const verbsOf = async () => import(pathToFileURL(join(CLONE, "tools", "world-verbs.mjs")).href);
const grammarOf = async () => import(pathToFileURL(join(CLONE, "tools", "enter-exit.mjs")).href);

const HEIST = "spire/the-gilded-doo-YOULL-NEVER-CATCH-ME";
function marks({ heist = false } = {}) {
  return [
    { id: "spire/grounds", kind: "sited", by: "spire", class: "dungeon", at: { x: 1000, y: 1000 }, extent: { w: 500, h: 400 }, body: "The grounds." },
    { id: "spire/vestibule", kind: "sited", by: "spire", at: { x: 800, y: 1000 }, extent: { w: 60, h: 60 }, body: "The vestibule." },
    { id: "spire/hall", kind: "sited", by: "spire", at: { x: 1000, y: 1000 }, extent: { w: 200, h: 200 }, body: "The hall." },
    { id: "spire/the-approach", kind: "sited", by: "spire", at: { x: 720, y: 1000 }, extent: { w: 30, h: 30 }, body: "The approach." },
    { id: "spire/doors-outside", kind: "sited", by: "spire", at: { x: 745, y: 1000 }, extent: { w: 4, h: 2 }, body: "The Gilded Doors.",
      entry: { word: "neutral", into: "spire/vestibule", lands_at: heist ? HEIST : "spire/doors-inside" } },
    { id: "spire/doors-inside", kind: "sited", by: "spire", at: { x: 775, y: 1000 }, extent: { w: 4, h: 2 }, body: "From inside.",
      entry: { word: "neutral", into: "spire/the-approach" } },
    { id: "spire/hall-door", kind: "sited", by: "spire", at: { x: 825, y: 1000 }, extent: { w: 2, h: 2 }, body: "To the hall.",
      entry: { word: "neutral", into: ["spire/hall", "spire/the-approach"] } },
    { id: "spire/hall-back", kind: "sited", by: "spire", at: { x: 905, y: 1000 }, extent: { w: 2, h: 2 }, body: "Back.",
      entry: { word: "neutral", into: "spire/vestibule", lands_at: "spire/hall-door" } },
  ];
}
const key = (...h) => ({ handles: new Set(h) });

/** A whole office in a closure: the fixture world, one resident standing where
 *  we put them, an in-memory ledger, a pen that appends, and a `stop` that
 *  records where it was asked to set the body down. */
async function officeWith({ standing, ledger = "", heist = false, at = 300 } = {}) {
  const thresholds = await grammarOf();
  const worldState = { marks: marks({ heist }) };
  let text = ledger;
  const written = [], records = [], stops = [];
  return {
    written, records, stops,
    deps: {
      world: async () => worldState,
      ledger: async () => text,
      standpointOf: async (who) => ({ ...standing, name: who }),
      now: () => at,
      record: async (payload) => {
        records.push(payload);
        written.push(...payload.lines);
        text += payload.lines.join("\n") + "\n";
        const acts = thresholds.parseEnterExitLedger(text).acts;
        return { lines: payload.lines, within: thresholds.occupancyAt(acts, at).get(payload.handle) ?? [], commit: "deadbeef", pushed: false };
      },
      stop: async (who, to, k, opts) => { stops.push({ who, to, from: opts?.from ?? null }); },
    },
  };
}
const row = (act, mark, at = 299) => `- 2026-10-13T20:00:00.000Z · ann · ${act} ${mark} · ferry ${at}.0000${act === "enters" ? " · word neutral" : ""}`;

test("THROUGH THE GILDED DOORS: one passage, written once, and the body set down at the landing by the deposit's write", { skip: SKIP }, async () => {
  const o = await officeWith({ standing: { x: 745, y: 1000 } });
  const a = await enterViaOffice(CLONE, { mark: "spire/doors-outside" }, key("ann"), o.deps);
  assert.deepEqual(a.entered, ["spire/grounds", "spire/vestibule"]);
  assert.deepEqual(a.within, ["spire/grounds", "spire/vestibule"]);
  assert.equal(o.records.length, 1);
  assert.equal(o.records[0].mark, "spire/vestibule", "the journal row's object is where the passage leads");
  assert.equal(o.records[0].via, "spire/doors-outside", "and `via` names the portal, as the Post Office's stops do");
  assert.deepEqual(o.stops, [{ who: "ann", to: { x: 775, y: 1000 }, from: { x: 775, y: 1000 } }], "a zero-length departure AT the landing");
  assert.deepEqual(a.landed, { x: 775, y: 1000, mark: "spire/doors-inside", clamped: false, recorded: true });
  assert.deepEqual(a.portals.map((p) => p.id), ["spire/doors-inside", "spire/hall-door"]);
});

test("a portal is entered from within its extent: from outside it, refused with the walk, nothing written", { skip: SKIP }, async () => {
  const o = await officeWith({ standing: { x: 600, y: 1000 } });
  await assert.rejects(() => enterViaOffice(CLONE, { mark: "spire/doors-outside" }, key("ann"), o.deps),
    (e) => e.code === 409 && /not at that portal/.test(e.defect) && e.walk?.mark === "spire/doors-outside");
  assert.equal(o.written.length, 0);
  assert.equal(o.stops.length, 0);
});

test("THE DOOR BUG: a landing that names no mark is refused by quoting the field, standing at the portal, nothing written", { skip: SKIP }, async () => {
  const o = await officeWith({ standing: { x: 745, y: 1000 }, heist: true });
  await assert.rejects(() => enterViaOffice(CLONE, { mark: "spire/doors-outside" }, key("ann"), o.deps),
    (e) => e.code === 409 && e.defect.includes(`lands_at: "${HEIST}" names no mark`) && e.stranded_at === "spire/doors-outside" && e.broken?.field === "lands_at");
  assert.equal(o.written.length, 0);
  assert.equal(o.stops.length, 0, "nobody is moved");
});

test("a portal that leads more than one way answers with its ways, and `into` picks one (the door's schema admits it)", { skip: SKIP }, async () => {
  const held = [row("enters", "spire/grounds"), row("enters", "spire/vestibule")].join("\n") + "\n";
  const o = await officeWith({ standing: { x: 825, y: 1000 }, ledger: held });
  const asked = await enterViaOffice(CLONE, { mark: "spire/hall-door" }, key("ann"), o.deps);
  assert.deepEqual(asked.choose.map((c) => c.id), ["spire/hall", "spire/the-approach"]);
  assert.equal(o.written.length, 0);
  const went = await enterViaOffice(CLONE, { mark: "spire/hall-door", into: "spire/hall" }, key("ann"), o.deps);
  assert.deepEqual(went.exited, ["spire/vestibule"]);
  assert.deepEqual(went.entered, ["spire/hall"]);
  const enter = CROSSING_TOOLS.find((t) => t.name === "world_enter");
  assert.ok(enter.inputSchema.properties.into, "world_enter takes into");
});

test("A DUNGEON OFFERS NO EXIT: the exit bounces 403 and names the portals where you stand", { skip: SKIP }, async () => {
  const held = [row("enters", "spire/grounds"), row("enters", "spire/vestibule")].join("\n") + "\n";
  const o = await officeWith({ standing: { x: 800, y: 1000 }, ledger: held });
  await assert.rejects(() => exitViaOffice(CLONE, {}, key("ann"), o.deps),
    (e) => e.code === 403 && /a dungeon offers no exit/.test(e.defect) && e.portals.join(",") === "spire/doors-inside,spire/hall-door");
  assert.equal(o.written.length, 0);
});

test("a dungeon is entered by its portals, and a hidden room is no mark at all", { skip: SKIP }, async () => {
  const o = await officeWith({ standing: { x: 1000, y: 1000 } });
  await assert.rejects(() => enterViaOffice(CLONE, { mark: "spire/grounds" }, key("ann"), o.deps),
    (e) => e.code === 403 && e.dungeon === "spire/grounds" && e.portals.join(",") === "spire/doors-outside");
  await assert.rejects(() => enterViaOffice(CLONE, { mark: "spire/hall" }, key("ann"), o.deps),
    (e) => e.code === 422 && e.defect === "no mark 'spire/hall' to enter");
});

test("G4 · inside a dungeon the walk is fenced to the room entered, and the refusal names its portals", { skip: SKIP }, async () => {
  const verbs = await verbsOf();
  const all = marks();
  const inHall = ["spire/grounds", "spire/hall"];
  assert.equal(walkFenceRefusal({ stack: inHall, toward: { x: 950, y: 1050 }, marks: all, verbs }), null, "anywhere inside the hall");
  const r = walkFenceRefusal({ stack: inHall, toward: { x: 800, y: 1000 }, marks: all, verbs });
  assert.match(r.defect, /fenced to the room you entered, spire\/hall/);
  assert.deepEqual(r.fields.portals, ["spire/hall-back"]);
  assert.equal(walkFenceRefusal({ stack: ["spire/the-approach"], toward: { x: 0, y: 0 }, marks: all, verbs }), null, "outside a dungeon there is no fence");
  assert.equal(walkFenceRefusal({ stack: inHall, toward: { x: 0, y: 0 }, marks: all, verbs: {} }), null, "a clone without the fence fences nothing");
});

test("G11 · the resident reads see what the world tools' one function says: the dungeon alone from outside, the room from inside, a household's own always", { skip: SKIP }, async () => {
  const { sightedWorld } = await import("../src/world.mjs");
  const verbs = await verbsOf();
  const w = { marks: marks() };
  const ids = (x) => x.marks.map((m) => m.id);
  const outside = sightedWorld(w, { verbs, handle: "ann", stack: [], key: key("ann") });
  assert.ok(ids(outside).includes("spire/grounds"));
  assert.ok(!ids(outside).includes("spire/hall") && !ids(outside).includes("spire/doors-inside"), "nothing inside, at any depth");
  const inHall = sightedWorld(w, { verbs, handle: "ann", stack: ["spire/grounds", "spire/hall"], key: key("ann") });
  assert.ok(ids(inHall).includes("spire/hall-back"));
  assert.ok(!ids(inHall).includes("spire/vestibule"), "not the hall's neighbours");
  const builder = sightedWorld(w, { verbs, handle: "spire", stack: [], key: key("spire") });
  assert.ok(ids(builder).includes("spire/hall"), "the household that made it reads its own marks");
  const plain = { marks: marks().filter((m) => m.class !== "dungeon") };
  assert.equal(sightedWorld(plain, { verbs, handle: "ann", stack: [] }), plain, "no dungeon: the same world back");
});

test("A DUNGEON WITHHOLDS THE EXIT CARD while your stack holds one, and only then", { skip: SKIP }, async () => {
  const { withoutExitInDungeon } = await import("../src/world-apex.mjs");
  const verbs = await verbsOf();
  const cards = [{ action: "enter" }, { action: "exit" }, { action: "walk" }];
  const inside = withoutExitInDungeon(cards, { stack: ["spire/grounds", "spire/hall"], marks: marks(), verbs });
  assert.deepEqual(inside.map((c) => c.action), ["enter", "walk"]);
  assert.equal(withoutExitInDungeon(cards, { stack: ["spire/the-approach"], marks: marks(), verbs }), cards);
  assert.equal(withoutExitInDungeon(cards, { stack: ["spire/grounds"], marks: marks(), verbs: {} }), cards, "a clone without the class withholds nothing");
});

test("[pin] the four resident reads ask sightFor before they read a mark (the wiring sightedWorld's test cannot see)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/world.mjs", import.meta.url), "utf8");
  for (const fn of ["worldOrient", "worldEyes", "worldInvestigate", "worldFind"]) {
    const start = src.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, `${fn} exists`);
    const head = src.slice(start, start + 900);
    assert.match(head, /const w = await sightFor\(await world\(\),/, `${fn} reads the world through sightFor`);
  }
});
