import { Gunzip, Unzip, UnzipInflate } from "fflate";
import { decodePreviewText } from "./previewText";

export const STRUCTURED_PREVIEW_LIMIT = 16 * 1024 * 1024;
const MAX_EXPANDED = 32 * 1024 * 1024;
const MAX_XML = 4 * 1024 * 1024;
export const MAX_PREVIEW_ROWS = 1000;
export const MAX_PREVIEW_COLUMNS = 100;
export interface PreviewTable { name: string; rows: string[][] }
export interface PreviewSection { title: string; text: string; code?: boolean }
export interface ArchiveItem { name: string; size: number; compressedSize?: number; encrypted?: boolean }
export interface StructuredDocument { tables?: PreviewTable[]; sections?: PreviewSection[]; entries?: ArchiveItem[]; notes: string[] }
const limitedNote = "内容预览有上限：每张表最多 1000 行、100 列；超出部分请下载查看。";

export function parseDelimited(text: string, separator = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const append = () => { if (row.length < MAX_PREVIEW_COLUMNS) row.push(field); field = ""; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field.length === 0) quoted = !quoted;
      else field += char;
    } else if (char === separator && !quoted) append();
    else if ((char === "\n" || char === "\r") && !quoted) {
      append(); rows.push(row); row = [];
      if (char === "\r" && text[i + 1] === "\n") i++;
      if (rows.length >= MAX_PREVIEW_ROWS) return rows;
    } else if (field.length < 20_000) field += char;
  }
  if (field || row.length) { append(); rows.push(row); }
  return rows;
}

/** Read ZIP's directory without expanding any entry. No extraction to disk. */
export function zipDirectory(bytes: Uint8Array): ArchiveItem[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  }
  if (end < Math.max(0, bytes.length - 65557)) throw new Error("ZIP 目录损坏，或文件不是完整的 ZIP 文件。");
  const count = view.getUint16(end + 10, true);
  const offset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count === 0xffff || offset === 0xffffffff) throw new Error("暂不支持分卷 ZIP 或 ZIP64，请下载查看。");
  if (count > 2000 || offset + view.getUint32(end + 12, true) > end) throw new Error("ZIP 目录超出预览限制或已损坏。");
  const entries: ArchiveItem[] = [];
  const names = new Set<string>();
  let cursor = offset;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP 目录损坏。");
    const length = view.getUint16(cursor + 28, true);
    const next = cursor + 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (next > end) throw new Error("ZIP 目录条目越界。");
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + length));
    if (names.has(name)) throw new Error("ZIP 包含重复路径，无法可靠预览。");
    names.add(name);
    entries.push({ name, size: view.getUint32(cursor + 24, true), compressedSize: view.getUint32(cursor + 20, true), encrypted: Boolean(view.getUint16(cursor + 8, true) & 1) });
    cursor = next;
  }
  return entries;
}

export function gunzipBounded(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const decoder = new Gunzip((chunk) => {
    size += chunk.length;
    if (size > MAX_EXPANDED) throw new Error("解压后内容超过 32 MiB，已停止预览。");
    chunks.push(chunk);
  });
  // Bound each inflate operation instead of materializing the full output at once.
  for (let offset = 0; offset < bytes.length; offset += 4096) decoder.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

export function tarDirectory(bytes: Uint8Array): ArchiveItem[] {
  const entries: ArchiveItem[] = [];
  const decoder = new TextDecoder();
  const field = (offset: number, length: number) => decoder.decode(bytes.subarray(offset, offset + length)).replace(/\0.*$/s, "").trim();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    if (bytes.subarray(offset, offset + 512).every((value) => value === 0)) return entries;
    const name = field(offset, 100), prefix = field(offset + 345, 155);
    const sizeText = field(offset + 124, 12);
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("不支持此 TAR 大文件或扩展大小编码。");
    const size = parseInt(sizeText, 8);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > bytes.length) throw new Error("TAR 文件不完整。");
    entries.push({ name: prefix ? `${prefix}/${name}` : name, size });
    if (entries.length > 2000) throw new Error("压缩包目录超过 2000 条，请下载查看。");
    offset = next;
  }
  throw new Error("TAR 文件缺少完整的结束块。");
}

