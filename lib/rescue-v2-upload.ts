import type { RescueProjectDTO } from "@/types/rescue-v2";
import { getAuthHeader } from "@/lib/api";

/** A reply body as a JSON object, or null when it is empty, not JSON, or not an object (a proxy's HTML page, a bare string). */
function jsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One raw-bytes request with real progress and a stall watchdog (P-10).
 * `uploadPart` below and `uploadGuide` (lib/rescue-v2-api.ts) both go through here.
 * `expo-file-system` is imported inside the function: no web-reachable module imports it at module scope (`feat/web-version`'s rule).
 */
export async function uploadBytes(
  url: string,
  fileUri: string,
  contentType: string,
  onProgress: (fraction: number) => void,
  extraHeaders: Record<string, string> = {},
): Promise<RescueProjectDTO> {
  const FileSystem = await import("expo-file-system/legacy");
  const headers = await getAuthHeader();
  // iOS's default background session never FAILS when the server or the connection is down: it retries. A timer cancels the task when the
  // bytes stop moving for 45 s, so the bar cannot hang with no message and no way out. Once every byte is sent the server has the file and
  // is reading it, so the wait becomes 180 s for its answer before the same cancel.
  let last = Date.now();
  let sentAt: number | null = null;
  let stalled = false;
  const task = FileSystem.createUploadTask(
    url,
    fileUri,
    { httpMethod: "PUT", uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, headers: { ...headers, ...extraHeaders, "Content-Type": contentType } },
    (p) => {
      last = Date.now();
      if (p.totalBytesExpectedToSend > 0 && p.totalBytesSent >= p.totalBytesExpectedToSend && sentAt === null) sentAt = last;
      onProgress(p.totalBytesExpectedToSend > 0 ? p.totalBytesSent / p.totalBytesExpectedToSend : 0);
    },
  );
  const watch = setInterval(() => {
    const quiet = sentAt !== null ? Date.now() - sentAt > 180_000 : Date.now() - last > 45_000;
    if (quiet) { stalled = true; void task.cancelAsync().catch(() => {}); }
  }, 5_000);
  try {
    // On Android the cancel makes uploadAsync REJECT rather than resolve null. Once the watchdog has fired, a rejection is the same stall.
    const res = await task.uploadAsync().catch((e: unknown) => { if (stalled) return null; throw e; });
    if (stalled || !res) throw Object.assign(new Error("upload stalled"), { code: "upload_stalled" });
    // A proxy's own error page (nginx's 413, a gateway's 502) is not JSON: read it by status, never let JSON.parse throw a bare SyntaxError.
    const body = jsonObject(res.body);
    if (res.status >= 400) {
      const code = typeof body?.code === "string"
        ? body.code
        : res.status === 413 ? "rescue_too_large" : res.status === 411 ? "length_required" : "server_unavailable";
      throw Object.assign(new Error(typeof body?.error === "string" ? body.error : "upload failed"), { status: res.status, code, info: body ?? undefined });
    }
    // A 2xx with no JSON object is not a DTO: the server answered something we cannot read, so it is an error, never an empty project.
    if (body === null) throw Object.assign(new Error("upload: no JSON reply"), { status: res.status, code: "server_unavailable" });
    return body as unknown as RescueProjectDTO;
  } finally {
    clearInterval(watch);
  }
}

export function uploadPart(versionId: string, index: number, fileUri: string, onProgress: (fraction: number) => void): Promise<RescueProjectDTO> {
  return uploadBytes(
    `${process.env.EXPO_PUBLIC_API_URL}/api/rescue-v2/versions/${versionId}/parts/${index}`,
    fileUri,
    "application/octet-stream",
    onProgress,
  );
}
