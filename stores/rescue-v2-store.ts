import { create } from "zustand";
import * as api from "@/lib/rescue-v2-api";
import { uploadPart } from "@/lib/rescue-v2-upload";
import { INITIAL_NAV, screenFor, type RescueNav } from "@/lib/rescue-v2-screen";
import { RESCUE_FIXTURES } from "@/lib/rescue-v2-fixtures";
import { useHistoryUi } from "@/stores/rescue-history-ui";
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
  /**
   * The last machine code for the sheet to word. `network`: a request that got no answer. `server_unavailable`: an answer with a status
   * and no code (a proxy's page), or a 2xx whose body is not JSON. Any other code is the server's own.
   */
  errorCode: string | null;
  /** `error.info` of that failure: `projectId`, `missing`, `fieldId`. */
  errorInfo: { projectId?: string; missing?: string[]; fieldId?: string } | null;
  nav: RescueNav;
  /**
   * Set before the first request and cleared after the last part. A null here during `uploading` means a cold start lost the upload, the open
   * project changed, or a part failed (its error is held instead, see `errorCode`).
   */
  upload: { fraction: number; fileName: string | null; sizeBytes: number; parts: number } | null;
  /**
   * The project asked for by `open` could not be read and none is on screen. The screen shows a failed state with Retry, never the upload
   * screen that a missing project would otherwise draw.
   */
  openFailed: boolean;
  /** The living screen is mounted. Task A9 drops a push's banner for the project on it. */
  screenOpen: boolean;
  pages: Record<string, { count: number; byPage: Record<number, { hash: string; url: string }> }>;
  versions: RescueVersionSummaryDTO[];
  edited: { edited: boolean; changedBlocks: number | null; afterVersionN: number | null } | null;
  details: Record<string, RescueVersionDetailDTO>;

  loadConfig(): Promise<void>;
  /**
   * `fixture` is dev only (Step 11). `view` is the overlay the caller asked for (`history` or `revisions`), applied once the project has
   * landed, so a Retry of a failed open lands on the same view.
   */
  open(projectId: string | null, fixture?: RescuePhase, view?: string): Promise<void>;
  refresh(): Promise<void>;
  setNav(patch: Partial<RescueNav>): void;
  /** Picker or Share: creates the project, uploads every part. Returns false when refused. */
  begin(files: { uri: string; name: string; size: number }[], source: "picker" | "share"): Promise<boolean>;
  /** Screen 17: first `flushOps(thesisId)` (the thesis' queued index-addressed edits go to the server before the re-run can shift every index, P-66), then sets `upload` and `overlay='revisions'`, then `createRerun`, then every part against `activeVersionId`. No files: `source: "auto"`. */
  beginRerun(files: { uri: string; name: string; size: number }[]): Promise<boolean>;
  /**
   * Brings a version back (H6). It flushes the thesis' queued edits first, as a re-run does (P-66): when they did not reach the server,
   * nothing is restored and the answer is `unsaved`. A failure is NOT recorded for the line's Retry: a restore is repeated only by its own
   * dialog, after the student confirms again. A second restore while one is in flight answers `busy`.
   */
  restoreVersion(versionId: string): Promise<RestoreOutcome>;
  setScreenOpen(open: boolean): void;
  loadPages(versionId: string, from: number, to: number): Promise<void>;
  /** True when the list was read (or was asked for under a project that has since moved on); false when the read failed. */
  loadVersions(): Promise<boolean>;
  loadDetail(versionId: string): Promise<void>;
  /**
   * Sends the supervisor's note. The same text sent again while its send is in flight is that same send: a blur and an unmount, or a CTA,
   * never send it twice. A landed send clears the history draft that held the text.
   */
  sendSupervisorNote(text: string): Promise<boolean>;
  /** Wraps a mutation: keeps the DTO it returns, or records its `code` and `info` (a thrown error with no code is `network`). Cleared by the next success. */
  apply(call: () => Promise<RescueProjectDTO>): Promise<boolean>;
  /**
   * The Retry on the error line. Repeats the last failed create, page list, list of versions, part or apply, and clears the error if the repeat
   * lands. With nothing recorded it re-reads the project. A failed repeat records itself in place of the one before.
   */
  retryLast(): Promise<void>;
  reset(): void;
}

