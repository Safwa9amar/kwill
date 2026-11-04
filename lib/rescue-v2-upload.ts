import type { RescueProjectDTO } from "@/types/rescue-v2";
import { getAuthHeader } from "@/lib/api";

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
  const task = FileSystem.createUploadTask(
    url,
    fileUri,
    { httpMethod: "PUT", uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, headers: { ...headers, ...extraHeaders, "Content-Type": contentType } },
    (p) => { last = Date.now(); onProgress(p.totalBytesExpectedToSend > 0 ? p.totalBytesSent / p.totalBytesExpectedToSend : 0); },
  );
  // iOS's default background session never FAILS when the server or the connection is down: it retries. A timer that sees no progress
  // for 45 s cancels the task, so the bar cannot hang with no message and no way out.
  let last = Date.now(); let stalled = false;
  const watch = setInterval(() => { if (Date.now() - last > 45_000) { stalled = true; void task.cancelAsync(); } }, 5_000);
  try {
    const res = await task.uploadAsync();
    if (stalled || !res) throw Object.assign(new Error("upload stalled"), { code: "upload_stalled" });
    // A proxy's own error page (nginx's 413, a gateway's 502) is not JSON: read it by status, never let JSON.parse throw a bare SyntaxError.
    let body: any = {};
    try { body = JSON.parse(res.body || "{}"); } catch { /* by status below */ }
    if (res.status >= 400) {
      const code = body?.code ?? (res.status === 413 ? "rescue_too_large" : res.status === 411 ? "length_required" : undefined);
      throw Object.assign(new Error(body?.error || "upload failed"), { status: res.status, code, info: body });
    }
    return body as RescueProjectDTO;
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
