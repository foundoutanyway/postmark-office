// logos-lifetimes-citations.test.mjs — WLD-39: the office's LIVE citations of the
// lifetime doctrine name its new home, LOGOS/lifetimes.md (World: "standing /
// living / fleeting are lifetimes, not kinds"; scope ruled by Wright
// 2026-10-13T08:57:47.829Z). The applied migration that wrote the old path into
// three marks' `source` stays byte for byte as it ran: migrations never change
// after they run, and the old path resolves through the World's seasonal pointer.
//
// Comments and citations only; no code path reads these strings.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const OLD = /(?<![\w/.-])(?:LOGOS\/)?kinds\.md/g;

const CITING = ["src/dynamic-emissions.mjs", "src/dynamic-entities.mjs", "src/dynamic-store.mjs", "src/reach.mjs", "src/world-hold.mjs"];

test("the office's live citations of the lifetime doctrine name LOGOS/lifetimes.md, never the old path", () => {
  for (const rel of CITING) {
    const text = read(rel);
    assert.deepEqual(text.match(OLD) ?? [], [], `${rel} still cites the old path`);
    assert.match(text, /lifetimes\.md/, `${rel} cites the new one`);
  }
});

test("the applied migration 017 is byte-identical — its old `source` paths are history, not live links", () => {
  const bytes = readFileSync(join(ROOT, "world2", "schema", "017_source_underscore.sql"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "fc40156ed7a6ac8977340c41360cc31eb24cb5b005700069432e102760408a0f",
    "an applied migration never changes after it runs (anti-rebake)");
  assert.equal((bytes.toString("utf8").match(/'LOGOS\/kinds\.md'/g) ?? []).length, 3, "its three historical assignments stand as written");
});
