// box-local-keyless.test.mjs — the box asking itself is not charged the keyless
// bucket; every other caller still is (Darko 2026-10-13).
//
// The site refresh read the office through https://postmark.town/api, so its
// ~625 keyless GETs a pass came in through nginx with the box's own address in
// X-Forwarded-For and spent one bucket: 17,531 of a day's 54,823 answered 429.
// It now reads http://127.0.0.1:4380. The exemption is bouncer.mjs boxLocal:
// a loopback SOCKET and no X-Forwarded-For. Three callers over real sockets:
//   - loopback, no XFF (the refresh): never 429, far past the burst;
//   - loopback WITH XFF (nginx carrying a public caller): limited;
//   - a non-loopback socket (this machine's own LAN address): limited.
// The office is given burst 3 and a frozen bouncer clock, so the fourth
// charged GET is a 429 by arithmetic, not by timing.
//   node --test test/box-local-keyless.test.mjs

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, networkInterfaces } from "node:os";
import { fixtureDb } from "./fixture.mjs";
import { indexStore } from "./helpers/office-under-test.mjs";
import { bootOnFreePort } from "./spawn-office.mjs";

const STORES = [];
const storeFor = async (dbPath) => { const x = await indexStore(dbPath); STORES.push(x); return x.env; };
test.after(async () => { for (const x of STORES) await x.stop(); });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BURST = 3;
let PORT, child, tmp;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "postmark-office-box-local-"));
  const dbPath = join(tmp, "fixture.db");
  fixtureDb(dbPath).close();
  const IX_ENV = await storeFor(dbPath);
  ({ child, port: PORT } = await bootOnFreePort((port) => spawn(process.execPath, [
    join(ROOT, "src", "server.mjs"), "--port", String(port), "--db", dbPath,
    "--bouncer-now-ms", String(Date.parse("2026-10-13T14:00:00Z")),
  ], {
    env: {
      ...process.env, WORLD_GRAPH_NONE: "1", ...IX_ENV,
      OFFICE_BOUNCER_KEYLESS_PER_MINUTE: String(BURST),
      OFFICE_BOUNCER_KEYLESS_BURST: String(BURST),
      TOWN_CLONE: join(tmp, "no-clone-here"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })));
});

after(async () => {
  if (child && child.exitCode === null) {
    const gone = new Promise((ok) => child.on("exit", ok));
    child.kill();
    await gone;
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const statuses = async (host, n, headers = {}) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await fetch(`http://${host}:${PORT}/town`, { headers })).status);
  return out;
};

test("loopback with no X-Forwarded-For is the box: never charged, far past the burst", async () => {
  const got = await statuses("127.0.0.1", BURST * 4);
  assert.deepEqual(got, Array(BURST * 4).fill(200), "the refresh's reads must never meet the keyless bucket");
});

test("loopback WITH X-Forwarded-For is nginx carrying a caller: limited at the burst", async () => {
  const got = await statuses("127.0.0.1", BURST + 1, { "x-forwarded-for": "203.0.113.7" });
  assert.deepEqual(got, [...Array(BURST).fill(200), 429]);
});

// The machine's own non-internal IPv4: a real socket whose remote address is
// not loopback. A host with none cannot ask this question, and says so rather
// than reading as a pass.
const lan = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

test("a non-loopback socket is a caller: limited at the burst", { skip: lan ? false : "this host has no non-loopback IPv4 to connect from" }, async () => {
  const got = await statuses(lan, BURST + 1);
  assert.deepEqual(got, [...Array(BURST).fill(200), 429], `connected via ${lan}`);
});
