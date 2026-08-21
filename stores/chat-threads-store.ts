import { create } from "zustand";
import {
  listThreads,
  createThread,
  patchThread,
  deleteThread,
  searchThreads,
  threadForThesis,
  type ChatThread,
  type ThreadSearchResult,
} from "@/lib/api";
import { chatModeOf, DEFAULT_CHAT_MODE, type ChatMode } from "@/lib/chat-modes";

// Owns the conversation list for the history panel: every thread the student
// can switch to, search results, and which one is currently open. The server
// stays the source of truth for ordering (pinned first, then most recent) —
// this store only holds what it was given; see lib/thread-groups.ts for the
// one place a fetched list gets partitioned for display.

// Stable empty results — a fresh `[]` from a selector would make
// useSyncExternalStore see a new snapshot every render and throw "Maximum
// update depth exceeded". Not needed for `threads`/`results` themselves (they
// are plain state fields, only ever replaced by `set`), but kept here as the
// one shared fallback so nothing downstream has to invent its own `[]`.
const EMPTY_RESULTS: ThreadSearchResult[] = [];

interface ChatThreadsState {
  threads: ChatThread[];
  currentThreadId: string | null;
  /**
   * A conversation something OUTSIDE the chat screen wants it to open — the
   * drawer's free-chat list. The screen consumes it and clears it.
   *
   * Setting `currentThreadId` alone is not enough: the chat screen holds the
   * thread it is showing in its own state and only re-resolves when the selected
   * THESIS changes, so switching between two conversations that share a thesis
   * (or share none at all) would move nothing. This is an explicit intent rather
   * than a piece of state to diff against.
   */
  pendingOpenThreadId: string | null;
  loading: boolean;
  query: string;
  results: ThreadSearchResult[];
  searching: boolean;

  /** Mode per thread, seeded from the server's thread list and updated when the
   *  student picks one. Kept here rather than in chat-store because it belongs to
   *  the CONVERSATION, not to the messages on screen. */
  modes: Record<string, ChatMode>;
  modeFor: (threadId: string | null) => ChatMode;
  setMode: (threadId: string, mode: ChatMode) => void;

