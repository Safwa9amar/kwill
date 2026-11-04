import { create } from "zustand";
import * as api from "@/lib/rescue-v2-api";
import { uploadPart } from "@/lib/rescue-v2-upload";
import { INITIAL_NAV, screenFor, type RescueNav } from "@/lib/rescue-v2-screen";
import { RESCUE_FIXTURES } from "@/lib/rescue-v2-fixtures";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import type {
  RescueConfigDTO,
  RescuePhase,
  RescueProjectDTO,
  RescueVersionDetailDTO,
  RescueVersionSummaryDTO,
} from "@/types/rescue-v2";

interface RescueV2State {
  config: RescueConfigDTO | null;
  projectId: string | null;
  project: RescueProjectDTO | null;
  /** True only for the first load of a project. A refresh never swaps real content for a skeleton. */
  firstLoad: boolean;
  /** The last machine code from the server, for the sheet to word; `network` for a request that never got an answer. */
  errorCode: string | null;
  /** `error.info` of that failure: `projectId`, `missing`, `fieldId`. */
  errorInfo: { projectId?: string; missing?: string[]; fieldId?: string } | null;
  nav: RescueNav;
  /** Set before the first request and cleared after the last part, so a null here during `uploading` can only mean a cold start lost the upload. */
  upload: { fraction: number; fileName: string | null; sizeBytes: number; parts: number } | null;
  /** The living screen is mounted. Task A9 drops a push's banner for the project on it. */
  screenOpen: boolean;
  pages: Record<string, { count: number; byPage: Record<number, { hash: string; url: string }> }>;
  versions: RescueVersionSummaryDTO[];
  edited: { edited: boolean; changedBlocks: number | null; afterVersionN: number | null } | null;
  details: Record<string, RescueVersionDetailDTO>;

  loadConfig(): Promise<void>;
  /** `fixture` is dev only (Step 11). */
  open(projectId: string | null, fixture?: RescuePhase): Promise<void>;
  refresh(): Promise<void>;
  setNav(patch: Partial<RescueNav>): void;
  /** Picker or Share: creates the project, uploads every part. Returns false when refused. */
  begin(files: { uri: string; name: string; size: number }[], source: "picker" | "share"): Promise<boolean>;
  /** Screen 17: first `flushOps(thesisId)` (the thesis' queued index-addressed edits go to the server before the re-run can shift every index, P-66), then sets `upload` and `overlay='revisions'`, then `createRerun`, then every part against `activeVersionId`. No files: `source: "auto"`. */
  beginRerun(files: { uri: string; name: string; size: number }[]): Promise<boolean>;
  setScreenOpen(open: boolean): void;
  loadPages(versionId: string, from: number, to: number): Promise<void>;
  loadVersions(): Promise<void>;
  loadDetail(versionId: string): Promise<void>;
  /** Wraps a mutation: keeps the DTO it returns, or records its `code` and `info` (a thrown error with no code is `network`). Cleared by the next success. */
  apply(call: () => Promise<RescueProjectDTO>): Promise<boolean>;
  reset(): void;
}

/** A page URL is signed for an hour; re-ask at 50 minutes so no screen ever holds a dead link. */
const PAGE_URL_TTL_MS = 50 * 60 * 1000;
/** `${versionId}:${page}` → when its URL was asked for. Kept beside the store, not in it, so a page list refresh does not re-render on it. */
const fetchedAt = new Map<string, number>();

function failure(e: unknown): Pick<RescueV2State, "errorCode" | "errorInfo"> {
  const x = e as { code?: unknown; info?: RescueV2State["errorInfo"] } | null;
  return { errorCode: typeof x?.code === "string" ? x.code : "network", errorInfo: x?.info ?? null };
}

/**
 * Whenever `phase` changes, the overlay and the payment step close (§1.1): a finished re-run lands on the result and a granted
 * payment moves on. The one exception is a change TO `uploading`, which keeps `overlay='revisions'`, because screen 17 stays up while a re-run uploads.
 */
