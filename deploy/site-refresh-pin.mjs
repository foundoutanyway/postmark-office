#!/usr/bin/env node
// site-refresh-pin.mjs — publish /data/pin.json honestly (POS-601).
//
//   node deploy/site-refresh-pin.mjs --extract <pin.json> --lock <package-lock.json> --out <pin.json>
//
// THE CLASS. The site's own pin writer (postmark-site tools/lib/world-pin-publish.mjs,
// run by fetch-town.mjs) reads package.json for the FLOOR (what site main ASKS for)
// and package-lock.json for `world_installed`. On the box fetch-town runs in the
// EXTRACT tree, which is site main, so BOTH fields describe the floor: the file
// said "installed = floor" while the BUILD tree, which the resolver may have advanced
// to a newer settlement, compiled and published a different world. /build.json
// already tells the truth (build-stamp.mjs runs in the BUILD tree and reads ITS
// lockfile); pin.json did not. Running the site's whole writer in the build tree is
// not the answer either: it would replace the floor fields with the build's.
//
// WHAT THIS DOES. It takes the extract's pin.json as written and changes exactly
// the installed half:
//
//   kept as the extract wrote them   what, world_pin, world_spec, channel,
//                                    code_ref, built_at, and every other key
//   re-derived from the BUILD tree   world_installed, world_installed_from
//                                    (the build tree's package-lock.json: the same
//                                    file and the same `resolved` sha build.json's
//                                    world_sha comes from)
//   rewritten, honestly              notes: the extract's notes about its own
//                                    installed reading are dropped (they described
//                                    the floor's tree), and this tool says where the
//                                    installed sha came from and whether it differs
//                                    from the floor
//
// IT NEVER FALLS BACK TO THE FLOOR. If the build tree's lockfile cannot say which
// world it installed (unreadable, no postmark-world entry, or a `resolved` that
// names no sha) then `world_installed` is null with a note that says so. An
// installed world that cannot be read is not the floor, and writing the floor there
// is the lie this tool exists to remove.
//
// EXIT: 0 written · 1 the extract's pin.json is missing or not a JSON object (the
// caller stops the publish: a pin that cannot name its floor must not ship) · 2 usage.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : null; };
const extract = arg("--extract"), lock = arg("--lock"), out = arg("--out");
if (!extract || !lock || !out) { console.error("site-refresh-pin: --extract, --lock and --out are all required."); process.exit(2); }

let pin;
try { pin = JSON.parse(readFileSync(extract, "utf8")); }
catch (e) { console.error(`site-refresh-pin: the extract's pin.json could not be read (${String(e?.message ?? e).slice(0, 120)})`); process.exit(1); }
if (pin === null || typeof pin !== "object" || Array.isArray(pin)) {
  console.error("site-refresh-pin: the extract's pin.json is not a JSON object"); process.exit(1);
}

/** The sha the BUILD tree's lockfile says postmark-world was installed from, with the reason when it cannot. */
function installedFrom(lockPath) {
  let doc;
  try { doc = JSON.parse(readFileSync(lockPath, "utf8")); }
  catch { return { sha: null, why: "the build tree's package-lock.json could not be read" }; }
  const entry = doc?.packages?.["node_modules/postmark-world"];
  if (!entry) return { sha: null, why: "the build tree's package-lock.json holds no postmark-world entry" };
  const m = /#([0-9a-f]{7,40})$/i.exec(String(entry.resolved ?? "").trim());
  if (!m) return { sha: null, why: "the build tree's package-lock.json holds postmark-world but its `resolved` names no sha" };
  return { sha: m[1].toLowerCase(), why: null };
}

const got = installedFrom(lock);
const floor = typeof pin.world_pin === "string" ? pin.world_pin : null;

// The extract's notes that spoke about ITS tree's installed reading no longer apply.
const ABOUT_INSTALLED = /package-lock\.json|node_modules|installed|compiled against/i;
const kept = (Array.isArray(pin.notes) ? pin.notes : []).filter((n) => typeof n === "string" && !ABOUT_INSTALLED.test(n));
const notes = [...kept];
if (got.sha) {
  notes.push("world_installed was read from the BUILD tree's package-lock.json after the world-pin resolver ran (deploy/site-refresh.sh): the world this build compiled. world_pin and world_spec are site main's floor, read by the extract tree.");
  if (floor && floor !== got.sha)
    notes.push(`the floor (world_pin) is ${floor.slice(0, 12)} and the build installed ${got.sha.slice(0, 12)} — the build compiled against the installed one`);
} else {
  notes.push(`world_installed is null: ${got.why}. The floor is NOT substituted; /build.json's world_sha is the other place this is recorded.`);
}

const result = {};
for (const [k, v] of Object.entries(pin)) {
  if (k === "notes") continue;
  result[k] = v;
  if (k === "world_installed") result[k] = got.sha;
  if (k === "world_installed_from") result[k] = got.sha ? "package-lock.json" : null;
}
if (!("world_installed" in pin)) result.world_installed = got.sha;
if (!("world_installed_from" in pin)) result.world_installed_from = got.sha ? "package-lock.json" : null;
result.notes = notes;

mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(result, null, 1) + "\n");
renameSync(tmp, out);
console.log(`pin: floor ${floor ? floor.slice(0, 8) : "null"}, installed ${got.sha ? got.sha.slice(0, 8) : "null (" + got.why + ")"}`);