/** A page URL is signed for an hour; re-ask at 50 minutes so no screen ever holds a dead link. */
const PAGE_URL_TTL_MS = 50 * 60 * 1000;
/** `${versionId}:${page}` → when its URL was asked for. Kept beside the store, not in it, so a page list refresh does not re-render on it. */
const fetchedAt = new Map<string, number>();

type Failure = Pick<RescueV2State, "errorCode" | "errorInfo">;
/** What repeats the failure now on the error line. Always the last failure's own; cleared with the error. */
type Repeat = { again: () => Promise<unknown> } | null;

/**
 * Three kinds of failure. A coded answer keeps its code. An answer with no code (a proxy's HTML page, a 2xx whose body is not JSON) is
 * `server_unavailable`: the server answered, it just did not say what. `network` is for a request that got no answer at all.
 */
function failure(e: unknown): Failure {
  const x = e as { code?: unknown; status?: unknown; info?: RescueV2State["errorInfo"] } | null;
  const answered = typeof x?.status === "number" || (e as { name?: unknown } | null)?.name === "SyntaxError";
  const errorCode = typeof x?.code === "string" ? x.code : answered ? "server_unavailable" : "network";
  return { errorCode, errorInfo: x?.info ?? null };
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

/** Supervisor notes on their way to the server, by `${projectId}\n${text}`. */
const notesInFlight = new Map<string, Promise<boolean>>();
/**
 * The project whose re-run or restore is being started (the flush, the create). Module-level, not in the store's state: it outlives the
 * screen, so leaving and coming back does not let a second press start a second re-run or restore for the same project (items 7 and 10).
 */
let moving: string | null = null;

/** What a restore came to: `unsaved` means the thesis' queued edits did not reach the server, so nothing was restored. */
export type RestoreOutcome = "restored" | "unsaved" | "failed" | "busy";

const INITIAL: Pick<RescueV2State,
  "config" | "projectId" | "project" | "firstLoad" | "openFailed" | "errorCode" | "errorInfo" | "nav" | "upload" | "screenOpen" | "pages" | "versions" | "edited" | "details"> = {
  config: null,
  projectId: null,
  project: null,
  firstLoad: false,
  openFailed: false,
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
  /**
   * Replies from the server can arrive after the student has moved on. `gen` moves whenever the open project changes (open, begin, reset),
   * and a reply asked under an older `gen` is dropped. `issued` numbers each request as it starts; `landed` is the newest number whose reply
   * has landed, so an older reply never overwrites a newer one. A reply lands only when both hold and the project it is for is still open.
   */
  let gen = 0;
  const issued = { dto: 0, versions: 0 };
  const landed = { dto: 0, versions: 0 };
  /**
   * A local part failure: the project, the phase it failed in, and the error. A poll keeps the error on screen while the phase is the same,
   * because the server is still waiting for the part. A retry or a phase change clears the mark (fix 2).
   */
  let pinned: { projectId: string; phase: RescuePhase | null; error: Failure } | null = null;
  /** What Retry repeats for the error on the line (fix 8). Moves with `errorCode`: set by a failure, cleared when the error clears. */
  let last: Repeat = null;

  /** Nothing has switched or been reset since `g`, and `pid` is still the open project. */
  const live = (g: number, pid: string | null) => g === gen && get().projectId === pid;
  /** A reply may land when `live` holds and no newer reply of its lane has landed. Taking it makes it the newest. */
  const claim = (lane: "dto" | "versions", g: number, pid: string | null, s: number) => {
    if (!live(g, pid) || s < landed[lane]) return false;
    landed[lane] = s;
    return true;
  };
  /** The pinned failure for `projectId` at `phase`. A mark for this project whose phase has moved on is dropped here. */
  const holdFor = (projectId: string | null, phase: RescuePhase | null): Failure | null => {
    if (!pinned || pinned.projectId !== projectId) return null;
    if (pinned.phase === phase) return pinned.error;
    pinned = null;
    return null;
  };

  /** The one place a project DTO from the server lands. The server answered, so the last error is cleared, unless a local failure still holds. */
  const land = (dto: RescueProjectDTO) => {
    // A changed project's impact is no longer its answer: the impact is read again, and the CTA waits for that reply.
    const prev = get().project;
    if (!prev || prev.id !== dto.id || !sameJson(prev, dto)) {
      const h = useHistoryUi.getState();
      h.setImpact(dto.id, "loading", h.key === dto.id ? h.impact.value : null);
    }
    const hold = holdFor(dto.id, dto.phase);
    if (!hold) last = null;
    set({
      project: dto,
      projectId: dto.id,
      nav: navAfter(get().project, dto, get().nav),
      errorCode: hold?.errorCode ?? null,
      errorInfo: hold?.errorInfo ?? null,
      firstLoad: false,
      openFailed: false,
    });
  };

  /**
   * A part of this device's upload failed. Pinned for the project and phase it failed in, and repeated by Retry from that part. Only the
   * project still open shows it, so an upload that finishes after the student switched cannot put its error on another project.
   */
  const pinFailure = (g: number, pid: string, error: Failure, again: Repeat) => {
    if (!live(g, pid)) return;
    pinned = { projectId: pid, phase: get().project?.phase ?? null, error };
    last = again;
    set({ upload: null, ...error });
  };

  /**
   * Sends each file as one part of `versionId`, one request at a time (P-10), from file `from` on. Progress is written only when the whole
   * percent changes. A switch does not stop the sending, since the server is waiting for every part; it only stops the writes.
   */
  const sendParts = async (
    g: number,
    pid: string,
    versionId: string | null,
    files: { uri: string; name: string; size: number }[],
    from = 0,
  ): Promise<boolean> => {
    if (!versionId) {
      pinFailure(g, pid, { errorCode: "server_unavailable", errorInfo: null }, null);
      return false;
    }
    const n = files.length;
    for (let i = from; i < n; i++) {
      let lastPct = -1;
      const s = ++issued.dto;
      try {
        const dto = await uploadPart(versionId, i, files[i].uri, (fr) => {
          const pct = Math.floor(((i + fr) / n) * 100);
          if (pct === lastPct) return;
          lastPct = pct;
          if (live(g, pid)) set((st) => ({ upload: st.upload ? { ...st.upload, fraction: (i + fr) / n } : st.upload }));
        });
        if (claim("dto", g, pid, s)) land(dto);
      } catch (e) {
        pinFailure(g, pid, failure(e), {
          again: () => {
            if (get().projectId !== pid) return Promise.resolve(false);
            pinned = null;
            return sendParts(gen, pid, versionId, files, i);
          },
        });
        return false;
      }
    }
    if (live(g, pid)) set({ upload: null });
    return true;
  };

    // One re-run or restore at a time per project; the body is `startRerun`, shared with nothing else.
    const startRerun = async (pid: string, project: RescueProjectDTO, files: { uri: string; name: string; size: number }[]): Promise<boolean> => {
    const g = gen;
    // Queued index-addressed edits must reach the server before the re-run shifts every index (P-66). A queue that did not drain, or a
    // flush that threw, stops the re-run: the line says so, and its Retry flushes again.
    const drained = project.thesisId
      ? await useThesisDocStore.getState().flushOps(project.thesisId).then((ok) => ok === true, () => false)
      : true;
    // The student moved on while the edits were flushing: the re-run is not started for the project they left.
    if (!live(g, pid)) return false;
    if (!drained) {
      last = { again: () => get().beginRerun(files) };
      set({ errorCode: "edits_not_saved", errorInfo: null });
      return false;
    }
    const source = files.length ? "upload" : "auto";
    const sizeBytes = files.reduce((n, f) => n + f.size, 0);
    pinned = null;
    last = null;
    set({
      errorCode: null,
      errorInfo: null,
      upload: files.length ? { fraction: 0, fileName: files[0].name, sizeBytes, parts: files.length } : null,
      nav: { ...get().nav, overlay: "revisions" },
    });
    let dto: RescueProjectDTO;
    const s = ++issued.dto;
    try {
      dto = await api.createRerun(pid, source, files.length ? files.map((f) => ({ filename: f.name, sizeBytes: f.size })) : undefined);
    } catch (e) {
      if (live(g, pid)) {
        last = { again: () => get().beginRerun(files) };
        set({ upload: null, nav: { ...get().nav, overlay: null }, ...failure(e) });
      }
      return false;
    }
    if (claim("dto", g, pid, s)) land(dto);
    if (source === "auto") {
      if (live(g, pid)) set({ upload: null });
      return true;
    }
    return sendParts(g, pid, dto.activeVersionId, files);
    };

  return {
    ...INITIAL,

    loadConfig: async () => {
      // A failed config read is not a sheet error: the config is read again on the next open.
      try { set({ config: await api.getRescueConfig() }); } catch { /* read again on the next open */ }
    },

    open: async (projectId, fixture, view) => {
      // The overlay a caller asked for is applied after the project lands: a phase change clears overlays (A1), so it cannot come first.
      const applyView = () => {
        if (view === "history") set((s) => ({ nav: { ...s.nav, overlay: "timeline" } }));
        else if (view === "revisions") set((s) => ({ nav: { ...s.nav, overlay: "revisions" } }));
      };
      if (__DEV__ && fixture) {
        gen += 1;
        pinned = null;
        last = null;
        const dto = RESCUE_FIXTURES[fixture];
        set({ projectId: dto.id, project: dto, firstLoad: false, openFailed: false, errorCode: null, errorInfo: null, nav: navAfter(get().project, dto, get().nav) });
        return;
      }
      if (!projectId) {
        gen += 1;
        pinned = null;
        last = null;
        set({ projectId: null, project: null, firstLoad: false, openFailed: false, errorCode: null, errorInfo: null, versions: [], edited: null, upload: null });
        return;
      }
      // Switching is immediate: the old project's replies stop landing from this line on.
      const switching = get().projectId !== projectId;
      if (switching) { gen += 1; pinned = null; }
      // A different project starts clean: its versions, its upload, and the old error go. The same project keeps its pinned failure.
      const first = get().project?.id !== projectId;
      const hold = switching ? null : holdFor(projectId, get().project?.phase ?? null);
      if (!hold) last = null;
      set({
        projectId,
        project: first ? null : get().project,
        firstLoad: first,
        openFailed: false,
        errorCode: hold?.errorCode ?? null,
        errorInfo: hold?.errorInfo ?? null,
        ...(switching ? { versions: [], edited: null, upload: null } : {}),
      });
      const g = gen;
      const s = ++issued.dto;
      try {
        const dto = await api.getRescueProject(projectId);
        if (claim("dto", g, projectId, s)) { land(dto); applyView(); }
      } catch (e) {
        // A failed open is repeated as a whole, with the view it was asked for: the line's Retry and the failed screen's both come here.
        if (claim("dto", g, projectId, s)) {
          last = { again: () => get().open(projectId, fixture, view) };
          // With a project already on screen, the failure is the line's only: the screen keeps what it shows.
          set({ firstLoad: false, openFailed: get().project === null, ...failure(e) });
        }
      }
    },

    refresh: async () => {
      const pid = get().projectId;
      if (!pid) return;
      const g = gen;
      const s = ++issued.dto;
      try {
        const dto = await api.getRescueProject(pid);
        if (!claim("dto", g, pid, s)) return;
        // Writes only when the DTO moved, so a 3 s poll on an unchanged project re-renders nothing.
        if (get().firstLoad || !sameJson(get().project, dto)) land(dto);
        else {
          const hold = holdFor(dto.id, dto.phase);
          if (!hold) last = null;
          const errorCode = hold?.errorCode ?? null;
          if (get().errorCode !== errorCode) set({ errorCode, errorInfo: hold?.errorInfo ?? null });
        }
      } catch (e) {
        if (claim("dto", g, pid, s)) { last = null; set(failure(e)); }
      }
    },

    setNav: (patch) => set((s) => ({ nav: { ...s.nav, ...patch } })),

    begin: async (files, source) => {
      // A new project takes the place of whatever is open: replies asked under the old one stop landing from here on.
      gen += 1;
      pinned = null;
      last = null;
      const g = gen;
      const sizeBytes = files.reduce((n, f) => n + f.size, 0);
      set({ errorCode: null, errorInfo: null, upload: { fraction: 0, fileName: files[0]?.name ?? null, sizeBytes, parts: files.length } });
      let dto: RescueProjectDTO;
      try {
        dto = await api.createRescueProject(files.map((f) => ({ filename: f.name, sizeBytes: f.size })), source);
      } catch (e) {
        if (g === gen) {
          last = { again: () => get().begin(files, source) };
          set({ upload: null, ...failure(e) });
        }
        return false;
      }
      if (g === gen) land(dto);
      return sendParts(g, dto.id, dto.activeVersionId, files);
    },

    beginRerun: async (files) => {
      const { projectId: pid, project } = get();
      if (!pid || !project) return false;
      // A second press while the first flushes or creates starts nothing: the lock is for the project, whichever screen asked.
      if (moving === pid) return false;
      moving = pid;
      try {
        return await startRerun(pid, project, files);
      } finally {
        if (moving === pid) moving = null;
      }
    },

    restoreVersion: async (versionId) => {
      const pid = get().projectId;
      const project = get().project;
      if (!pid || !project) return "failed";
      if (moving === pid) return "busy";
      moving = pid;
      const g = gen;
      try {
        // Queued index-addressed edits must reach the server before the restore moves the thesis (P-66). If they cannot, nothing is restored.
        if (project.thesisId) {
          const drained = await useThesisDocStore.getState().flushOps(project.thesisId).then((ok) => ok === true, () => false);
          if (!drained) return "unsaved";
        }
        if (!live(g, pid)) return "failed";
        const s = ++issued.dto;
        const dto = await api.restoreVersion(versionId);
        if (claim("dto", g, pid, s)) land(dto);
        return "restored";
      } catch {
        return "failed";
      } finally {
        if (moving === pid) moving = null;
      }
    },

    sendSupervisorNote: (text) => {
      const pid = get().projectId;
      if (!pid || !text) return Promise.resolve(false);
      const k = `${pid}\n${text}`;
      const inFlight = notesInFlight.get(k);
      if (inFlight) return inFlight;
      const sent = get().apply(() => api.sendNote(pid, text, "supervisor")).then((ok) => {
        notesInFlight.delete(k);
        if (ok) {
          const h = useHistoryUi.getState();
          if (h.key === pid && h.draft.trim() === text) h.setDraft(pid, "");
        }
        return ok;
      });
      notesInFlight.set(k, sent);
      return sent;
    },

    setScreenOpen: (open) => set({ screenOpen: open }),

    loadPages: async (versionId, from, to) => {
      const pid = get().projectId;
      const g = gen;
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
        const run = chunks[chunks.length - 1];
        if (run && p === run[1] + 1 && run[1] - run[0] < 11) run[1] = p;
        else chunks.push([p, p]);
      }
      for (const [a, b] of chunks) {
        try {
          const res = await api.getVersionPages(versionId, a, b);
          if (!live(g, pid)) return;
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
          if (live(g, pid)) {
            last = { again: () => get().loadPages(versionId, from, to) };
            set(failure(e));
          }
          return;
        }
      }
    },

    loadVersions: async () => {
      const pid = get().projectId;
      if (!pid) return false;
      const g = gen;
      const s = ++issued.versions;
      try {
        const r = await api.listVersions(pid);
        if (claim("versions", g, pid, s)) set({ versions: r.versions, edited: r.edited });
        return true;
      } catch (e) {
        if (claim("versions", g, pid, s)) {
          last = { again: () => get().loadVersions() };
          set(failure(e));
        }
        return false;
      }
    },

    loadDetail: async (versionId) => {
      const pid = get().projectId;
      const g = gen;
      try {
        const d = await api.getVersion(versionId);
        if (live(g, pid)) set((s) => ({ details: { ...s.details, [versionId]: d } }));
      } catch (e) {
        if (live(g, pid)) {
          last = { again: () => get().loadDetail(versionId) };
          set(failure(e));
        }
      }
    },

    apply: async (call) => {
      const pid = get().projectId;
      const g = gen;
      const s = ++issued.dto;
      try {
        const dto = await call();
        if (claim("dto", g, pid, s)) land(dto);
        return true;
      } catch (e) {
        // A failed student action is shown whatever polls landed meanwhile: only a switch or reset drops it.
        if (live(g, pid)) {
          last = { again: () => get().apply(call) };
          set(failure(e));
        }
        return false;
      }
    },

    retryLast: async () => {
      const r = last;
      if (!r) {
        await get().refresh();
        return;
      }
      last = null;
      const code = get().errorCode;
      await r.again();
      // The repeat went through without a new failure: the error it was repeating is over. (A success that is a land has cleared it already.)
      if (last === null && code !== null && get().errorCode === code) set({ errorCode: null, errorInfo: null });
    },

    reset: () => {
      gen += 1;
      pinned = null;
      last = null;
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