function navAfter(prev: RescueProjectDTO | null, dto: RescueProjectDTO, nav: RescueNav): RescueNav {
  if (prev?.phase === dto.phase) return nav;
  return { ...nav, paying: false, overlay: dto.phase === "uploading" && nav.overlay === "revisions" ? nav.overlay : null };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const INITIAL: Pick<RescueV2State,
  "config" | "projectId" | "project" | "firstLoad" | "errorCode" | "errorInfo" | "nav" | "upload" | "screenOpen" | "pages" | "versions" | "edited" | "details"> = {
  config: null,
  projectId: null,
  project: null,
  firstLoad: false,
  errorCode: null,
  errorInfo: null,
  nav: INITIAL_NAV,
  upload: null,
  screenOpen: false,
  pages: {},
  versions: [],
  edited: null,
  details: {},
};

export const useRescueV2Store = create<RescueV2State>()((set, get) => {
  /** The one place a project DTO from the server lands. The server answered, so the last error is cleared. */
  const land = (dto: RescueProjectDTO) => {
    set({
      project: dto,
      projectId: dto.id,
      nav: navAfter(get().project, dto, get().nav),
      errorCode: null,
      errorInfo: null,
      firstLoad: false,
    });
  };

  /** Sends each file as one part of `versionId`, one request at a time (P-10). Progress is written only when the whole percent changes. */
  const sendParts = async (versionId: string | null, files: { uri: string; name: string; size: number }[]): Promise<boolean> => {
    if (!versionId) {
      set({ upload: null, errorCode: "network", errorInfo: null });
      return false;
    }
    const n = files.length;
    for (let i = 0; i < n; i++) {
      let lastPct = -1;
      try {
        const dto = await uploadPart(versionId, i, files[i].uri, (fr) => {
          const pct = Math.floor(((i + fr) / n) * 100);
          if (pct === lastPct) return;
          lastPct = pct;
          set((s) => ({ upload: s.upload ? { ...s.upload, fraction: (i + fr) / n } : s.upload }));
        });
        land(dto);
      } catch (e) {
        set({ upload: null, ...failure(e) });
        return false;
      }
    }
    set({ upload: null });
    return true;
  };

  return {
    ...INITIAL,

    loadConfig: async () => {
      // A failed config read is not a sheet error: the config is read again on the next open.
      try { set({ config: await api.getRescueConfig() }); } catch { /* read again on the next open */ }
    },

    open: async (projectId, fixture) => {
      if (__DEV__ && fixture) {
        const dto = RESCUE_FIXTURES[fixture];
        set({ projectId: dto.id, project: dto, firstLoad: false, errorCode: null, errorInfo: null, nav: navAfter(get().project, dto, get().nav) });
        return;
      }
      if (!projectId) {
        set({ projectId: null, project: null, firstLoad: false, errorCode: null, errorInfo: null });
        return;
      }
      // A different project: drop the old one so its content never shows under the new id's skeleton.
      const first = get().project?.id !== projectId;
      set({ projectId, project: first ? null : get().project, firstLoad: first, errorCode: null, errorInfo: null });
      try {
        land(await api.getRescueProject(projectId));
      } catch (e) {
        set({ firstLoad: false, ...failure(e) });
      }
    },

    refresh: async () => {
      const id = get().projectId;
      if (!id) return;
      try {
        const dto = await api.getRescueProject(id);
        // Writes only when the DTO moved, so a 3 s poll on an unchanged project re-renders nothing.
        if (get().firstLoad || !sameJson(get().project, dto)) land(dto);
        else if (get().errorCode !== null) set({ errorCode: null, errorInfo: null });
      } catch (e) {
        set(failure(e));
      }
    },

    setNav: (patch) => set((s) => ({ nav: { ...s.nav, ...patch } })),

    begin: async (files, source) => {
      const sizeBytes = files.reduce((n, f) => n + f.size, 0);
      set({ errorCode: null, errorInfo: null, upload: { fraction: 0, fileName: files[0]?.name ?? null, sizeBytes, parts: files.length } });
      let dto: RescueProjectDTO;
      try {
        dto = await api.createRescueProject(files.map((f) => ({ filename: f.name, sizeBytes: f.size })), source);
      } catch (e) {
        set({ upload: null, ...failure(e) });
        return false;
      }
      land(dto);
      return sendParts(dto.activeVersionId, files);
    },

    beginRerun: async (files) => {
      const { projectId, project } = get();
      if (!projectId || !project) return false;
      // Queued index-addressed edits must reach the server before the re-run shifts every index (P-66).
      if (project.thesisId) await useThesisDocStore.getState().flushOps(project.thesisId).catch(() => false);
      const source = files.length ? "upload" : "auto";
      const sizeBytes = files.reduce((n, f) => n + f.size, 0);
      set({
        errorCode: null,
        errorInfo: null,
        upload: files.length ? { fraction: 0, fileName: files[0].name, sizeBytes, parts: files.length } : null,
        nav: { ...get().nav, overlay: "revisions" },
      });
      let dto: RescueProjectDTO;
      try {
        dto = await api.createRerun(projectId, source, files.length ? files.map((f) => ({ filename: f.name, sizeBytes: f.size })) : undefined);
      } catch (e) {
        set({ upload: null, nav: { ...get().nav, overlay: null }, ...failure(e) });
        return false;
      }
      land(dto);
      if (source === "auto") {
        set({ upload: null });
        return true;
      }
      return sendParts(dto.activeVersionId, files);
    },

    setScreenOpen: (open) => set({ screenOpen: open }),

    loadPages: async (versionId, from, to) => {
      const now = Date.now();
      const held = get().pages[versionId]?.byPage ?? {};
      // Ask only for pages not held, or held with a URL past its TTL. A page the server did not have yet is simply not held, so it is asked again.
      const want: number[] = [];
      for (let p = from; p <= to; p++) {
        const fresh = held[p] !== undefined && now - (fetchedAt.get(`${versionId}:${p}`) ?? 0) < PAGE_URL_TTL_MS;
        if (!fresh) want.push(p);
      }
      // Contiguous runs, at most 12 pages a request.
      const chunks: [number, number][] = [];
      for (const p of want) {
        const last = chunks[chunks.length - 1];
        if (last && p === last[1] + 1 && last[1] - last[0] < 11) last[1] = p;
        else chunks.push([p, p]);
      }
      for (const [a, b] of chunks) {
        try {
          const res = await api.getVersionPages(versionId, a, b);
          const t = Date.now();
          set((s) => {
            const prev = s.pages[versionId] ?? { count: 0, byPage: {} };
            const byPage = { ...prev.byPage };
            for (const p of res.pages) {
              byPage[p.page] = { hash: p.hash, url: p.url };
              fetchedAt.set(`${versionId}:${p.page}`, t);
            }
            return { pages: { ...s.pages, [versionId]: { count: res.count, byPage } } };
          });
        } catch (e) {
          set(failure(e));
          return;
        }
      }
    },

    loadVersions: async () => {
      const id = get().projectId;
      if (!id) return;
      try {
        const r = await api.listVersions(id);
        set({ versions: r.versions, edited: r.edited });
      } catch (e) {
        set(failure(e));
      }
    },

    loadDetail: async (versionId) => {
      try {
        const d = await api.getVersion(versionId);
        set((s) => ({ details: { ...s.details, [versionId]: d } }));
      } catch (e) {
        set(failure(e));
      }
    },

    apply: async (call) => {
      try {
        land(await call());
        return true;
      } catch (e) {
        set(failure(e));
        return false;
      }
    },

    reset: () => {
      fetchedAt.clear();
      set({ ...INITIAL });
    },
  };
});

export const useRescuePhase = () => useRescueV2Store((s) => s.project?.phase ?? null);
export const useRescueScreen = () => useRescueV2Store((s) => screenFor(s.project, s.nav));
export const useRescueProjectId = () => useRescueV2Store((s) => s.projectId);
export const useRescuePagesReady = () => useRescueV2Store((s) => s.project?.progress?.pagesReady ?? 0);
export const usePageMeta = (versionId: string | null, page: number) =>
  useRescueV2Store((s) => (versionId ? s.pages[versionId]?.byPage[page]?.hash ?? null : null));
