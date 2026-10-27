import type { FilePresentation } from "./api";

export type StructuredPreviewKind = "table" | "document" | "spreadsheet" | "slides" | "archive" | "notebook";
const extension = (path: string) => path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
export function structuredPreviewKind(path: string): StructuredPreviewKind | null {
  const ext = extension(path);
  if (["csv", "tsv"].includes(ext)) return "table";
  if (["docx", "odt"].includes(ext)) return "document";
  if (["xlsx", "xlsm", "ods"].includes(ext)) return "spreadsheet";
  if (["pptx", "odp"].includes(ext)) return "slides";
  if (["zip", "tar", "gz", "tgz"].includes(ext)) return "archive";
  if (ext === "ipynb") return "notebook";
  return null;
}

/** Compatibility with file servers that don't advertise a presentation header. */
export function inferFilePresentation(path: string, contentType = ""): FilePresentation {
  const ext = extension(path);
  if (["apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "jfif", "jxl", "pbm", "pgm", "png", "pnm", "ppm", "svg", "tif", "tiff", "webp"].includes(ext)) return "image";
  if (["aac", "aif", "aiff", "flac", "m4a", "mid", "midi", "mp3", "oga", "ogg", "opus", "wav", "weba"].includes(ext)) return "audio";
  if (["3gp", "avi", "m4v", "mp4", "mkv", "mov", "mpeg", "mpg", "ogv", "webm"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (["md", "markdown", "mdx", "txt", "log", "rst", "bib", "csv", "tsv", "json", "jsonl", "ndjson", "ipynb", "html", "htm", "xml", "xhtml", "tex", "qmd", "rmd", "rtf", "cfg", "conf", "ini", "env", "yaml", "yml", "toml", "css", "js", "jsx", "mjs", "cjs", "ts", "tsx", "vue", "svelte", "py", "pyi", "rs", "go", "c", "cc", "cpp", "h", "hpp", "cs", "java", "kt", "kts", "rb", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "r", "jl", "lua", "swift", "dart", "proto", "graphql", "gql", "lock", "properties", "dockerignore", "gitignore", "gitattributes", "editorconfig"].includes(ext)) return "text";
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (["dockerfile", "makefile", "readme", "license", "gemfile", "justfile"].includes(name) || name.startsWith(".env")) return "text";
  if (/^(text\/|application\/(json|xml|[^;]+\+json|[^;]+\+xml)(;|$))/i.test(contentType)) return "text";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.split(";")[0] === "application/pdf") return "pdf";
  return "unknown";
}
