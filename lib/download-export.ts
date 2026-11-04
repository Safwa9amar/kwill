import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { FilePayload } from "@/types/chat";
import { safeFilename } from "@/lib/export-filename";

// Where exports are staged before being handed to the OS. The cache directory
// on purpose: once the student has saved or opened the file, our copy is
// disposable and the system may reclaim it.
const EXPORT_DIR = "exports";

const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  latex: "application/x-tex",
  tex: "application/x-tex",
  zip: "application/zip",
};

const UTI: Record<string, string> = {
  pdf: "com.adobe.pdf",
  zip: "public.zip-archive",
  docx: "org.openxmlformats.wordprocessingml.document",
};

/**
 * The parts of an export this actually reads.
 *
 * A FilePayload off a chat file card satisfies it, and so does a fresh
 * /api/export response — which carries no `size` and no `pages`, and should not
 * have to invent them to be downloadable.
 */
export type DownloadableExport = Pick<FilePayload, "url" | "filename" | "format" | "title">;

/**
 * Download an exported artifact and hand it to the OS — Save to Files, open in
 * Word, share to anything.
 *
 * Deliberately NOT a browser hand-off. The export URL is a signed Supabase link
 * whose query string carries a JWT; opening it externally puts that token in
 * the browser's history and address bar. Fetching it here keeps it inside the
 * app, and the student gets the file rather than a web page.
 *
 * Throws on failure so the caller can say what happened. A reply that is not
 * 2xx (an expired link is a 403) is a failure: its body is removed and nothing
 * is shared, so the file is never reported as saved when it was not. The most
 * likely cause is an expired link: these are signed for one hour, so a card from
 * an older conversation will refuse.
 */
export async function downloadExport(file: DownloadableExport): Promise<void> {
  const format = (file.format || "docx").toLowerCase();
  const base = FileSystem.cacheDirectory;
  if (!base) throw new Error("no-cache-directory");
  const dir = `${base}${EXPORT_DIR}/`;
  if (!(await FileSystem.getInfoAsync(dir)).exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }

  const name = safeFilename(file.title?.trim() || file.filename, format);
  const target = `${dir}${name}`;
  // A re-download of the same export must overwrite rather than land beside the
  // old copy as "thesis (1).docx".
  await FileSystem.deleteAsync(target, { idempotent: true });

  const res = await FileSystem.downloadAsync(file.url, target);
  if (res.status < 200 || res.status > 299) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new Error(`export-fetch-failed-${res.status}`);
  }

  if (!(await Sharing.isAvailableAsync())) {
    // No share sheet (rare — some Android builds). The file IS downloaded, so
    // say that rather than implying nothing happened.
    throw new Error("sharing-unavailable");
  }

  await Sharing.shareAsync(res.uri, {
    mimeType: MIME[format] ?? "application/octet-stream",
    dialogTitle: name,
    UTI: UTI[format] ?? UTI.docx,
  });
}
