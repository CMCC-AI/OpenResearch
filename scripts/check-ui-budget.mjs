import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(resolve(root, "ui/dist/index.html"), "utf8");
const entry = html.match(/<script[^>]*src=["'](?:\.\/|\/)?(assets\/[^"']+\.js)["']/)?.[1];
if (!entry) throw Error("UI entry bundle is missing");
const content = await readFile(resolve(root, "ui/dist", entry));
const compressed = gzipSync(content).length;
// The entry already excludes the lazily loaded workflow studio/canvas and
// research panel. The raw limit keeps a small allowance for the AI drafting
// wiring; download size stays guarded by the 950 KB gzip ceiling.
if (content.length > 3_120_000 || compressed > 950_000) throw Error(`UI entry budget exceeded: ${content.length} raw / ${compressed} gzip bytes`);
console.log(JSON.stringify({ entry, bytes: (await stat(resolve(root, "ui/dist", entry))).size, gzipBytes: compressed }));