  /** Fetch the thread list, optionally scoped to one thesis. Best-effort: on
   *  failure the last good list stays on screen (same convention as
   *  outline-store.sync). */
  load: (thesisId?: string) => Promise<void>;
  setCurrent: (id: string | null) => void;
  /** Ask the chat screen to open this conversation (see pendingOpenThreadId). */
  requestOpenThread: (id: string) => void;
  /** The chat screen acknowledging the request above — always call it, or the
   *  same conversation is re-opened on the screen's every subsequent render. */
  consumeOpenThread: () => void;
  /** Optimistically create a thread (shown first, matching the server's own
   *  ranking for a brand-new empty thread), reconciled with the real row.
   *  Returns the new thread's id. */
  newThread: (thesisId?: string | null) => Promise<string>;
  rename: (id: string, title: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  search: (q: string) => Promise<void>;
  /** Applies the [[MODK_TITLE]] stream frame: a thread just got its first
   *  generated title, live, without waiting for a refetch. */
  applyTitle: (threadId: string, title: string) => void;
  /** Merge a server-returned thread row into the list (upsert). */
  applyThread: (row: ChatThread) => void;
  /**
   * The thread the Writer should be talking to for this thesis, resolved once and
   * cached. Calls POST /api/threads/for-thesis, which answers "the conversation
   * this thesis is currently in" — deliberately a server call, because the thread
   * LIST ranks a brand-new empty thread first (the student just tapped ＋) while
   * this question wants the thread with something in it.
   */
  ensureThreadFor: (thesisId: string) => Promise<string>;
}

export const useChatThreadsStore = create<ChatThreadsState>((set, get) => ({
  threads: [],
  currentThreadId: null,
  pendingOpenThreadId: null,
  loading: false,
  query: "",
  results: EMPTY_RESULTS,
  searching: false,
  modes: {},
  modeFor: (threadId) => (threadId ? get().modes[threadId] ?? DEFAULT_CHAT_MODE : DEFAULT_CHAT_MODE),
  setMode: (threadId, mode) => set((s) => ({ modes: { ...s.modes, [threadId]: mode } })),

  load: async (thesisId) => {
    set({ loading: true });
    try {
      const threads = await listThreads(thesisId ? { thesisId } : undefined);
      const modes = Object.fromEntries(threads.map((th) => [th.id, chatModeOf(th.mode)]));
      set({ threads, modes: { ...get().modes, ...modes } });
    } catch {
      // Keep whatever is already on screen — a failed refresh must never blank
      // the panel out from under the student.
    } finally {
      set({ loading: false });
    }
  },

  setCurrent: (id) => set({ currentThreadId: id }),

  requestOpenThread: (id) => set({ pendingOpenThreadId: id }),

  consumeOpenThread: () => set({ pendingOpenThreadId: null }),

  newThread: async (thesisId) => {
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = new Date().toISOString();
    const optimistic: ChatThread = {
      id: tempId,
      thesisId: thesisId ?? null,
      title: null,
      pinned: false,
      archivedAt: null,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    };
    // Shown first — the server ranks a brand-new empty thread first too, so this
    // matches what the reconciled list will look like once the real row lands.
    set((s) => ({ threads: [optimistic, ...s.threads] }));
    try {
      const thread = await createThread(thesisId);
      set((s) => ({ threads: s.threads.map((t) => (t.id === tempId ? thread : t)) }));
      return thread.id;
    } catch (e) {
      // Roll back rather than leave a fake row the student could tap into.
      set((s) => ({ threads: s.threads.filter((t) => t.id !== tempId) }));
      throw e;
    }
  },

  rename: async (id, title) => {
    const prev = get().threads;
    set({ threads: prev.map((t) => (t.id === id ? { ...t, title } : t)) });
    try {
      const updated = await patchThread(id, { title });
      set((s) => ({ threads: s.threads.map((t) => (t.id === id ? updated : t)) }));
    } catch {
      set({ threads: prev }); // roll back rather than leave the list lying
    }
  },

  setPinned: async (id, pinned) => {
    const prev = get().threads;
    set({ threads: prev.map((t) => (t.id === id ? { ...t, pinned } : t)) });
    try {
      const updated = await patchThread(id, { pinned });
      set((s) => ({ threads: s.threads.map((t) => (t.id === id ? updated : t)) }));
    } catch {
      set({ threads: prev });
    }
  },

  setArchived: async (id, archived) => {
    const prev = get().threads;
    set({
      threads: prev.map((t) =>
        t.id === id ? { ...t, archivedAt: archived ? new Date().toISOString() : null } : t
      ),
    });
    try {
      const updated = await patchThread(id, { archived });
      set((s) => ({ threads: s.threads.map((t) => (t.id === id ? updated : t)) }));
    } catch {
      set({ threads: prev });
    }
  },

  remove: async (id) => {
    const prev = get().threads;
    set({ threads: prev.filter((t) => t.id !== id) });
    try {
      await deleteThread(id);
    } catch {
      // The delete never landed server-side — put the row back rather than
      // leave the panel showing a thread that still exists.
      set({ threads: prev });
    }
  },

  search: async (q) => {
    set({ query: q });
    if (!q.trim()) {
      set({ results: EMPTY_RESULTS, searching: false });
      return;
    }
    set({ searching: true });
    try {
      const results = await searchThreads(q);
      // Stale-response guard: a slower earlier request must not clobber a
      // faster later one's results.
      if (get().query === q) set({ results });
    } catch {
      if (get().query === q) set({ results: EMPTY_RESULTS });
    } finally {
      if (get().query === q) set({ searching: false });
    }
  },

  applyTitle: (threadId, title) =>
    set((s) => ({ threads: s.threads.map((t) => (t.id === threadId ? { ...t, title } : t)) })),

  applyThread: (row) =>
    set((s) => ({
      // Upsert rather than map: a thread the list hasn't loaded yet (the student
      // attached a thesis before ever opening the history panel) still has to
      // land, or the panel would show it under the wrong section.
      threads: s.threads.some((t) => t.id === row.id)
        ? s.threads.map((t) => (t.id === row.id ? row : t))
        : [row, ...s.threads],
    })),

  ensureThreadFor: async (thesisId) => {
    const { currentThreadId, threads } = get();
    // Already resolved for THIS thesis — reuse it rather than round-tripping the
    // server on every call (this fires from every send site, not just once).
    if (currentThreadId) {
      const cached = threads.find((t) => t.id === currentThreadId);
      if (cached && cached.thesisId === thesisId) return currentThreadId;
    }
    const thread = await threadForThesis(thesisId);
    set((s) => ({
      currentThreadId: thread.id,
      threads: s.threads.some((t) => t.id === thread.id)
        ? s.threads.map((t) => (t.id === thread.id ? thread : t))
        : [thread, ...s.threads],
    }));
    return thread.id;
  },
}));
