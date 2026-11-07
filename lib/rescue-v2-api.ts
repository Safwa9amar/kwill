import { apiDeleteJson, apiGet, apiPost, apiPut } from "@/lib/api";
import { uploadBytes } from "@/lib/rescue-v2-upload";
import type {
  RescueChangeItemDTO,
  RescueConfigDTO,
  RescueCoverChoice,
  RescueCoverFieldsDTO,
  RescueImpactDTO,
  RescueProjectDTO,
  RescueProjectSummaryDTO,
  RescueRuleFieldId,
  RescueVersionDetailDTO,
  RescueVersionSummaryDTO,
} from "@/types/rescue-v2";

// Typed wrappers, one per row of §1.4. Errors thrown here carry `.status`, `.code`, and `.info` (lib/api.ts decorateApiError).
const base = "/api/rescue-v2";

export interface RescueVersionsDTO {
  versions: RescueVersionSummaryDTO[];
  edited: { edited: boolean; changedBlocks: number | null; afterVersionN: number | null };
}
export interface RescueCompareDTO {
  total: number;
  pages: { page: number; aUrl: string; bUrl: string; aHash: string; bHash: string }[];
  changes: RescueChangeItemDTO[];
}
export interface RescueFileDTO { url: string; filename: string; format: string; title: string }
export interface RescuePreviewDTO {
  cover: { afterUrl: string; beforeUrl: string };
  chapter: { afterUrl: string; beforeUrl: string } | null;
}

export const getRescueConfig = () => apiGet<RescueConfigDTO>(`${base}/config`);
export const listRescueProjects = () => apiGet<{ projects: RescueProjectSummaryDTO[] }>(`${base}/projects`);
export const createRescueProject = (parts: { filename: string; sizeBytes: number }[], source: "picker" | "share") =>
  apiPost<RescueProjectDTO>(`${base}/projects`, { parts, source });
export const getRescueProject = (id: string) => apiGet<RescueProjectDTO>(`${base}/projects/${id}`);
export const deleteRescueProject = (id: string) => apiDeleteJson<{ deleted: true }>(`${base}/projects/${id}`);
export const deleteUploadVersion = (versionId: string) => apiDeleteJson<RescueProjectDTO>(`${base}/versions/${versionId}`);

export const confirmPartOrder = (id: string, order: number[], continuesPrevious: number[]) =>
  apiPut<RescueProjectDTO>(`${base}/projects/${id}/part-order`, { order, continuesPrevious });
export const updateSetup = (id: string, body: { universityId?: string | null; normProfileId?: string | null }) =>
  apiPut<RescueProjectDTO>(`${base}/projects/${id}/setup`, body);

/** Raw bytes, the real Content-Type, and the file name in a header (never the query string, which the request log writes). */
export const uploadGuide = (id: string, fileUri: string, fileName: string, contentType: string, onProgress: (fraction: number) => void = () => {}) =>
  uploadBytes(
    `${process.env.EXPO_PUBLIC_API_URL}${base}/projects/${id}/guide`,
    fileUri,
    contentType,
    onProgress,
    { "x-file-name": encodeURIComponent(fileName) },
  );
export const removeGuide = (id: string) => apiDeleteJson<RescueProjectDTO>(`${base}/projects/${id}/guide`);

export const sendNote = (id: string, text: string, kind: "start" | "supervisor") =>
  apiPut<RescueProjectDTO>(`${base}/projects/${id}/note`, { text, kind });
export const removeNoteChip = (id: string, chipId: string) =>
  apiDeleteJson<RescueProjectDTO>(`${base}/projects/${id}/note/chips/${encodeURIComponent(chipId)}`);
export const resolveNoteConflict = (id: string, conflictId: string, choice: "note" | "guide") =>
  apiPost<RescueProjectDTO>(`${base}/projects/${id}/note/conflicts/${encodeURIComponent(conflictId)}`, { choice });

export const startDiagnosis = (id: string) => apiPost<RescueProjectDTO>(`${base}/projects/${id}/diagnose`, {});
export const getVersionPages = (versionId: string, from: number, to: number) =>
  apiGet<{ count: number; pages: { page: number; hash: string; url: string }[] }>(`${base}/versions/${versionId}/pages?from=${from}&to=${to}`);
export const getRescuePreview = (id: string) => apiGet<RescuePreviewDTO>(`${base}/projects/${id}/preview`);
export const continueRescue = (id: string) => apiPost<RescueProjectDTO>(`${base}/projects/${id}/continue`, {});

export const saveRules = (id: string, body: { edits?: Partial<Record<RescueRuleFieldId, string | number | boolean>>; confirm?: boolean }) =>
  apiPut<RescueProjectDTO>(`${base}/projects/${id}/rules`, body);
export const saveAnswer = (id: string, key: string, answer: { role: string } | { decide: true }) =>
  apiPut<RescueProjectDTO>(`${base}/projects/${id}/answers`, { key, answer });
export const saveCover = (id: string, body: { choice?: RescueCoverChoice; fields?: RescueCoverFieldsDTO }) =>
  apiPut<RescueProjectDTO>(`${base}/projects/${id}/cover`, body);
export const renderCoverSamples = (id: string) => apiPost<RescueProjectDTO>(`${base}/projects/${id}/cover/samples`, {});
export const getCoverSamples = (id: string) => apiGet<{ keep?: string; clean?: string; generated?: string }>(`${base}/projects/${id}/cover/samples`);
export const startRescue = (id: string) => apiPost<RescueProjectDTO>(`${base}/projects/${id}/rescue`, {});
/** `language`: the UI's, so the Support case it opens is in the words the student reads (the server falls back to the thesis'). */
export const requestRescueReview = (versionId: string, language?: string) =>
  apiPost<RescueProjectDTO>(`${base}/versions/${versionId}/review-request`, language ? { language } : {});

export const listVersions = (id: string) => apiGet<RescueVersionsDTO>(`${base}/projects/${id}/versions`);
export const getVersion = (versionId: string) => apiGet<RescueVersionDetailDTO>(`${base}/versions/${versionId}`);
export const getVersionFile = (versionId: string, kind: "pdf" | "docx" | "deposit" | "part", index?: number) =>
  apiGet<RescueFileDTO>(`${base}/versions/${versionId}/files/${kind}${index !== undefined ? `?index=${index}` : ""}`);
export const compareVersions = (a: string, b: string, offset = 0, limit = 6) =>
  apiGet<RescueCompareDTO>(`${base}/versions/${a}/compare/${b}?offset=${offset}&limit=${limit}`);
export const restoreVersion = (versionId: string) => apiPost<RescueProjectDTO>(`${base}/versions/${versionId}/restore`, {});
export const createRerun = (id: string, source: "auto" | "upload", parts?: { filename: string; sizeBytes: number }[]) =>
  apiPost<RescueProjectDTO>(`${base}/projects/${id}/reruns`, parts ? { source, parts } : { source });
export const getImpact = (id: string) => apiGet<RescueImpactDTO>(`${base}/projects/${id}/impact`);
export const resumeVersion = (versionId: string) => apiPost<RescueProjectDTO>(`${base}/versions/${versionId}/resume`, {});
export const ackVersion = (versionId: string) => apiPost<RescueProjectDTO>(`${base}/versions/${versionId}/ack`, {});
