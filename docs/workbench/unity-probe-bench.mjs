import { statSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const ROOT = process.env.HOME + "/Projects/Deepmind";
const N = 200;

function bench(label, fn, n = N) {
  try {
    fn();
  } catch {} // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    try {
      fn();
    } catch {}
  }
  const t1 = process.hrtime.bigint();
  const perOp = Number(t1 - t0) / n / 1e6;
  console.log(`${label.padEnd(46)} ${perOp.toFixed(4)} ms/op   (x${n})`);
  return perOp;
}

console.log("--- A: what EngineTypeResolver does today ---");
const a = bench("stat project.godot (miss) + ProjectVersion (hit)", () => {
  try {
    statSync(ROOT + "/project.godot");
  } catch {}
  statSync(ROOT + "/ProjectSettings/ProjectVersion.txt");
});

console.log("\n--- B: additional on-disk Unity status reads ---");
const b1 = bench("read+parse Packages/manifest.json (2.5KB)", () =>
  JSON.parse(readFileSync(ROOT + "/Packages/manifest.json", "utf8")));
const b2 = bench("read+parse packages-lock.json (17KB)", () =>
  JSON.parse(readFileSync(ROOT + "/Packages/packages-lock.json", "utf8")));
const b3 = bench("read ProjectVersion.txt (parse editor ver)", () =>
  readFileSync(ROOT + "/ProjectSettings/ProjectVersion.txt", "utf8").split("\n")[0]);
const b4 = bench("stat Temp/UnityLockfile (editor running?)", () =>
  existsSync(ROOT + "/Temp/UnityLockfile"));

console.log("\n--- C: editor binary discovery ---");
const c1 = bench("readdir /Applications/Unity/Hub/Editor", () => {
  try {
    return readdirSync("/Applications/Unity/Hub/Editor");
  } catch {
    return [];
  }
});

console.log("\n--- D: process scan (the expensive one) ---");
const d1 = bench("execFileSync pgrep -x Unity", () => {
  try {
    execFileSync("pgrep", ["-x", "Unity"], { stdio: "pipe" });
  } catch {}
}, 20);

console.log("\n=== TOTALS ===");
console.log(`current engineType probe          : ${a.toFixed(4)} ms`);
const diskOnly = b1 + b3 + b4;
console.log(
  `+ on-disk status (manifest+ver+lock): ${(a + diskOnly).toFixed(4)} ms  (delta ${diskOnly.toFixed(4)})`,
);
console.log(
  `+ editor discovery                 : ${(a + diskOnly + c1).toFixed(4)} ms  (delta ${c1.toFixed(4)})`,
);
console.log(
  `+ process scan                     : ${(a + diskOnly + c1 + d1).toFixed(4)} ms  (delta ${d1.toFixed(4)})`,
);