function xml(bytes: Uint8Array): Document {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("文档 XML 包含不支持的实体声明。");
  const document = new DOMParser().parseFromString(source, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error("文档 XML 已损坏。");
  return document;
}
const nodes = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS("*", name));
const text = (root: Document | Element, tag: string) => nodes(root, tag).map((node) => node.textContent ?? "").join("");
function officeParts(bytes: Uint8Array) {
  const entries = zipDirectory(bytes);
  const wanted = entries.filter((entry) => /^(word\/document\.xml|xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet[^/]+\.xml)|ppt\/slides\/slide\d+\.xml|content\.xml)$/.test(entry.name));
  if (wanted.some((entry) => entry.encrypted)) throw new Error("文档已加密，请解密后再预览。");
  if (wanted.some((entry) => entry.size > MAX_XML) || wanted.reduce((sum, entry) => sum + entry.size, 0) > MAX_EXPANDED) throw new Error("文档内容超过预览限制，请下载查看。");
  const selected = new Map(wanted.map((entry) => [entry.name, entry]));
  const parts: Record<string, Uint8Array> = Object.create(null);
  let expanded = 0;
  const archive = new Unzip((file) => {
    const entry = selected.get(file.name);
    if (!entry) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      expanded += chunk.length;
      if (size > MAX_XML || size > entry.size || expanded > MAX_EXPANDED) { file.terminate(); throw new Error("文档展开内容超过限制或与目录不一致。"); }
      chunks.push(chunk);
      if (final) {
        const output = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) { output.set(part, offset); offset += part.length; }
        parts[file.name] = output;
      }
    };
    file.start();
  });
  archive.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 4096) archive.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
  for (const entry of wanted) if (!Object.hasOwn(parts, entry.name) || parts[entry.name].length !== entry.size) throw new Error("文档压缩目录与实际内容不一致。");
  return parts;
}
function columnIndex(reference: string): number {
  let column = 0;
  for (const letter of reference.replace(/\d.*$/, "").toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return column - 1;
}
function parseXlsx(parts: Record<string, Uint8Array>): PreviewTable[] {
  const strings = parts["xl/sharedStrings.xml"] ? nodes(xml(parts["xl/sharedStrings.xml"]), "si").map((node) => text(node, "t")) : [];
  const relationships = parts["xl/_rels/workbook.xml.rels"] ? nodes(xml(parts["xl/_rels/workbook.xml.rels"]), "Relationship") : [];
  const workbook = parts["xl/workbook.xml"] ? nodes(xml(parts["xl/workbook.xml"]), "sheet") : [];
  const paths = Object.keys(parts).filter((path) => /^xl\/worksheets\/sheet[^/]+\.xml$/.test(path)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return paths.slice(0, 30).map((path) => {
    const relationship = relationships.find((node) => { const target = node.getAttribute("Target") ?? ""; return target.replace(/^\/?xl\//, "").replace(/^\.\//, "") === path.slice(3) && node.getAttribute("TargetMode") !== "External"; });
    const sheet = workbook.find((node) => node.getAttribute("r:id") === relationship?.getAttribute("Id"));
    const rows: string[][] = [];
    for (const row of nodes(xml(parts[path]), "row")) {
      const rowIndex = Number(row.getAttribute("r") ?? rows.length + 1) - 1;
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= MAX_PREVIEW_ROWS) continue;
      const result: string[] = [];
      for (const cell of nodes(row, "c")) {
        const index = columnIndex(cell.getAttribute("r") ?? "");
        if (index < 0 || index >= MAX_PREVIEW_COLUMNS) continue;
        const value = text(cell, "v");
        const type = cell.getAttribute("t");
        result[index] = type === "s" ? strings[Number(value)] ?? value : type === "inlineStr" ? text(cell, "t") : type === "b" ? value === "1" ? "TRUE" : "FALSE" : value || (text(cell, "f") ? `=${text(cell, "f")}` : "");
      }
      while (rows.length <= rowIndex) rows.push([]);
      rows[rowIndex] = Array.from({ length: result.length }, (_, index) => result[index] ?? "");
    }
    return { name: sheet?.getAttribute("name") ?? path.split("/").pop()!, rows };
  });
}
function boundTables(tables: PreviewTable[]): PreviewTable[] {
  let remaining = 2_000_000;
  return tables.map((table) => ({ ...table, rows: table.rows.map((row) => row.map((value) => {
    const clipped = value.slice(0, Math.min(20_000, remaining));
    remaining -= clipped.length;
    return clipped;
  })) }));
}

function parseOds(document: Document): PreviewTable[] {
  return nodes(document, "table").slice(0, 30).map((table, index) => {
    const rows: string[][] = [];
    for (const row of nodes(table, "table-row")) {
      const result: string[] = [];
      for (const cell of Array.from(row.children).filter((node) => ["table-cell", "covered-table-cell"].includes(node.localName))) {
        const repeat = Math.min(MAX_PREVIEW_COLUMNS - result.length, Number(cell.getAttribute("table:number-columns-repeated") ?? 1));
        for (let i = 0; i < repeat; i++) result.push(nodes(cell, "p").map((p) => p.textContent ?? "").join("\n") || cell.getAttribute("office:value") || "");
      }
      const repeat = Math.min(MAX_PREVIEW_ROWS - rows.length, Number(row.getAttribute("table:number-rows-repeated") ?? 1));
      for (let i = 0; i < repeat; i++) rows.push([...result]);
      if (rows.length >= MAX_PREVIEW_ROWS) break;
    }
    return { name: table.getAttribute("table:name") ?? `工作表 ${index + 1}`, rows };
  });
}

export function parseStructuredFile(bytes: Uint8Array, name: string): StructuredDocument {
  if (bytes.length > STRUCTURED_PREVIEW_LIMIT) throw new Error("文件超过 16 MiB，暂不内嵌预览。");
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "csv" || ext === "tsv") {
    const decoded = decodePreviewText(bytes);
    if (decoded.binary) throw new Error("无法识别表格文本编码，请保存为 UTF-8 或带 BOM 的 UTF-16。");
    return { tables: boundTables([{ name, rows: parseDelimited(decoded.content, ext === "tsv" ? "\t" : ",") }]), notes: [limitedNote] };
  }
  if (ext === "zip") return { entries: zipDirectory(bytes), notes: ["仅预览压缩包目录，不解压到磁盘，不执行其中的文件。"] };
  if (ext === "tar") return { entries: tarDirectory(bytes), notes: ["仅预览 TAR 目录；GNU/PAX 扩展元数据不解释为文件内容。"] };
  if (ext === "gz" || ext === "tgz") {
    const expanded = gunzipBounded(bytes);
    return { entries: /\.(tar\.gz|tgz)$/i.test(name) ? tarDirectory(expanded) : [{ name: name.replace(/\.gz$/i, ""), size: expanded.length }], notes: ["解压数据仅保留在内存，不写入磁盘。"] };
  }
  if (ext === "ipynb") {
    const decoded = decodePreviewText(bytes);
    if (decoded.binary) throw new Error("Notebook 不是有效文本。");
    const notebook = JSON.parse(decoded.content) as { cells?: { cell_type?: string; source?: string | string[]; outputs?: { text?: string | string[]; data?: Record<string, string | string[]> }[] }[] };
    if (!Array.isArray(notebook.cells)) throw new Error("Notebook 缺少单元格列表。");
    const join = (value: unknown) => (Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "").slice(0, 100_000);
    return { sections: notebook.cells.slice(0, 500).flatMap((cell, index) => [{ title: `单元格 ${index + 1} · ${cell.cell_type ?? "raw"}`, text: join(cell.source), code: cell.cell_type !== "markdown" }, ...(cell.outputs ?? []).slice(0, 10).map((output) => ({ title: "输出", text: join(output.text ?? output.data?.["text/plain"]), code: true })).filter((output) => output.text)]), notes: ["只读预览前 500 个单元格及纯文本输出，不执行代码，不加载 HTML 或脚本输出。"] };
  }
  const parts = officeParts(bytes);
  const notes = ["内容预览，不保留原始版式、字体、分页、图片、图表或动画；不执行宏和外部链接。需要原版式时请下载或导出为 PDF。"];
  if (ext === "xlsx" || ext === "xlsm") {
    const tables = boundTables(parseXlsx(parts));
    if (!tables.length) throw new Error("工作簿缺少工作表。");
    return { tables, notes: [...notes, limitedNote, "显示存储的单元格值或公式，不重新计算公式；日期/数字样式可能显示为原始数值。最多预览 30 张表。"] };
  }
  if (ext === "docx") {
    if (!parts["word/document.xml"]) throw new Error("DOCX 缺少正文。");
    return { sections: [{ title: name, text: nodes(xml(parts["word/document.xml"]), "p").slice(0, 5000).map((p) => text(p, "t")).join("\n\n") }], notes };
  }
  if (ext === "pptx") {
    const slides = Object.keys(parts).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 200);
    if (!slides.length) throw new Error("PPTX 缺少幻灯片内容。");
    return { sections: slides.map((path, index) => ({ title: `幻灯片 ${index + 1}`, text: nodes(xml(parts[path]), "p").map((p) => text(p, "t")).join("\n") })), notes: [...notes, "按幻灯片文件编号展示文本，未解析自定义播放顺序。最多 200 页。"] };
  }
  if (!parts["content.xml"]) throw new Error("OpenDocument 缺少 content.xml。");
  const document = xml(parts["content.xml"]);
  if (ext === "ods") return { tables: boundTables(parseOds(document)), notes: [...notes, limitedNote] };
  if (ext === "odp") return { sections: nodes(document, "page").slice(0, 200).map((page, index) => ({ title: page.getAttribute("draw:name") ?? `幻灯片 ${index + 1}`, text: nodes(page, "p").map((p) => p.textContent ?? "").join("\n") })), notes };
  return { sections: [{ title: name, text: nodes(document, "p").slice(0, 5000).map((p) => p.textContent ?? "").join("\n\n") }], notes };
}
