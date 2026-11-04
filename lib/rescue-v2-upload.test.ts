import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module under test imports expo-file-system/legacy and lib/api, which pulls in
// react-native. Both are replaced here, so the test runs under node.
const h = vi.hoisted(() => ({ createUploadTask: vi.fn() }));
vi.mock("expo-file-system/legacy", () => ({
  FileSystemUploadType: { BINARY_CONTENT: 0 },
  createUploadTask: h.createUploadTask,
}));
vi.mock("@/lib/api", () => ({
  getAuthHeader: async () => ({ Authorization: "Bearer test-token" }),
}));

import { uploadPart } from "./rescue-v2-upload";

function task(result: unknown) {
  return { uploadAsync: vi.fn(async () => result), cancelAsync: vi.fn(async () => {}) };
}

describe("uploadPart", () => {
  beforeEach(() => h.createUploadTask.mockReset());

  it("sends raw bytes as PUT with the bearer token and the part's URL", async () => {
    h.createUploadTask.mockReturnValueOnce(task({ status: 200, body: "{\"id\":\"v1\"}" }));
    await uploadPart("v1", 2, "file:///part.docx", () => {});
    const [url, uri, options] = h.createUploadTask.mock.calls[0];
    expect(url).toContain("/api/rescue-v2/versions/v1/parts/2");
    expect(uri).toBe("file:///part.docx");
    expect(options).toMatchObject({
      httpMethod: "PUT",
      uploadType: 0,
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/octet-stream" },
    });
  });

  it("a 413 with an HTML body (a proxy's page) becomes rescue_too_large, never a JSON SyntaxError", async () => {
    h.createUploadTask.mockReturnValueOnce(task({ status: 413, body: "<html>413 Request Entity Too Large</html>" }));
    await expect(uploadPart("v1", 0, "file:///a.docx", () => {})).rejects.toMatchObject({
      status: 413,
      code: "rescue_too_large",
    });
  });

  it("a 400 JSON body keeps its own code", async () => {
    h.createUploadTask.mockReturnValueOnce(task({ status: 400, body: "{\"error\":\"not a docx\",\"code\":\"not_docx\"}" }));
    await expect(uploadPart("v1", 0, "file:///a.txt", () => {})).rejects.toMatchObject({
      status: 400,
      code: "not_docx",
    });
  });

  describe("stall watchdog", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("no progress for 45 s cancels the task and reports upload_stalled", async () => {
      let release!: (v: null) => void;
      const cancelAsync = vi.fn(async () => release(null));
      h.createUploadTask.mockReturnValueOnce({
        uploadAsync: () => new Promise((r) => { release = r; }),
        cancelAsync,
      });
      const p = uploadPart("v1", 0, "file:///a.docx", () => {});
      const outcome = expect(p).rejects.toMatchObject({ code: "upload_stalled" });
      await vi.waitFor(() => expect(h.createUploadTask).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(50_000);
      await outcome;
      expect(cancelAsync).toHaveBeenCalled();
    });

    it("progress keeps the upload alive and reports the fraction", async () => {
      let progress!: (p: { totalBytesSent: number; totalBytesExpectedToSend: number }) => void;
      const cancelAsync = vi.fn(async () => {});
      h.createUploadTask.mockImplementationOnce((_url, _uri, _opts, cb) => {
        progress = cb;
        return {
          uploadAsync: () => new Promise((r) => setTimeout(() => r({ status: 200, body: "{\"id\":\"v1\"}" }), 60_000)),
          cancelAsync,
        };
      });
      const onProgress = vi.fn();
      const p = uploadPart("v1", 0, "file:///a.docx", onProgress);
      await vi.waitFor(() => expect(h.createUploadTask).toHaveBeenCalled());
      for (let t = 1; t <= 6; t++) {
        await vi.advanceTimersByTimeAsync(10_000);
        progress({ totalBytesSent: t, totalBytesExpectedToSend: 10 });
      }
      await expect(p).resolves.toMatchObject({ id: "v1" });
      expect(cancelAsync).not.toHaveBeenCalled();
      expect(onProgress).toHaveBeenLastCalledWith(0.6);
    });
  });
});
