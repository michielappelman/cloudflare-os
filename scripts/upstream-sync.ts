#!/usr/bin/env node

// `pnpm upstream:sync [--dry-run] [--skip-checks] [--push]` — merge cloudflare/cloudflare-os into
// this fork, as docs/fork-sync.md describes:
//
//   1. Adds the `upstream` remote if it is missing.
//   2. Requires a clean tree on `main`, equal to `origin/main` after a fetch.
//   3. Fetches upstream and prints the pending commits and diffstat (`--dry-run` stops here).
//   4. `git merge --no-edit upstream/main`. Modify/delete conflicts on the upstream workflows this
//      fork deletes (`.github/workflows/*`, `.github/labeler.yml`) keep the deletion; any other
//      conflict stops with the merge left in progress for a human to resolve.
//   5. `pnpm install --frozen-lockfile`, `pnpm lint` and `pnpm test` (skipped by `--skip-checks`).
//   6. With `--push`, `git push origin main`. Never forced: the merge only adds commits.

import { execFileSync, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmCommand } from "./pnpm-command.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const UPSTREAM_URL = "https://github.com/cloudflare/cloudflare-os.git";
const USAGE = "usage: pnpm upstream:sync [--dry-run] [--skip-checks] [--push]";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

// Commands whose output the user should see as it happens.
function run(command: string, args: string[]): void {
  console.log(`\n> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

function fail(message: string): never {
  console.error(`\nupstream-sync: ${message}`);
  process.exit(1);
}

const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!["--dry-run", "--skip-checks", "--push"].includes(flag)) fail(`unknown argument ${flag}\n${USAGE}`);
}
const dryRun = flags.has("--dry-run");
if (dryRun && flags.has("--push")) fail("--dry-run and --push are mutually exclusive");

if (!git(["remote"]).split("\n").includes("upstream")) {
  run("git", ["remote", "add", "upstream", UPSTREAM_URL]);
}

if (git(["status", "--porcelain"]) !== "") {
  fail("the working tree is not clean; commit or stash your changes first");
}
const branch = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" })
  .stdout.trim();
if (branch !== "main") fail(`check out main first (currently on ${branch || "a detached HEAD"})`);

run("git", ["fetch", "origin"]);
if (git(["rev-parse", "main"]) !== git(["rev-parse", "origin/main"])) {
  fail(
    "main differs from origin/main; push your fork commits or `git pull --ff-only origin main` first\n" +
      git(["log", "--oneline", "--left-right", "main...origin/main"]),
  );
}

// Only `main`: upstream has dozens of feature branches the fork never needs.
run("git", ["fetch", "upstream", "main"]);
run("git", ["--no-pager", "log", "--oneline", "--left-right", "main...upstream/main"]);
run("git", ["--no-pager", "diff", "--stat", "main...upstream/main"]);

const pending = Number(git(["rev-list", "--count", "main..upstream/main"]));
if (pending === 0) {
  console.log("\nmain already contains upstream/main; nothing to merge.");
  process.exit(0);
}
console.log(`\n${pending} upstream commit(s) to merge.`);
if (dryRun) process.exit(0);

console.log("\n> git merge --no-edit upstream/main");
if (spawnSync("git", ["merge", "--no-edit", "upstream/main"], { cwd: ROOT, stdio: "inherit" }).status !== 0) {
  // `DU` is "deleted by us": a file this fork deleted that upstream changed since.
  const conflicts = git(["status", "--porcelain=v1", "-z"])
    .split("\0")
    .filter((entry) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(entry))
    .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
  if (conflicts.length === 0) fail("git merge failed without leaving conflicts; see its output above");

  // Kept deletions are resolved even when other conflicts stop the merge, so the human is left
  // with only the conflicts that need a decision.
  const removed: string[] = [];
  const others: typeof conflicts = [];
  for (const conflict of conflicts) {
    const { code, path } = conflict;
    if (code === "DU" && (/^\.github\/workflows\/[^/]+$/.test(path) || path === ".github/labeler.yml")) {
      removed.push(path);
    } else {
      others.push(conflict);
    }
  }
  if (removed.length > 0) run("git", ["rm", "--quiet", "--", ...removed]);
  if (others.length > 0) {
    fail(
      "the merge stopped on conflicts that need a human; it is left in progress.\n" +
        others.map(({ code, path }) => `  ${code} ${path}`).join("\n") +
        "\nResolve them, `git commit --no-edit`, then run `pnpm lint && pnpm test` before pushing " +
        "(or `git merge --abort` to give up).",
    );
  }
  run("git", ["commit", "--no-edit"]);
}

if (flags.has("--skip-checks")) {
  console.log("\nSkipping install, lint and tests (--skip-checks).");
} else {
  // The merge brought in upstream's lockfile, so a frozen install should pass; if it doesn't, the
  // merged manifests and lockfile disagree and that needs a look before anything is pushed.
  for (const args of [["install", "--frozen-lockfile"], ["lint"], ["test"]]) {
    const [command, argv] = pnpmCommand(args);
    console.log(`\n> pnpm ${args.join(" ")}`);
    if (spawnSync(command, argv, { cwd: ROOT, stdio: "inherit" }).status !== 0) {
      fail(`pnpm ${args.join(" ")} failed; the merge is committed locally but not pushed`);
    }
  }
}

if (flags.has("--push")) {
  run("git", ["push", "origin", "main"]);
} else {
  console.log("\nMerged locally. Review it, then `git push origin main` (or rerun with --push).");
}
