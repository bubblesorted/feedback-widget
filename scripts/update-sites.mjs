#!/usr/bin/env node
// Moves every site in sites.json onto this package's current release, one PR per site.
//
//   npm run update-sites                 open (and merge, per site) a PR in every site
//   npm run update-sites -- --dry-run    clone and update lockfiles, but push nothing
//   npm run update-sites -- --only "The Ascent"
//
// Each site keeps its own gates: the PR runs that site's CI and review, and merges only through them.
// Run `npm run release` first; this refuses a version that has no GitHub release.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1] : undefined;

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { sites } = JSON.parse(readFileSync(join(root, "sites.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const file = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
const url = `https://github.com/bubblesorted/feedback-widget/releases/download/${tag}/${file}`;
const branch = `chore/feedback-widget-${tag}`;

const run = (cmd, argv, cwd, quiet = true) =>
  execFileSync(cmd, argv, { cwd, encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit" }).trim();

function changelog() {
  const text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const start = text.indexOf(`## ${version}`);
  if (start < 0) return "";
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next < 0 ? undefined : next).replace(`## ${version}`, "").trim();
}

try {
  run("gh", ["release", "view", tag, "--repo", "bubblesorted/feedback-widget", "--json", "tagName"]);
} catch {
  console.error(`${tag} has no GitHub release. Run npm run release first.`);
  process.exit(1);
}

const results = [];
const waiting = [];
for (const site of sites) {
  if (only && site.name !== only) continue;
  const work = mkdtempSync(join(tmpdir(), "fbw-site-"));
  try {
    run("gh", ["repo", "clone", site.repo, work, "--", "--depth", "1", "--quiet"]);
    const dir = join(work, site.dir ?? ".");
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const current = manifest.dependencies?.[pkg.name] ?? manifest.devDependencies?.[pkg.name];
    if (!current) {
      results.push([site.name, "skipped: does not depend on the widget"]);
      continue;
    }
    if (current === url) {
      results.push([site.name, `already on ${tag}`]);
      continue;
    }
    if (site.install === "pnpm") run("pnpm", ["add", url, "--lockfile-only", "--ignore-scripts"], dir);
    else run("npm", ["install", url, "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
    const changed = run("git", ["status", "--porcelain"], work);
    if (!changed) {
      results.push([site.name, "no change after install"]);
      continue;
    }
    if (dryRun) {
      results.push([site.name, `would open a PR: ${current.split("/").pop()} -> ${file}\n${changed}`]);
      continue;
    }
    const paths = run("git", ["diff", "--name-only"], work).split("\n").filter(Boolean);
    run("git", ["switch", "-c", branch], work);
    run("git", ["add", "--", ...paths], work);
    run("git", ["commit", "-m", `chore: feedback widget ${tag}`], work);
    run("git", ["push", "-u", "origin", branch], work);
    const body = [
      `Moves this site to the shared feedback widget ${tag}, opened by \`npm run update-sites\` in bubblesorted/feedback-widget.`,
      "",
      changelog(),
      "",
      `Release: https://github.com/bubblesorted/feedback-widget/releases/tag/${tag}`,
      ...(site.bodyFooter ? ["", site.bodyFooter] : []),
    ].join("\n");
    const pr = run("gh", ["pr", "create", "--repo", site.repo, "--base", "main", "--head", branch, "--title", `Feedback widget ${tag}`, "--body", body], work);
    for (const label of site.labels ?? []) run("gh", ["pr", "edit", pr, "--add-label", label], work);
    const method = `--${site.merge?.method ?? "squash"}`;
    if (site.merge?.strategy === "auto") {
      run("gh", ["pr", "merge", pr, "--auto", method], work);
      results.push([site.name, `${pr} (auto-merge armed)`]);
    } else if (site.merge?.strategy === "after-checks") {
      waiting.push({ site, pr, method });
      results.push([site.name, `${pr} (waiting for ${site.merge.checks.join(", ")})`]);
    } else {
      results.push([site.name, `${pr} (not merged: ${site.merge?.note ?? "merge it through the site's own process"})`]);
    }
  } catch (error) {
    results.push([site.name, `FAILED: ${(error.stderr || error.message || String(error)).toString().trim().split("\n").slice(-3).join(" ")}`]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Sites whose rules say: wait for these checks on the PR head, then merge that exact head.
for (const { site, pr, method } of waiting) {
  const deadline = Date.now() + 60 * 60 * 1000;
  let outcome = "timed out after an hour; merge it by hand";
  while (Date.now() < deadline) {
    const head = run("gh", ["pr", "view", pr, "--json", "headRefOid", "-q", ".headRefOid"]);
    const checks = JSON.parse(run("gh", ["pr", "view", pr, "--json", "statusCheckRollup", "-q", ".statusCheckRollup"]) || "[]");
    const state = site.merge.checks.map((name) => {
      const c = checks.find((x) => (x.name ?? x.context) === name);
      return c ? (c.conclusion ?? c.state ?? "").toUpperCase() || "PENDING" : "MISSING";
    });
    if (state.some((s) => ["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR"].includes(s))) {
      outcome = `a required check failed (${site.merge.checks.map((n, i) => `${n}: ${state[i]}`).join(", ")})`;
      break;
    }
    if (state.every((s) => s === "SUCCESS")) {
      run("gh", ["pr", "merge", pr, method, "--match-head-commit", head]);
      outcome = "merged";
      break;
    }
    execFileSync("sleep", ["30"]);
  }
  const row = results.find(([name]) => name === site.name);
  row[1] = `${pr} (${outcome})`;
}

for (const [name, what] of results) console.log(`${name}: ${what}`);
if (results.some(([, what]) => what.startsWith("FAILED") || what.includes("failed"))) process.exit(1);
