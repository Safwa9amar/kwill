import type { FilePayload } from "@/types/chat";

// Web twin of the export download. Must export exactly `DownloadableExport` and
// `downloadExport`, matching lib/download-export.ts.
//
// The native version is deliberately NOT a browser hand-off: the export URL is a
// signed Supabase link whose query string carries a JWT, and opening it
// externally would put that token in browser history and the address bar. That
// reasoning applies with more force on the web, so this fetches the bytes
// in-page and hands the student a Blob. The signed URL is never navigated to.

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  latex: "application/x-tex",
  tex: "application/x-tex",
  zip: "application/zip",
};

/** A filename the browser's download attribute will accept. Mirrors the native
 *  version: thesis titles are frequently Arabic and carry invisible bidi control
 *  characters that are legal in a title and a menace in a filename. Codepoints
 *  match lib/download-export.ts exactly: LRM/RLM (U+200E/F), LRE-RLO
 *  (U+202A-202E), LRI-PDI (U+2066-2069). */
function safeFilename(name: string, format: string): string {
  const cleaned = name
    .replace(/[‎‏‪-‮⁦-⁩]/g, "") // bidi controls
    .replace(/[/\\:*?"<>|]/g, "-") // path + reserved characters
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || "thesis";
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${format || "docx"}`;
}

export type DownloadableExport = Pick<FilePayload, "url" | "filename" | "format" | "title">;

export async function downloadExport(file: DownloadableExport): Promise<void> {
  const res = await fetch(file.url);
  if (!res.ok) {
    // Most likely an expired link — these are signed for one hour, so a card
    // from an older conversation will refuse. Throw so the caller can say so.
    throw new Error(`export-fetch-failed-${res.status}`);
  }

  const format = (file.format || "docx").toLowerCase();
  const bytes = await res.arrayBuffer();
  const blob = new Blob([bytes], { type: MIME[format] ?? "application/octet-stream" });

  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = href;
    a.download = safeFilename(file.title?.trim() || file.filename, format);
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick — revoking synchronously can cancel the download
    // in some browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  }
}
