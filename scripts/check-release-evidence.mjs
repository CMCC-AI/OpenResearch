import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const required = ["rust-fmt", "rust-clippy", "rust-tests", "ui-typecheck", "ui-tests", "ui-build", "platform-integration", "browser-login-upload-reconnect", "upgrade-restore"];
export async function checkReleaseEvidence(evidence, root, expectedRevision, load = readFile) {
  if (evidence?.formatVersion !== 1 || evidence.revision !== expectedRevision || !/^[0-9a-f]{40}$/.test(expectedRevision)) throw Error("Release evidence does not match the candidate revision");
  for (const name of ["workbench", "platform", "literature"]) {
    const item = evidence.components?.[name];
    if (!item || typeof item.artifact !== "string" || typeof item.version !== "string" || !item.version || !/^[0-9a-f]{40}$/.test(item.revision) || !/^[0-9a-f]{64}$/.test(item.artifactSha256)) throw Error(`Missing immutable component identity: ${name}`);
    const artifact = resolve(root, item.artifact);
    const artifactRelative = relative(root, artifact);
    if (isAbsolute(artifactRelative) || artifactRelative === ".." || artifactRelative.startsWith("../") || artifactRelative.startsWith("..\\")) throw Error("Component artifact escapes its bundle");
    const bytes = await load(artifact);
    if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== item.artifactSha256) throw Error(`Component artifact changed: ${name}`);
  }
  if (evidence.components.workbench.revision !== expectedRevision || evidence.components.platform.revision !== expectedRevision) throw Error("Local component revisions do not match the candidate");
  for (const name of required) {
    const entries = evidence.checks?.filter(item => item.name === name) ?? [];
    if (entries.length !== 1) throw Error(`Missing or duplicate release check: ${name}`);
    const item = entries[0];
    if (item.revision !== expectedRevision || item.exitCode !== 0 || item.skipped || !item.command?.trim() || !/^[0-9a-f]{64}$/.test(item.sha256)) throw Error(`Unverified release check: ${name}`);
    if (typeof item.log !== "string") throw Error("Missing evidence log");
    const file = resolve(root, item.log);
    const rel = relative(root, file);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) throw Error("Evidence log escapes its bundle");
    const bytes = await load(file);
    if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw Error(`Evidence log changed: ${name}`);
  }
  return { revision: expectedRevision, checks: required.length, components: Object.keys(evidence.components) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, revision] = process.argv.slice(2);
  if (!file || !revision) throw Error("Usage: node scripts/check-release-evidence.mjs <evidence.json> <candidate-sha>");
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const execute = promisify(execFile);
  const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.trim();
  const dirty = (await execute("git", ["status", "--porcelain"], { cwd: sourceRoot })).stdout.trim();
  if (head !== revision || dirty) throw Error("Release requires a clean checkout of the exact candidate revision");
  const path = resolve(file);
  console.log(JSON.stringify(await checkReleaseEvidence(JSON.parse(await readFile(path, "utf8")), dirname(path), revision)));
}
