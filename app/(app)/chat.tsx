import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { View, Text, StyleSheet, FlatList, Pressable, TextInput as RNTextInput, KeyboardAvoidingView, Platform, Keyboard, Image, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming } from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useBottomInset, useKeyboardLift } from "@/hooks/useBottomInset";
import { useThesisStore } from "@/stores/thesis-store";
import { useChatStore } from "@/stores/chat-store";
import { useChatThreadsStore } from "@/stores/chat-threads-store";
import { useBottomSheet } from "@/stores/bottom-sheet-store";
import { useChatHead } from "@/stores/chat-head-store";
import { sendMessageToAI, loadInitialMessages, loadOlderMessages, regenerateLastResponse, continueInterruptedTurn, retryFailedMessage, approvePendingAction, declinePendingAction, executePlan, stopTurn } from "@/lib/ai-service";
import { lastTurnDidWork } from "@/lib/turn-work";
import { ComposerConfirm } from "@/components/workspace/ComposerConfirm";
import { ArrowUp, Plus, Mic, Paperclip, Image as ImageIcon, Camera, ClipboardPaste, ChevronDown, Square, X, FileText, SquarePen, History } from "lucide-react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { AskBottomSheet } from "@/components/AskBottomSheet";
import { DrawerMenuButton } from "@/components/DrawerMenuButton";
import { MessageViewer } from "@/components/MessageViewer";
import { ChatSkeleton } from "@/components/ChatSkeleton";
import { resolveBlockIndex, type BlockLink } from "@/lib/block-links";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useThesisDocStore } from "@/stores/thesis-doc-store";
import { ComposerQuickActions } from "@/components/workspace/ComposerQuickActions";
import { QuotaNotice } from "@/components/chat/QuotaNotice";
import { useBillingStore } from "@/stores/billing-store";
import { useComposerSuggestions } from "@/hooks/useComposerSuggestions";
import { useSpeakMessage } from "@/hooks/useSpeakMessage";
import { TypingIndicator } from "@/components/TypingIndicator";
import { AiWorkingNote } from "@/components/AiWorkingNote";
import { useVoiceDictation } from "@/lib/voice";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Alert } from "react-native";
import { ChatImageViewer } from "@/components/ChatImages";
import { pickChatImages, captureChatImage, pasteChatImage, MAX_CHAT_IMAGES, type StagedImage } from "@/lib/chat-images";
import { ChatHistoryPanel } from "@/components/chat/ChatHistoryPanel";
import { ChatModeChip } from "@/components/chat/ChatModeChip";
import { ChatModeSheet } from "@/components/chat/ChatModeSheet";
import { DEFAULT_CHAT_MODE, type ChatMode } from "@/lib/chat-modes";
import { ChatWelcome } from "@/components/chat/ChatWelcome";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { TimeDivider, shouldShowTime } from "@/components/chat/TimeDivider";
import { downloadExport } from "@/lib/download-export";
import { ThesisAttachSheet } from "@/components/chat/ThesisAttachSheet";
import { addSource, patchThread } from "@/lib/api";
import { useSourceStore } from "@/stores/source-store";
import type { ThesisSource } from "@/types/source";
import type { ChatImage, FilePayload } from "@/types/chat";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Whether opening this thread should wait behind a loading skeleton.
 *
 * `lastMessageAt` is the honest signal: null means the conversation has never
 * held a message, so there is nothing on the server to fetch and a skeleton
 * would be showing placeholder bubbles for a load that will find nothing. A
 * thread we don't know about yet also answers false — under-showing the
 * skeleton just means an empty chat that fills in, which is far better than the
 * reverse.
 */
function threadHasHistory(threadId: string): boolean {
  const row = useChatThreadsStore.getState().threads.find((t) => t.id === threadId);
  return !!row?.lastMessageAt;
}

/**
 * Whether this mount has a conversation to RESUME — i.e. whether the opening
 * resolve has a question to ask before the screen can honestly say "nothing has
 * been said yet".
 *
 * A thesis in hand means the server is about to be asked which conversation that
 * thesis is currently in; a currentThreadId means one is already open this
 * session. Either way an answer is on its way, and drawing the welcome art in
 * the meantime is what made a returning student watch TWO different screens on
 * every launch — the empty-state, then their actual chat a moment later.
 */
function hasConversationToResume(thesisId: string | null): boolean {
  return !!thesisId || !!useChatThreadsStore.getState().currentThreadId;
}

// A picked-but-not-yet-sent document. Staged in the composer so the user can add
// a prompt (or remove it) before it goes to the AI. Images are staged separately
// (see `images` below) because several can ride on one message and their bytes
// travel WITH the turn (lib/chat-images.ts); a document takes the other route —
// it is stored as one of the thesis's sources first, and the turn then talks
// about something already on the server (see uploadAttachmentAsSource).
type Attachment = { type: "file"; uri: string; name: string; size?: number };

// What a document attached in chat is allowed to be — the same list the Sources
// sheet offers, plus PDF. Only .docx / .txt / .md have their text extracted
// server-side today; a PDF is still stored (so it's there when extraction
// lands), and the message says outright that it couldn't be read, rather than
// letting the AI meet an empty source and guess why.
const SOURCE_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "application/pdf",
];

// What the server accepts for one source material (lib/source-service). Checked
// here as well so a file too big to store is refused before it is read into a
// base64 string several megabytes long — and with a message that names the limit.
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/**
 * Put a document the student attached in chat where the AI can actually READ it:
 * the thesis's SOURCE MATERIALS.
 *
 * Chat has no channel for file bytes — a turn carries text and images and
 * nothing else — so for a long time the attachment contributed only its NAME to
 * the message and the file itself was dropped when the composer cleared. The AI
 * was then asked to analyse a document it had never been given, and (rightly)
 * said it couldn't.
 *
 * Sources are that channel, and they already exist: the server extracts the
 * text, embeds it for retrieval, and the AI reaches it with list_sources /
 * get_source_content / search_sources. So the send uploads first and talks
 * second. The student's own words become the source's description — that field
 * is literally "what should the AI take from this?", which is what they just
 * typed.
 *
 * Thesis-scoped by nature (a source belongs to a document), which is why the
 * caller must have resolved a thesis before getting here.
 */
async function uploadAttachmentAsSource(thesisId: string, att: Attachment, note: string): Promise<ThesisSource> {
  const base64 = await FileSystem.readAsStringAsync(att.uri, { encoding: FileSystem.EncodingType.Base64 });
  const src = await addSource(thesisId, {
    base64,
    filename: att.name,
    // No title: the server defaults it to the filename, which is what the
    // message's own "[Attached file: …]" marker names — so the entry the AI
    // finds in list_sources is recognisably the file the student just sent.
    description: note.trim().slice(0, 500) || undefined,
  });
  // Keep the Sources sheet honest without a refetch: it lists from this store.
  useSourceStore.getState().add(thesisId, src);
  return src;
}

// Composer auto-grow bounds (one line … ~6 lines, then it scrolls internally).
// Belt-and-suspenders so it grows whichever mechanism the New Architecture honors:
//   • minHeight/maxHeight in the style bound the input's INTRINSIC auto-sizing, and
//   • onContentSizeChange drives an explicit height when that event fires.
// The height stays UNSET until measured, so if onContentSizeChange never fires the
// intrinsic path still governs (we never pin the box to one line).
const INPUT_MIN_HEIGHT = 28;
const INPUT_MAX_HEIGHT = 120;

// The full thesis chat UI, reusable in two places: as the Chat TAB (variant
// "screen", with a Home button) and inside the floating chat-head OVERLAY
// (variant "overlay", with a Close button that collapses back to the bubble).
export function ThesisChat({ thesisId: initialThesisId, thesisTitle, variant = "screen", focused = true, onClose }: { thesisId: string | null; thesisTitle: string; variant?: "screen" | "overlay"; focused?: boolean; onClose?: () => void }) {
  // The thesis this conversation is about, which can CHANGE mid-session: an
  // unattached chat starts null and gains one when the student attaches it. Held
  // as state rather than read straight from the prop so that attach takes effect
  // on the very next turn without remounting the screen.
  const [thesisId, setThesisId] = useState<string | null>(initialThesisId);
  const colors = useThemeColors();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const [inputText, setInputText] = useState("");
  // Explicit height once onContentSizeChange measures it; undefined = let the
  // intrinsic (min/maxHeight-bounded) sizing govern. See INPUT_*_HEIGHT.
  const [inputHeight, setInputHeight] = useState<number | undefined>(undefined);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [viewerContent, setViewerContent] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  // True while a staged document is being read and stored as a thesis source.
  // It happens INSIDE the send, before the turn opens, so the composer has to
  // hold still for it: a second tap would upload the same file twice.
  const [uploadingSource, setUploadingSource] = useState(false);
  // Images picked / snapped / pasted but not yet sent. An array because a
  // student comparing two figures shouldn't have to send them one at a time.
  const [staged, setStaged] = useState<StagedImage[]>([]);
  // The attachment the reader tapped open, full screen. One viewer for the whole
  // list rather than one per bubble.
  const [viewerImage, setViewerImage] = useState<ChatImage | null>(null);
  // Room under the composer for whatever the phone puts there — a three-button
  // navigation bar, a gesture pill, or nothing — and none of it while the
  // keyboard is up. See hooks/useBottomInset.
  const composerInset = useBottomInset(8);
  const confirmInset = useBottomInset(12);
  // …plus, on Android, the keyboard's own height: edge-to-edge never resizes the
  // window for the IME, so the composer clears the keys by padding itself. The
  // list is the flexing sibling, so it shrinks by the same amount and the last
  // message stays reachable. iOS returns 0 — its KAV already shrank the region.
  const keyboardLift = useKeyboardLift();
  const pendingAsk = useChatStore((s) => s.pendingAsk);
  const pendingConfirm = useChatStore((s) => s.pendingConfirm);
  const setPendingAsk = useChatStore((s) => s.setPendingAsk);
  // This UI exists in several places at once: the chat SCREEN — which the stack
  // can hold more than one of, since every drawer row `replace`s the top screen
  // and a chat opened over another screen lands on top of the chat that's
  // already the app's root — and the floating chat-head OVERLAY. Only the one
  // the student is actually looking at is "active" and may drive the GLOBAL
  // sheets (ask/structure) or fetch suggestions; otherwise ask_user presents one
  // sheet per mounted copy, which is exactly the duplicated ask sheet. A screen
  // qualifies only while it holds navigation FOCUS, and yields to the overlay
  // while that's expanded.
  const chatHeadExpanded = useChatHead((s) => s.expanded);
  const active = variant === "overlay" ? chatHeadExpanded : focused && !chatHeadExpanded;
  // AI-generated quick-action chips from the recent conversation + RAG. Only the
  // visible instance fetches, and not while an ask sheet is open. No block
  // selection in plain chat, so it grounds on the conversation alone.
  // Read-aloud. Nothing STARTS it any more — the speaker button came off the
  // answer's action row along with copy, to make room for the three destinations
  // that replaced them (see components/chat/MessageActions). Only the stop
  // remains, wired into every place that takes the floor from a conversation
  // (thread switch, regenerate, retry), so re-adding the button is a one-line
  // change rather than a re-audit of where speech has to be cut off.
  const { stop: stopSpeaking } = useSpeakMessage(i18n.language);
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<RNTextInput>(null);
  // True while the list is within NEAR_BOTTOM of the end. Gates auto-scroll so
  // reading older messages isn't interrupted by streaming/new-message scrolls.
  // Starts true so the chat opens pinned to the newest message.
  const isNearBottomRef = useRef(true);
  // Whether the user has ever manually dragged the list. Until they do, the
  // stick-to-bottom state must NOT be changed by scroll events — the async,
  // multi-pass layout when the chat first opens fires scroll events at offset 0
  // (looks "far from bottom") that would otherwise disengage the pin and leave
  // the chat stranded mid-history. Only a real drag hands scroll control over.
  const userHasScrolledRef = useRef(false);
  // The conversation this thesis is currently in — resolved once below via
  // ensureThreadFor, not the thesis id itself. The message store, the AI turn
  // runners and the API calls all key off THIS, never `thesisId` (which only the
  // outline sync and the undo checkpoint need — see lib/ai-service.ts). Also
  // changed by handlePickThread when the student switches conversations from
  // the history panel.
  const [threadId, setThreadId] = useState<string | null>(null);
  // Full-screen conversation-history panel (components/chat/ChatHistoryPanel).
  // It owns its own list/search/loading state and only needs to know whether
  // it's open, so its own `visible` effect fetches the list — nothing to load here.
  const [historyOpen, setHistoryOpen] = useState(false);
  // The mode picker sheet (components/chat/ChatModeSheet).
  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  // What the student picked BEFORE this conversation exists. The store keys modes
  // by thread id, and a chat opened with ＋ (or by a first-time student) has no
  // thread until the first send — so a mode chosen in that window would have
  // nowhere to live and would be silently dropped from the turn that follows.
  // Only consulted while `threadId` is null; handleSend commits it to the real
  // thread the moment one exists.
  const [draftMode, setDraftMode] = useState<ChatMode>(DEFAULT_CHAT_MODE);
  // A PRIMITIVE out of the store — a selector returning a fresh object literal
  // (`{ mode: s.modes[id] }`) makes every render a new snapshot and throws
  // "Maximum update depth exceeded".
  const storedMode = useChatThreadsStore((s) => (threadId ? s.modes[threadId] : undefined));
  const chatMode: ChatMode = threadId ? storedMode ?? DEFAULT_CHAT_MODE : draftMode;
  // Picked in the sheet. Written to BOTH so it survives whichever of the two the
  // next send reads: the store when there is a thread, the draft until there is.
  const pickMode = (m: ChatMode) => {
    setDraftMode(m);
    if (threadId) useChatThreadsStore.getState().setMode(threadId, m);
  };
  // A ＋ that hasn't been typed into yet. The panel's ＋ creates nothing; it just
  // leaves this behind, and the first message turns it into a real thread. A ref
  // rather than state because nothing renders off it — and because
  // createThreadForSend must read the value the tap wrote, not one a render
  // hasn't flushed yet. `thesisId` is carried INSIDE it so the intent survives
  // even if the state setter below hasn't landed.
  //
  // It also outranks ensureThreadFor at send time: the student asked for a NEW
  // conversation about this thesis, and ensureThreadFor answers the opposite
  // question ("the one it's already in"), which would silently drop them back
  // into the thread they just chose to leave.
  const pendingNewThreadRef = useRef<{ thesisId: string | null } | null>(null);
  // AI-generated quick-action chips from the recent conversation + RAG. Only the
  // visible instance fetches, and not while an ask sheet is open. No block
  // selection in plain chat, so it grounds on the conversation alone. Declared
  // after `threadId` because it watches the thread's newest message to know when
  // to refresh.
  const { suggestions } = useComposerSuggestions(thesisId, { enabled: active && !pendingAsk, threadId });
  const messages = useChatStore((s) => s.getMessages(threadId ?? ""));
  // Infinite scroll: whether earlier messages remain and whether a page is loading.
  const hasMoreOlder = useChatStore((s) => s.getHasMoreOlder(threadId ?? ""));
  const loadingOlder = useChatStore((s) => s.getLoadingOlder(threadId ?? ""));
  const isGenerating = useChatStore((s) => s.isGenerating);
  // True while this thread is being caught up with a turn that finished while the
  // app was in the background (see ai-service's foreground resume). Not a turn —
  // the composer stays usable — but the chat is not idle either: the answer is on
  // its way, so the question must not be dressed up as one that went unanswered.
  // A primitive (a boolean off an id comparison), never the id itself.
  const recovering = useChatStore((s) => !!threadId && s.recoveringThreadId === threadId);
  const streamingId = useChatStore((s) => s.streamingId);
  // Plan mode. A primitive and a STORED array — never a fresh literal out of a
  // selector. Both feed every plan card in the list, so the FlatList has to be
  // told about them too (see extraData below) or a card would keep the state it
  // was rendered with.
  const runningPlanId = useChatStore((s) => s.runningPlanId);
  const donePlanIds = useChatStore((s) => s.donePlanIds);
  // The checklist state. `planSteps` is the STORED record (a new identity only
  // when a tick actually lands), and `planStepsRev` is the primitive the
  // FlatList needs — see extraData below.
  const planSteps = useChatStore((s) => s.planSteps);
  const planStepsRev = useChatStore((s) => s.planStepsRev);
  // This session watched the last turn edit THIS conversation's document. A
  // primitive off two comparisons, never the payload — see chat-store's
  // `docChangedThreadId` for why the thread half is load-bearing.
  const docMovedHere = useChatStore(
    (s) => !!threadId && !!thesisId && s.docChangedThreadId === threadId && !!s.docChanges[thesisId],
  );
  // Should the affordance under the last turn read CONTINUE rather than
  // REGENERATE? A job that stopped half-way has to be FINISHED: restarting it
  // deletes the plan card with every tick on it and re-applies edits that are
  // already in the student's .docx.
  //
  // Decided here rather than in the bubble because the evidence is spread across
  // the thread — the card is on the message that PROPOSED the plan and the ticks
  // are on the one that RAN it — and one row can see neither the other nor the
  // store's tick record.
  //
  // ⚠️ It answers "can the app tell?", not "did work land?". [[MODK_DOCCHANGES]]
  // is stripped before a message is persisted, so after a reload a turn that
  // rewrote four chapters is indistinguishable from one that said nothing. Those
  // cases still show Regenerate — and the server answers that regenerate with a
  // 409 the app turns into a continuation anyway (see ai-service). Memoized: this
  // walks the loaded window, and the screen re-renders on every keystroke.
  const canContinueLastTurn = useMemo(
    // Never while a turn is running: the chip is not shown then, and offering to
    // continue something still in flight is how two turns end up editing one
    // document.
    () => !isGenerating && lastTurnDidWork(messages, planSteps, { docChanged: docMovedHere }),
    [isGenerating, messages, planSteps, planStepsRev, docMovedHere],
  );
  const loadedRef = useRef(false);
  const rotation = useSharedValue(0);
  const micPulse = useSharedValue(1);
  // Voice-to-text for the composer. `supported` stays false until the native
  // module is linked, and the mic falls back to "coming soon" (see handleMic).
  const { supported, listening, start: startDictation, stop: stopDictation } = useVoiceDictation();
  // The text that was in the box when dictation began — the transcript is
  // appended to it, never over it.
  const dictationBaseRef = useRef("");
  // True while the initial history is being pulled from cache/server. Starts true
  // only when nothing is in memory yet — a thesis revisited this session already
  // has its messages and shouldn't flash a skeleton.
  // The skeleton is only honest when history is actually on its way. A brand-new
  // conversation — a first-time student with no thesis, or a chat just created
  // with ＋ — has nothing to load, and placeholder bubbles there strand them
  // staring at fake messages instead of typing. Starts false; only ever raised
  // for a thread that has genuinely had messages before (see threadHasHistory).
  const [loadingHistory, setLoadingHistory] = useState(false);
  // True until the opening resolve below knows WHICH conversation this screen is
  // showing — or that there is none to show. Seeded synchronously (never in an
  // effect) because a single frame of the welcome art before the resumed chat
  // lands is exactly the flash this exists to prevent. Distinct from
  // `loadingHistory`, which covers fetching a KNOWN thread's messages; the two
  // render the same skeleton, so the handoff between them is invisible.
  const [resolving, setResolving] = useState(() => hasConversationToResume(initialThesisId));

  // Resolve which conversation this thesis currently opens into — fired once
  // per mount, guarded by loadedRef so it never re-resolves a second thread out
  // from under the student. Switching conversations afterwards goes through
  // handlePickThread below, which sets `threadId` directly; it deliberately
  // does NOT touch loadedRef, so this effect can never fire again for it — the
  // effect below (keyed on threadId) is what does the actual message load for
  // BOTH paths, so it isn't repeated here.
  // The message counter, re-read whenever the student comes back to the chat.
  // On focus rather than on mount: they may have just paid on the plans screen,
  // and a stale "0 left" banner over the composer would still be blocking them.
  useFocusEffect(
    useCallback(() => {
      void useBillingStore.getState().refreshQuota();
    }, []),
  );

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const store = useChatThreadsStore.getState();
    // RESUME only — never create. With a thesis in hand, ask the server which
    // conversation it is currently in; without one, reopen whatever the student
    // last had open. If there is nothing to resume we leave threadId null and
    // show an empty chat they can type straight into: handleSend creates the
    // thread on the first message. Creating one here instead would leave an
    // empty conversation behind every time someone opened chat and walked away.
    const resolve = thesisId
      ? store.ensureThreadFor(thesisId)
      : store.currentThreadId
        ? Promise.resolve(store.currentThreadId)
        : Promise.resolve(null);
    void Promise.resolve(resolve)
      .then((id) => {
        if (!id) {
          // Nothing to resume — an empty chat, ready to type into. NOW the
          // welcome is the truth rather than a guess made before asking.
          setResolving(false);
          return;
        }
        // Batched into one commit with the flag below, so the skeleton hands
        // straight over to the history load without a frame of empty state
        // between them.
        setLoadingHistory(threadHasHistory(id));
        setThreadId(id);
        setResolving(false);
      })
      .catch(() => {
        setResolving(false);
        // Offline, or the server refused. Leave the student in an empty
        // conversation rather than an eternal skeleton — this is exactly how
        // the stuck placeholder bubbles happened: newThread() rejects, the
        // .then never runs, and nothing was left to clear the flag.
        setLoadingHistory(false);
        // A refusal here is usually a STALE currentThesisId: it outlives the
        // thesis it points at, so /threads/for-thesis 404s on a document this
        // account doesn't own. Clear it now so the composer offers to attach a
        // real one instead of silently retrying a dead id on every send.
        if (thesisId) {
          setThesisId(null);
          useThesisStore.getState().setCurrentThesis(null);
        }
      });
  }, []);

  // Load a thread's messages whenever the thread being displayed changes — the
  // initial resolve above, or a pick from the history panel. loadInitialMessages
  // itself is idempotent (it bails immediately once the thread already has
  // messages in memory this session — see lib/ai-service.ts), so switching back
  // to a thread already open this session is a no-op here: no refetch, no
  // re-flash of the skeleton. Picking the thread that's ALREADY current doesn't
  // even reach this effect — setThreadId to an unchanged value is a React no-op.
  useEffect(() => {
    if (!threadId) return;
    // Only clears — never raises. Whoever chose this thread already decided
    // whether a skeleton is warranted, because only they know if it is a
    // conversation being resumed or one created a moment ago.
    void loadInitialMessages(threadId).finally(() => setLoadingHistory(false));
  }, [threadId]);

  // Switch the conversation this screen is showing. The AI turn runners in
  // lib/ai-service.ts close over the threadId that was active when a turn
  // STARTED, not a live read of this state, so a turn already streaming keeps
  // writing into the thread it belongs to — never into whichever thread this
  // screen switches to. Read-aloud is stopped the same way regenerate/retry
  // stop it: a different conversation takes the floor. The scroll-pin flags are
  // re-armed exactly as they are on a thesis switch below (same FlatList
  // instance, an entirely different message array) — otherwise a thread opened
  // while scrolled up in the previous one would land mid-scroll instead of at
  // its latest message.
  const handlePickThread = useCallback(
    (picked: string) => {
      stopSpeaking();
      isNearBottomRef.current = true;
      userHasScrolledRef.current = false;
      setShowScrollDown(false);
      // Opening an existing conversation abandons an untyped ＋ — otherwise the
      // next send would fork a new thread instead of continuing this one.
      pendingNewThreadRef.current = null;
      // Same rule as the initial resolve: a conversation with prior messages is
      // worth waiting for, one just created with ＋ is not.
      setLoadingHistory(threadHasHistory(picked));
      setThreadId(picked);
      useChatThreadsStore.getState().setCurrent(picked);
      setHistoryOpen(false);
      // A picked thread carries its OWN attachment, which may differ from the one
      // this screen was showing — reading it here is what makes switching from an
      // attached conversation to an unattached one (or back) actually change what
      // the composer offers and what the next turn is scoped to.
      const row = useChatThreadsStore.getState().threads.find((th) => th.id === picked);
      if (row) {
        setThesisId(row.thesisId);
        // The selected thesis FOLLOWS the conversation, in both directions.
        // Opening a thesis conversation selects it app-wide so the Writer, the
        // outline and the drawer move with you; opening a free chat clears the
        // selection, because a conversation with no document should not leave
        // the rest of the app claiming one is open — the header read "m moire
        // isp" while the composer underneath said "No thesis attached".
        useThesisStore.getState().setCurrentThesis(row.thesisId);
      }
    },
    [stopSpeaking]
  );

  // Which thesis this screen is currently SHOWING, as far as the outside world
  // is concerned. The effect below is the only writer.
  const shownThesisRef = useRef(initialThesisId);

  // A thesis switched from OUTSIDE this screen — the drawer's thesis list now
  // routes into the chat rather than the Writer, and this screen is the bottom of
  // the stack, so it is already mounted and `dismissTo` pops back down to it
  // rather than building a new one.
  //
  // Without this the opening resolve above would never run again (loadedRef is a
  // one-shot, deliberately) and `thesisId` is seeded from the prop only on the
  // first render — so the header would show the newly chosen thesis while the
  // transcript underneath it stayed the PREVIOUS thesis's conversation, and the
  // next question would be sent to that thread. Right title, wrong document.
  useEffect(() => {
    if (initialThesisId === shownThesisRef.current) return;
    shownThesisRef.current = initialThesisId;
    // Changes that originated HERE — picking a thread, attaching a thesis, the
    // assistant creating one mid-turn — already moved this screen and then wrote
    // the selection outwards; the prop is only echoing back. Those must not
    // re-resolve, or picking a thread would immediately be overridden by
    // ensureThreadFor answering with a different one.
    if (initialThesisId === thesisId) return;

    stopSpeaking();
    isNearBottomRef.current = true;
    userHasScrolledRef.current = false;
    setShowScrollDown(false);
    // An untyped ＋ belongs to the conversation being left behind.
    pendingNewThreadRef.current = null;
    setThesisId(initialThesisId);
    setThreadId(null);

    if (!initialThesisId) {
      // Deselected rather than switched — a blank chat, nothing to fetch.
      setResolving(false);
      setLoadingHistory(false);
      return;
    }

    // Same question the opening resolve asks, and the same rule about the
    // skeleton: wait behind it, because a thesis being reopened almost always has
    // a conversation on the server to pull down.
    setResolving(true);
    let alive = true;
    void useChatThreadsStore
      .getState()
      .ensureThreadFor(initialThesisId)
      .then((id) => {
        // Two switches in quick succession: the first must never land on top of
        // the second's conversation.
        if (!alive) return;
        setLoadingHistory(threadHasHistory(id));
        setThreadId(id);
        useChatThreadsStore.getState().setCurrent(id);
        setResolving(false);
      })
      .catch(() => {
        if (!alive) return;
        // Offline, or a thesis this account can't open. Leave them in an empty
        // conversation rather than an eternal skeleton — same reasoning as the
        // opening resolve's catch.
        setResolving(false);
        setLoadingHistory(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialThesisId]);

  // ＋ from the history panel. Nothing is created here and nothing is created
  // server-side: the screen simply empties out into a blank conversation the
  // student can type into, and handleSend makes the thread real on the first
  // message. That is the whole fix for the history filling up with untitled
  // empty conversations — a ＋ they never used now costs nothing and leaves no
  // trace. Scroll pins and read-aloud are reset exactly as on a thread switch.
  const handleNewThread = useCallback(
    (attachTo: string | null) => {
      stopSpeaking();
      isNearBottomRef.current = true;
      userHasScrolledRef.current = false;
      setShowScrollDown(false);
      pendingNewThreadRef.current = { thesisId: attachTo };
      setLoadingHistory(false); // nothing to fetch — a blank chat, not a resume
      setThreadId(null);
      setHistoryOpen(false);
      setThesisId(attachTo);
      // The selected thesis follows the conversation in both directions, same as
      // handlePickThread — a blank chat about nothing must not leave the drawer
      // and the Writer still claiming a document is open.
      useThesisStore.getState().setCurrentThesis(attachTo);
      // No thread is current until one exists. Leaving the previous id here would
      // point every other surface (the pill, the dock) at a conversation this
      // screen has already left.
      useChatThreadsStore.getState().setCurrent(null);
    },
    [stopSpeaking]
  );

  // A conversation the DRAWER asked for — its free-chat band opens a thread
  // directly, and nothing about that thread's thesis need have changed (a free
  // chat has none, and neither may the one on screen), so the thesis-switch
  // effect above cannot see it. An explicit intent is the only honest signal.
  //
  // Gated on `active`: several chat screens can be mounted at once (the stack's
  // own, the floating overlay), they all watch this one store field, and exactly
  // one of them has the floor. Whoever consumes it clears it, so the others find
  // nothing left to do.
  const pendingOpenThreadId = useChatThreadsStore((s) => s.pendingOpenThreadId);
  useEffect(() => {
    if (!pendingOpenThreadId || !active) return;
    useChatThreadsStore.getState().consumeOpenThread();
    handlePickThread(pendingOpenThreadId);
  }, [pendingOpenThreadId, active, handlePickThread]);

  // Attach a thesis to this conversation. The server records WHEN, and tells the
  // model on the next turn that the earlier exchanges happened without document
  // access — so it can't describe them as though it had been reading along.
  const handleAttachThesis = useCallback(
    (picked: string) => {
      // Optimistic: the composer's doc affordances should appear on the tap, not
      // after a round-trip. A failure rolls it back rather than leaving the
      // student a chat that looks attached and behaves otherwise.
      const previous = useThesisStore.getState().currentThesisId;
      setThesisId(picked);
      // The selection follows the conversation, exactly as handlePickThread and
      // the mid-turn adoption below do it.
      //
      // This line was missing, and the comment below has been claiming it was
      // here. Everything outside this screen reads the STORE, not the local
      // state: the answer's "Writer" chip (MessageActions), the drawer, the
      // Writer screen itself. So attaching a thesis lit up the composer and
      // nothing else — the one control that opens the document you just
      // attached stayed hidden.
      useThesisStore.getState().setCurrentThesis(picked);
      if (!threadId) {
        // A blank ＋ conversation — there is no row to PATCH yet. Record the
        // choice on the pending intent so the thread the first message creates
        // is born attached, rather than silently ignoring the pick (which is
        // what a bare `if (!threadId) return` did once ＋ stopped creating).
        if (pendingNewThreadRef.current) pendingNewThreadRef.current.thesisId = picked;
        return;
      }
      void patchThread(threadId, { thesisId: picked })
        .then((row) => useChatThreadsStore.getState().applyThread(row))
        .catch(() => {
          setThesisId(null);
          // Put the app-wide selection back where it was, not to null: this chat
          // may have been opened from a thesis that is still the one open in the
          // Writer, and a failed attach must not close a document it never touched.
          useThesisStore.getState().setCurrentThesis(previous);
          Alert.alert(t("common.error"), t("chat.threads.attachFailed"));
        });
    },
    [threadId, t]
  );

  // A thesis can be born mid-conversation: the assistant creates one
  // (create_thesis) and the server attaches THIS conversation to it. Nothing in
  // the stream says so — lib/ai-service.ts re-reads the thread row once the turn
  // ends — so without adopting it here the screen goes on believing it has no
  // document: the composer keeps offering "attach", the header stays untitled,
  // and the next turn is sent unattached, which is offered no document tools.
  //
  // Only ever FILLS an empty attachment. A conversation already about a thesis
  // is never moved by a background refresh; switching is the student's to do.
  const attachedThesisId = useChatThreadsStore((s) =>
    threadId ? s.threads.find((th) => th.id === threadId)?.thesisId ?? null : null
  );
  useEffect(() => {
    if (thesisId || !attachedThesisId) return;
    setThesisId(attachedThesisId);
    // The selection follows the conversation, the same way handlePickThread and
    // handleAttachThesis move it — the Writer and the drawer come along.
    useThesisStore.getState().setCurrentThesis(attachedThesisId);
    // The picker may be open on top of this — it is mounted only while nothing
    // is attached, so it is about to unmount. Clear the store flag with it, or
    // the name stays "open" with no sheet behind it and the next opening is a
    // no-op (same reason the pick handler closes it explicitly).
    useBottomSheet.getState().closeSheet("thesis-attach");
  }, [attachedThesisId, thesisId]);

  // Bridge the model's pending question (data, in the chat store) to the global
  // sheet store so the "ask" sheet's open state lives alongside every other sheet.
  useEffect(() => {
    if (!active) return;
    if (pendingAsk) useBottomSheet.getState().openSheet("ask");
    else useBottomSheet.getState().closeSheet("ask");
  }, [pendingAsk, active]);

  // Focusing the input shrinks the list (keyboard/KeyboardAvoidingView) without
  // changing content size, so onContentSizeChange won't fire — keep the latest
  // message visible on keyboard-open, the way messaging apps do. Only while the
  // user is already at the bottom, so reading history isn't disrupted.
  useEffect(() => {
    const evt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const sub = Keyboard.addListener(evt, () => {
      if (isNearBottomRef.current) flatListRef.current?.scrollToEnd({ animated: true });
    });
    return () => sub.remove();
  }, []);

  // A new thesis is a fresh conversation: re-arm the open-at-bottom behaviour so
  // it isn't left in the previous chat's "scrolled up" state (this component is
  // reused across theses, not remounted).
  useEffect(() => {
    isNearBottomRef.current = true;
    userHasScrolledRef.current = false;
    setShowScrollDown(false);
  }, [thesisId]);

  // Which bubble (if any) the running turn is streaming into. Derived from the
  // list rather than `streamingId` so it survives a turn whose stream id was
  // already cleared, and so exactly ONE surface owns the "still working" note:
  // the bubble when there is one, the footer indicator when there isn't yet.
  const lastMessage = messages[messages.length - 1];
  const liveTurnId = isGenerating && lastMessage?.role === "assistant" ? lastMessage.id : null;

  const NEAR_BOTTOM = 160;
  function handleScroll(e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const nearBottom = distanceFromBottom < NEAR_BOTTOM;
    // Only honour position once the user has taken control with a drag. Before
    // that, the pin stays engaged through the opening layout passes (see
    // userHasScrolledRef) so the chat reliably lands on the newest message.
    if (userHasScrolledRef.current) isNearBottomRef.current = nearBottom;
    setShowScrollDown(!isNearBottomRef.current); // no-op re-render bailout when unchanged
  }

  function scrollToBottom() {
    isNearBottomRef.current = true;
    setShowScrollDown(false);
    flatListRef.current?.scrollToEnd({ animated: true });
  }

  // Open the thesis's live .docx in the workspace (the document IS the export).
  // (Stable identity so the memoized Bubble doesn't re-render on every keystroke.)
  // Tapping an export downloads it and hands it to the OS — Save to Files, open
  // in Word, share anywhere. It used to push the workspace instead, which showed
  // the document the student was already looking at rather than giving them the
  // file they asked to export.
  const handleDownloadFile = useCallback(
    async (file: FilePayload) => {
      try {
        await downloadExport(file);
      } catch {
        // Almost always an expired link — exports are signed for one hour.
        Alert.alert(t("common.error"), t("preview.downloadFailed"));
      }
    },
    [t]
  );

  // Regenerate the most recent assistant reply (drops it and re-runs the last
  // user turn). Stable identity so the memoized Bubble doesn't re-render on every
  // keystroke; snaps to the bottom so the fresh answer streams into view.
  const handleRegenerate = useCallback(() => {
    if (!threadId) return;
    // The answer being read aloud is the one about to be replaced.
    stopSpeaking();
    isNearBottomRef.current = true;
    setShowScrollDown(false);
    void regenerateLastResponse(threadId, thesisId);
  }, [threadId, thesisId, stopSpeaking]);

  // Finish a turn that stopped part-way, instead of running it again. Same
  // plumbing as Regenerate above — stop the reader, snap to the bottom — and
  // deliberately NOT the same request: /api/chat/continue-turn deletes nothing,
  // so the plan card and its ticks stay on screen while the rest of the work
  // streams in underneath them.
  const handleContinue = useCallback(() => {
    if (!threadId) return;
    stopSpeaking();
    isNearBottomRef.current = true;
    setShowScrollDown(false);
    void continueInterruptedTurn(threadId, thesisId);
  }, [threadId, thesisId, stopSpeaking]);

  // The AI referred to a place in the thesis and linked it (`modk://b/N`) — take
  // the student there. The index inside the link is as-written, which is why it
  // is re-resolved against the CURRENT document before we jump: the student may
  // have edited since, and landing on the wrong paragraph is worse than the link
  // not existing.
  //
  // Two destinations, decided by what this chat is showing OVER. The chat panel
  // is mounted at the app root and can float above any screen, so `variant`
  // doesn't answer it — the workspace's own focus flag does. With the writer
  // right behind us the document is already open: scroll it and get out of the
  // way. Anywhere else it's a navigation, and the workspace picks the block up
  // from the route param on arrival.
  const openThesisBlock = useCallback((link: BlockLink, label: string) => {
    if (!thesisId) return;
    const doc = useThesisDocStore.getState().byId[thesisId];
    const index = resolveBlockIndex(doc?.available ? doc.blocks : undefined, link, label);
    const ws = useWorkspaceStore.getState();
    useThesisStore.getState().setCurrentThesis(thesisId);
    // Pre-select it so the block is already the composer's target when the
    // writer appears — the same thing the details outline does.
    ws.selectBlock(index, label || null);
    const inWorkspace = ws.screenFocused && ws.thesisId === thesisId;
    onClose?.(); // overlay: drop the panel so the document is visible
    if (inWorkspace) {
      ws.requestScrollToBlock(index);
      return;
    }
    router.push({
      pathname: "/(app)/thesis-workspace",
      params: { thesisId, blockIndex: String(index) },
    });
  }, [thesisId, onClose, router]);

  // Run a plan the assistant proposed. The streamed work lands in this thread as
  // an ordinary turn, so the chat snaps to the bottom the way a send does.
  // Double-run protection is NOT here: it belongs in the store, where every card
  // on screen shares one slot — see executePlan / beginPlanRun. Running a plan
  // twice applies every edit in it twice.
  const handleExecutePlan = useCallback((planId: string) => {
    if (!threadId) return;
    stopSpeaking();
    isNearBottomRef.current = true;
    setShowScrollDown(false);
    void executePlan(threadId, thesisId, planId);
  }, [threadId, thesisId, stopSpeaking]);

  // "Ask for changes" is not a mode — the student answering in their own words IS
  // the revision. So it just hands them the composer.
  const handleAskPlanChanges = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Retry a send that never landed. Re-runs the turn for the EXISTING user row —
  // no second bubble, and no server-side regenerate (that path deletes the reply
  // it means to replace).
  const handleRetryMessage = useCallback((messageId: string) => {
    if (!threadId) return;
    stopSpeaking();
    isNearBottomRef.current = true;
    setShowScrollDown(false);
    void retryFailedMessage(threadId, thesisId, messageId);
  }, [threadId, thesisId, stopSpeaking]);

  // Builds the outgoing text.
  //
  // Images no longer appear here: their bytes travel with the message and the
  // server records them on the row, so a `[Attached image]` marker would be a
  // second, less accurate account of the same thing. An UNCAPTIONED image still
  // needs an instruction, though — the model is being handed a picture and no
  // question — so it gets the localised default.
  //
  // A document still gets a marker, but it now names something REAL: the file
  // was stored as one of this thesis's source materials just before this ran,
  // under this exact title, so the AI finds it by calling list_sources and reads
  // it with get_source_content.
  function composeMessage(text: string, source: ThesisSource | null, imageCount: number): string {
    if (source) {
      const prompt = text || t("chat.analyzeFile", { defaultValue: "Please analyze this document." });
      // A type the server can't read yet (PDF today) is stored, but its text is
      // empty. Say so in the message instead of letting the AI find an empty
      // source mid-turn and improvise — told plainly, it can explain the limit
      // to the student in their own language.
      const note = source.status === "unextracted"
        ? " — stored, but its text could not be extracted (unsupported file type)"
        : "";
      return `[Attached file: ${source.title}${note}] ${prompt}`;
    }
    if (imageCount > 0 && !text) {
      return t("chat.describeImage", { defaultValue: "Please describe what you see and how it relates to my thesis." });
    }
    return text;
  }

  async function handleSend() {
    // `uploadingSource` holds the composer still while a document is on its way
    // to the sources: a second tap would store the same file twice.
    if (isGenerating || uploadingSource) return;
    const text = inputText.trim();
    // Send when there's text, an attachment, or both — but never an empty turn.
    if (!text && !attachment && staged.length === 0) return;
    // Typing IS starting a conversation. If there is no thread yet — a first-time
    // student with no thesis, or one who opened chat and never touched ＋ — make
    // one now rather than swallowing the send. Done here and not on mount so
    // merely opening the chat and walking away doesn't litter the history panel
    // with empty conversations.
    const resolved = threadId ? { id: threadId, thesisId } : await createThreadForSend();
    if (!resolved) {
      // Offline, or the server refused. Say so instead of quietly eating the
      // message — the text is still in the box at this point.
      Alert.alert(t("common.error"), t("thesis.genericError"));
      return;
    }
    // Not the `thesisId` state: resolving the thread can DROP a stale one (see
    // createThreadForSend), and that setState isn't visible to this closure.
    // The upload below would otherwise be aimed at a thesis that isn't there.
    const { id: tid, thesisId: sendThesisId } = resolved;
    // The thread may have only just come into existence (createThreadForSend), so
    // whatever was picked while there was none to key it on gets written to it now
    // — before the turn that carries it opens.
    useChatThreadsStore.getState().setMode(tid, chatMode);

    // A staged document goes to the thesis's source materials before the turn
    // opens — that is the only route by which the AI can read it. The composer
    // keeps everything until the upload lands, so a failure leaves the student
    // exactly where they were rather than sending a message about a file that
    // never arrived.
    let source: ThesisSource | null = null;
    if (attachment) {
      if (!sendThesisId) return void promptAttachThesis();
      if ((attachment.size ?? 0) > MAX_SOURCE_BYTES) {
        Alert.alert(
          t("sources.title", { defaultValue: "Sources" }),
          t("sources.tooLarge", { defaultValue: "That file is too large (max 10 MB)." }),
        );
        return;
      }
      setUploadingSource(true);
      try {
        source = await uploadAttachmentAsSource(sendThesisId, attachment, text);
      } catch (err) {
        Alert.alert(
          t("sources.title", { defaultValue: "Sources" }),
          err instanceof Error && err.message ? err.message : t("sources.uploadFailed", { defaultValue: "Couldn't upload that file." }),
        );
        return;
      } finally {
        setUploadingSource(false);
      }
    }
    const message = composeMessage(text, source, staged.length);
    const outgoing = staged;
    // A new turn takes the floor — don't keep reading the previous answer over it.
    stopSpeaking();
    // …and stop LISTENING. A recognizer left running past the send delivers its
    // final transcript afterwards, and the handler appends it to the text that was
    // in the box when dictation started — which would refill the composer with the
    // message that just went out.
    stopDictation();
    setInputText("");
    // Also clear the native buffer: a controlled value="" set in the same tick as
    // the editable flip / keyboard dismiss can be dropped on Fabric, leaving the
    // sent text stuck in the field.
    inputRef.current?.clear();
    setInputHeight(undefined); // collapse back to one line after sending
    setAttachment(null);
    setStaged([]);
    Keyboard.dismiss();
    // Sending your own message always jumps to the latest, even if scrolled up.
    isNearBottomRef.current = true;
    setShowScrollDown(false);
    await sendMessageToAI(tid, sendThesisId, message, { images: outgoing.length ? outgoing : undefined, mode: chatMode });
  }

  // A document can only be attached to a thesis — a source belongs to a
  // document — so an unattached conversation is offered the way out rather than
  // just refused. Same sheet the "unattached" row above the composer opens.
  function promptAttachThesis() {
    Alert.alert(
      t("chat.attachNeedsThesisTitle", { defaultValue: "No thesis attached" }),
      t("chat.attachNeedsThesis", { defaultValue: "Reference files are saved to a thesis. Attach this conversation to one first." }),
      [
        { text: t("common.cancel"), style: "cancel" },
        { text: t("chat.threads.attach"), onPress: () => useBottomSheet.getState().openSheet("thesis-attach") },
      ],
    );
  }

  // Create the conversation this send belongs to, on demand. Returns the thread
  // AND the thesis it ended up on — which is not always the one we started with,
  // since a stale thesis is dropped here. Null when the thread can't be created
  // (offline, server refused) so the caller can tell the student rather than
  // dropping their message on the floor.
  async function createThreadForSend(): Promise<{ id: string; thesisId: string | null } | null> {
    const store = useChatThreadsStore.getState();
    const adopt = (id: string, onThesis: string | null) => {
      pendingNewThreadRef.current = null; // consumed — this send owns a real thread now
      setThreadId(id);
      store.setCurrent(id);
      return { id, thesisId: onThesis };
    };

    // The student asked for a NEW conversation and is only now typing into it.
    // Always create — ensureThreadFor would hand back the thread this thesis is
    // ALREADY in, which is the one they just chose to leave. Kept on failure so
    // a retry after the network comes back still opens the thread they wanted.
    const pending = pendingNewThreadRef.current;
    if (pending) {
      try {
        return adopt(await store.newThread(pending.thesisId), pending.thesisId);
      } catch {
        return null; // offline / server down — the caller says so
      }
    }

    if (thesisId) {
      try {
        return adopt(await store.ensureThreadFor(thesisId), thesisId);
      } catch {
        // The thesis is gone, or was never this account's. currentThesisId
        // outlives the thesis it points at — a deletion, or signing in as
        // someone else — and the server rightly refuses to open a conversation
        // on a document the student doesn't own.
        //
        // That must not dead-end them. Drop the stale attachment and fall
        // through to the free conversation they were trying to start; the
        // composer then offers to attach a real thesis.
        setThesisId(null);
        useThesisStore.getState().setCurrentThesis(null);
      }
    }

    try {
      return adopt(await store.newThread(null), null);
    } catch {
      return null; // genuinely offline / server down — the caller says so
    }
  }

  // Add newly staged images, never past the cap. Say so when the cap is what
  // stopped them, rather than silently dropping the ones that didn't fit.
  // The alert stays OUT of the updater — a state updater has to be pure, or
  // React's double-invoke fires the dialog twice.
  function stageImages(picked: StagedImage[]) {
    if (!picked.length) return;
    const room = MAX_CHAT_IMAGES - staged.length;
    if (room <= 0) return void alertFull();
    if (picked.length > room) alertFull();
    setStaged((prev) => [...prev, ...picked.slice(0, Math.max(0, MAX_CHAT_IMAGES - prev.length))]);
  }

  function toggleTools() {
    const next = !toolsExpanded;
    setToolsExpanded(next);
    rotation.value = withSpring(next ? 45 : 0, { damping: 12, stiffness: 200 });
  }

  // ——— Dictation ———
  // Speaking a question is how a student writes a long Arabic prompt on a phone,
  // and the workspace composer has had this for a while (ComposerInput); chat is
  // where it is actually wanted. The transcript APPENDS to whatever was in the
  // box when dictation began, so it never eats text they had already typed.
  //
  // `supported` is false until a native rebuild links expo-speech-recognition —
  // the mic then falls back to the same "coming soon" the workspace shows,
  // rather than looking broken.
  async function handleMic() {
    if (listening) return void stopDictation();
    if (!supported) return void Alert.alert(t("composer.voiceComingSoon"));
    dictationBaseRef.current = inputText;
    const ok = await startDictation((transcript) => {
      const base = dictationBaseRef.current;
      setInputText(base ? `${base} ${transcript}` : transcript);
    });
    if (!ok) Alert.alert(t("composer.micDenied", { defaultValue: "Microphone/speech permission is needed to dictate." }));
  }

  async function handleToolPress(tool: string) {
    setToolsExpanded(false);
    rotation.value = withTiming(0, { duration: 200 });
    switch (tool) {
      case "file":
        // Refused BEFORE the picker rather than after: a file staged on an
        // unattached conversation has nowhere to be stored, and finding that
        // out at send time means having chosen it for nothing.
        if (!thesisId) return promptAttachThesis();
        try {
          const result = await DocumentPicker.getDocumentAsync({
            type: SOURCE_MIME_TYPES,
            copyToCacheDirectory: true,
          });
          if (!result.canceled && result.assets?.[0]) {
            const file = result.assets[0];
            // Stage it in the composer; the send stores it as a source (and only
            // then does the message that talks about it go out).
            setAttachment({ type: "file", uri: file.uri, name: file.name, size: file.size ?? undefined });
          }
        } catch {}
        break;
      // The three image routes all end the same way: normalised bytes staged in
      // the composer, sent with the next message rather than on their own.
      // Checking the cap BEFORE opening a picker (or a clipboard prompt) is the
      // difference between "you can attach up to four" and a dialog that seems
      // to do nothing.
      case "image": {
        const room = MAX_CHAT_IMAGES - staged.length;
        if (room <= 0) return void alertFull();
        stageImages(await pickChatImages(room));
        break;
      }
      case "camera": {
        if (staged.length >= MAX_CHAT_IMAGES) return void alertFull();
        const shot = await captureChatImage();
        if (shot) stageImages([shot]);
        break;
      }
      case "paste": {
        if (staged.length >= MAX_CHAT_IMAGES) return void alertFull();
        const pasted = await pasteChatImage();
        if (pasted) stageImages([pasted]);
        break;
      }
    }
  }

  function alertFull() {
    Alert.alert(t("chat.maxImages", { defaultValue: `You can attach up to ${MAX_CHAT_IMAGES} images.`, count: MAX_CHAT_IMAGES }));
  }

  const plusStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  // Pulse the mic while it is listening, so it reads as a live recording
  // indicator rather than a button stuck in its pressed state.
  useEffect(() => {
    if (listening) {
      micPulse.value = withRepeat(withTiming(0.4, { duration: 700 }), -1, true);
    } else {
      cancelAnimation(micPulse);
      micPulse.value = 1;
    }
  }, [listening, micPulse]);
  const micStyle = useAnimatedStyle(() => ({ opacity: micPulse.value }));

  const hasText = inputText.trim().length > 0;
  // The send button appears whenever there's something to send — text or a
  // staged attachment (so an image can be sent with no caption).
  const canSend = hasText || attachment !== null || staged.length > 0;

  const tools = [
    { key: "file", icon: Paperclip, label: t("chat.toolAttach", { defaultValue: "Attach" }), color: colors.semanticWarning },
    { key: "image", icon: ImageIcon, label: t("chat.toolPhoto", { defaultValue: "Photo" }), color: "#9959FF" },
    { key: "camera", icon: Camera, label: t("chat.toolCamera", { defaultValue: "Camera" }), color: "#0EA5E9" },
    { key: "paste", icon: ClipboardPaste, label: t("chat.toolPaste", { defaultValue: "Paste" }), color: "#10B981" },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* The bar shares the page's own background — no card, no border. The
          transcript now runs from under the title straight down to the composer
          as one continuous sheet, which is the point of taking the bubbles off
          the assistant's answers. */}
      <SafeAreaView edges={["top"]} style={{ backgroundColor: colors.bgPrimary }}>
        <View style={styles.topBar}>
          {variant === "overlay" ? (
            <Pressable onPress={onClose} hitSlop={8} style={{ padding: 4 }} accessibilityRole="button" accessibilityLabel={t("common.close", { defaultValue: "Close" })}>
              <X size={22} color={colors.textPrimary} strokeWidth={1.8} />
            </Pressable>
          ) : (
            <DrawerMenuButton />
          )}
          {/* The thesis this conversation is about, or the app's name when it is
              about no thesis at all — an empty header bar reads as a bug. The
              app's name also covers the launch gap: the remembered thesis ID is
              restored instantly but its TITLE only arrives with the theses list
              over the network, and until then `thesisTitle` is "" — which is how
              a blank bar got on screen despite the rule above. */}
          <Text style={[styles.topTitle, { color: colors.textPrimary }]} numberOfLines={1}>
            {(thesisId ? thesisTitle : "") || t("auth.appName")}
          </Text>
          <View style={styles.topActions}>
            {/* Start a fresh conversation without going through the history
                panel first — the same intent its ＋ carries, one tap closer.
                Always UNATTACHED, whatever is open: ✎ is the blank page, and a
                blank page that silently inherits the current thesis is not one.
                The panel's ＋ is where "a new chat about THIS thesis" lives (it
                asks), and an unattached chat carries its own offer to attach —
                the row above the composer, one tap, no round-trip lost. */}
            <Pressable
              onPress={() => handleNewThread(null)}
              hitSlop={8}
              style={{ padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel={t("chat.threads.new")}
            >
              <SquarePen size={21} color={colors.textPrimary} strokeWidth={1.8} />
            </Pressable>
            <Pressable
              onPress={() => setHistoryOpen(true)}
              hitSlop={8}
              style={{ padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel={t("chat.threads.title")}
            >
              <History size={22} color={colors.textPrimary} strokeWidth={1.8} />
            </Pressable>
          </View>
        </View>
      </SafeAreaView>

      {/* iOS only. behavior="height" DID clear the keyboard on Android, but it
          measures the gap as `frame.bottom - keyboard.screenY`, and under
          edge-to-edge the frame spans the navigation bar while the keyboard
          metrics don't — so it kept a navigation bar's height reserved with the
          keyboard CLOSED, which is the gap that used to sit under the composer.
          Android clears the keys with `keyboardLift` instead (see below); the
          two must never both be on or they double-count. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={{ flex: 1 }}>
          {(resolving || loadingHistory) && messages.length === 0 ? (
            // Either we don't know which conversation this is yet, or we know and
            // its messages are on the way. Both are "loading", and both must look
            // the same — the student should never see the empty state flash past
            // on the way to a chat they already had. Gated on there being no
            // messages so a send made during the resolve isn't hidden behind it.
            <ChatSkeleton />
          ) : messages.length === 0 ? (
            // Nothing said yet — and nothing loading, and nothing left to resolve.
            // Say what this can do for them rather than showing an empty void
            // above the composer.
            <ChatWelcome />
          ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={({ item, index }) => (
              <>
                {/* The stamp belongs to the message under it, so it rides inside
                    the same row rather than as its own list entry — nothing else
                    in here (keyExtractor, onStartReached, the index maths above)
                    has to learn about a second kind of item. */}
                {shouldShowTime(messages[index - 1]?.createdAt, item.createdAt) && <TimeDivider iso={item.createdAt} />}
                <MessageBubble
                  item={item}
                  colors={colors}
                  isStreaming={item.id === streamingId}
                  isLiveTurn={item.id === liveTurnId}
                  isLastAssistant={index === messages.length - 1 && item.role === "assistant" && messages.length > 1}
                  isUnanswered={index === messages.length - 1 && item.role === "user" && !isGenerating && !recovering}
                  onExpand={setViewerContent}
                  onPreviewFile={handleDownloadFile}
                  onRegenerate={handleRegenerate}
                  canContinue={canContinueLastTurn}
                  onContinue={handleContinue}
                  onRetryMessage={handleRetryMessage}
                  onViewImage={setViewerImage}
                  onBlockPress={openThesisBlock}
                  onExecutePlan={handleExecutePlan}
                  onAskPlanChanges={handleAskPlanChanges}
                  runningPlanId={runningPlanId}
                  donePlanIds={donePlanIds}
                  planSteps={planSteps}
                />
              </>
            )}
            keyExtractor={(item) => item.id}
            // The live-turn flag and the plan-run state live outside `data`, so
            // tell the list about them — otherwise the last bubble keeps its
            // working note after the turn ends, and a plan card keeps its
            // Execute button spinning after the run finishes. One STRING, not an
            // object: a fresh literal here re-renders every row on every render.
            extraData={`${liveTurnId ?? ""}|${runningPlanId ?? ""}|${donePlanIds.length}|${planStepsRev}|${recovering ? 1 : 0}|${canContinueLastTurn ? 1 : 0}`}
            contentContainerStyle={styles.messageList}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onScroll={handleScroll}
            scrollEventThrottle={32}
            // Fetch the previous page from the server when the reader reaches the
            // top. Gated on a real drag so the opening auto-scroll to the bottom
            // (which passes through offset 0) doesn't fire a spurious load;
            // loadOlderMessages itself guards against double-loads and end-of-history.
            onStartReached={() => {
              if (!userHasScrolledRef.current || !threadId) return;
              void loadOlderMessages(threadId);
            }}
            onStartReachedThreshold={0.5}
            // Keep the on-screen content anchored when older messages are prepended,
            // so paging in earlier history doesn't jump the reader (New Architecture).
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            // Spinner at the top while an older page is loading or more remain.
            ListHeaderComponent={
              loadingOlder || hasMoreOlder ? (
                <View style={styles.loadOlder}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                </View>
              ) : null
            }
            // A real finger-drag is what hands scroll control to the user; from
            // here on, position decides whether we stick to the bottom.
            onScrollBeginDrag={() => { userHasScrolledRef.current = true; }}
            onContentSizeChange={() => {
              // The bottom is the anchor (Messenger/WhatsApp style): re-pin to the
              // newest message on every content-size change while the user is at
              // the bottom. This is what makes the chat reliably OPEN at the end —
              // bubbles with markdown/images lay out over several async passes, and
              // each pass keeps us pinned instead of settling above the last
              // message. It also covers incoming messages and streaming tokens.
              // Suppressed once the user scrolls up to read history; re-armed when
              // they return to the bottom (handleScroll / the scroll-to-latest FAB).
              if (isNearBottomRef.current) flatListRef.current?.scrollToEnd({ animated: false });
            }}
            ListFooterComponent={
              // Only show the standalone typing indicator BEFORE the assistant
              // bubble exists. Once it streams (reasoning models create it on the
              // first thinking token), the bubble's own live "Thinking" toggle is
              // the single indicator — no duplicate row. The working note rides
              // along here for the same reason it does in the bubble: a turn can
              // spend minutes in a tool before the first token ever arrives.
              isGenerating && !liveTurnId ? (
                <View>
                  <TypingIndicator label={t("chat.thinking")} />
                  <AiWorkingNote rtl={i18n.language === "ar"} style={styles.footerNote} />
                </View>
              ) : recovering ? (
                // Back from the background, fetching the answer the turn finished
                // without us. No working note: that one counts from a turn start
                // this device no longer has, and the wait here is seconds, not
                // minutes.
                <TypingIndicator label={t("chat.thinking")} />
              ) : null
            }
            onTouchStart={() => {
              if (toolsExpanded) {
                setToolsExpanded(false);
                rotation.value = withTiming(0, { duration: 200 });
              }
            }}
          />
          )}

          {/* Scroll-to-latest FAB — appears when scrolled away from the bottom */}
          {showScrollDown && !loadingHistory && (
            <AnimatedPressable
              entering={FadeIn.duration(150)}
              exiting={FadeOut.duration(120)}
              onPress={scrollToBottom}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Scroll to latest message"
              style={[styles.scrollDownFab, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}
            >
              <ChevronDown size={22} color={colors.textPrimary} strokeWidth={2.2} />
            </AnimatedPressable>
          )}
        </View>

        {/* The composer sits ON the system navigation bar: its background runs
            under it and `composerInset` is the padding that keeps the input
            clear of it, whichever navigation the phone uses. `keyboardLift`
            replaces that with the keyboard's height while typing. */}
        <View style={[styles.inputContainer, { backgroundColor: colors.bgPrimary, paddingBottom: composerInset + keyboardLift }]}>
          {/* Tools tray */}
          {toolsExpanded && (
            <View style={styles.toolsRow}>
              {tools.map((tool, i) => (
                <AnimatedPressable
                  key={tool.key}
                  entering={ZoomIn.delay(i * 70).duration(200)}
                  exiting={ZoomOut.delay((tools.length - 1 - i) * 30).duration(120)}
                  onPress={() => handleToolPress(tool.key)}
                  style={[styles.toolBtn, { backgroundColor: tool.color + "15" }]}
                >
                  <View style={[styles.toolIconBg, { backgroundColor: tool.color + "25" }]}>
                    <tool.icon size={20} color={tool.color} strokeWidth={1.8} />
                  </View>
                  <Text style={[styles.toolLabel, { color: tool.color }]}>{tool.label}</Text>
                </AnimatedPressable>
              ))}
            </View>
          )}

          {/* Staged images — thumbnails in a row, each removable, shown until the
              message is sent. A row rather than the file chip's layout because
              there can be several and the picture is its own label. */}
          {staged.length > 0 && (
            <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(120)} style={styles.stagedRow}>
              {staged.map((img, i) => (
                <View key={img.uri + i} style={styles.stagedItem}>
                  <Image source={{ uri: img.uri }} style={[styles.stagedThumb, { borderColor: colors.borderDefault }]} />
                  <Pressable
                    onPress={() => setStaged((prev) => prev.filter((_, at) => at !== i))}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t("chat.removeAttachment", { defaultValue: "Remove attachment" })}
                    style={[styles.stagedRemove, { backgroundColor: colors.bgCard, borderColor: colors.borderDefault }]}
                  >
                    <X size={13} color={colors.textSecondary} strokeWidth={2.4} />
                  </Pressable>
                </View>
              ))}
            </Animated.View>
          )}

          {/* Staged document — shown until the user sends or removes it */}
          {attachment && (
            <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(120)} style={[styles.attachmentChip, { backgroundColor: colors.bgSurface, borderColor: colors.borderDefault }]}>
              <View style={[styles.attachmentFileIcon, { backgroundColor: colors.brandPrimary + "22" }]}>
                <FileText size={20} color={colors.brandPrimary} strokeWidth={1.8} />
              </View>
              <View style={styles.attachmentInfo}>
                <Text style={[styles.attachmentName, { color: colors.textPrimary }]} numberOfLines={1}>
                  {attachment.name}
                </Text>
                {/* The size, until the send takes over the line to say where
                    the file is actually going — the chip is the only place the
                    student learns that an attachment becomes a source. */}
                <Text style={[styles.attachmentMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                  {uploadingSource
                    ? t("sources.uploading", { defaultValue: "Saving to your sources…" })
                    : attachment.size != null
                      ? `${(attachment.size / 1024).toFixed(1)} KB`
                      : t("chat.attachedFile", { defaultValue: "Attached file" })}
                </Text>
              </View>
              {/* Removing mid-upload would leave the source stored with no
                  message about it, so the affordance yields to a spinner. */}
              {uploadingSource ? (
                <ActivityIndicator size="small" color={colors.textSecondary} style={styles.attachmentRemove} />
              ) : (
                <Pressable
                  onPress={() => setAttachment(null)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t("chat.removeAttachment", { defaultValue: "Remove attachment" })}
                  style={[styles.attachmentRemove, { backgroundColor: colors.bgCard }]}
                >
                  <X size={16} color={colors.textSecondary} strokeWidth={2} />
                </Pressable>
              )}
            </Animated.View>
          )}

          {/* Unattached conversation: say so, and offer the way out. The AI can
              still plan, draft and cite here — it just can't touch a document —
              so this reads as an offer rather than a warning. */}
          {!thesisId && (
            <Pressable
              onPress={() => useBottomSheet.getState().openSheet("thesis-attach")}
              // bgSurface, not bgPrimary: the composer's own ground is the page
              // colour now, so a row filled with it read as a floating border.
              style={[styles.attachRow, { borderColor: colors.borderDefault, backgroundColor: colors.bgSurface }]}
              accessibilityRole="button"
              accessibilityLabel={t("chat.threads.attach")}
            >
              <FileText size={16} color={colors.textSecondary} />
              <Text style={[styles.attachHint, { color: colors.textSecondary }]} numberOfLines={2}>
                {t("chat.threads.unattachedHint")}
              </Text>
              <Text style={[styles.attachCta, { color: colors.brandPrimary }]}>{t("chat.threads.attach")}</Text>
            </Pressable>
          )}

          {/* AI suggestion chips — grounded in the conversation. Shown only when the
              model returned some (no static fallback here, unlike the workspace). */}
          {suggestions.length > 0 && !isGenerating && (
            <View style={styles.suggestionsRow}>
              <ComposerQuickActions
                suggestions={suggestions}
                onPreset={(prompt) => {
                  setInputText(prompt);
                  inputRef.current?.focus();
                }}
              />
            </View>
          )}

          {/* ONE pill holds the lot: ＋, the text, the mic and the send circle.
              The ＋ used to be a brand-filled disc of its own outside the box,
              which made two competing round buttons at either end of the row and
              read as the loudest thing on the screen. Inside the pill and
              unfilled, it is what it is — a way to add something. */}
          <View
            style={[
              styles.composerPill,
              { backgroundColor: colors.bgCard, borderColor: colors.borderDefault },
            ]}
          >
            <Pressable
              onPress={toggleTools}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={t("chat.toolAttach", { defaultValue: "Attach" })}
              style={styles.plusBtn}
            >
              <Animated.View style={plusStyle}>
                <Plus size={22} color={toolsExpanded ? colors.brandPrimary : colors.textSecondary} strokeWidth={2.2} />
              </Animated.View>
            </Pressable>

            {/* What this conversation is FOR, where it can be seen while typing.
                Disabled mid-turn: the mode is sent WITH the turn, so changing it
                under one that is already running would say nothing and mean
                nothing. */}
            <View style={styles.modeChipSlot}>
              <ChatModeChip
                mode={chatMode}
                onPress={() => setModeSheetOpen(true)}
                rtl={i18n.language === "ar"}
                disabled={isGenerating}
              />
            </View>

            <RNTextInput
              ref={inputRef}
              style={[styles.input, { color: colors.textPrimary }, inputHeight != null && { height: inputHeight }]}
              placeholder={listening ? t("composer.listening", { defaultValue: "Listening…" }) : t("chat.askPlaceholder")}
              placeholderTextColor={colors.textPlaceholder}
              value={inputText}
              onChangeText={setInputText}
              // The measurement feeds back into the height we just set, so a
              // sub-pixel difference between what we wrote and what the native
              // side measures back would setState forever — a native-event loop
              // React eventually kills with "Maximum update depth exceeded",
              // taking the whole JS thread (and every tap) with it. Ignore
              // anything under a point: no layout depends on that much.
              onContentSizeChange={(e) => {
                const measured = Math.min(
                  INPUT_MAX_HEIGHT,
                  Math.max(INPUT_MIN_HEIGHT, e.nativeEvent.contentSize.height)
                );
                setInputHeight((prev) => (prev != null && Math.abs(prev - measured) < 1 ? prev : measured));
              }}
              onSubmitEditing={handleSend}
              onFocus={() => {
                if (toolsExpanded) {
                  setToolsExpanded(false);
                  rotation.value = withTiming(0, { duration: 200 });
                }
              }}
              returnKeyType="send"
              // The text is read once, when the send starts, and becomes the
              // source's description — so it must not keep changing while the
              // file is being stored under it.
              editable={!isGenerating && !uploadingSource}
              multiline
              maxLength={2000}
            />
            {/* Dictation. Gone while a turn runs — there is nothing to dictate
                into an input that isn't editable. */}
            {!isGenerating && !uploadingSource && (
              <AnimatedPressable
                onPress={handleMic}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={listening ? t("composer.listening", { defaultValue: "Listening…" }) : t("composer.micLabel", { defaultValue: "Voice input" })}
                accessibilityState={{ selected: listening }}
                style={[styles.micBtn, listening && micStyle]}
              >
                <Mic size={20} color={listening ? colors.brandPrimary : colors.textSecondary} strokeWidth={2} />
              </AnimatedPressable>
            )}

            {/* The circle is the primary action, and it is ALWAYS the same
                circle: it sends, it spins while a document is being stored, and
                it stops a running turn. Only its fill and glyph change. */}
            {isGenerating ? (
              <AnimatedPressable
                entering={FadeIn.duration(150)}
                exiting={FadeOut.duration(100)}
                onPress={stopTurn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t("chat.stop")}
                style={[styles.sendBtn, { backgroundColor: colors.semanticError }]}
              >
                <Square size={13} color="#FFFFFF" fill="#FFFFFF" />
              </AnimatedPressable>
            ) : uploadingSource ? (
              // The send has begun — the document is going to the sources
              // before the turn opens. Not a Stop: there is no turn yet.
              <View style={[styles.sendBtn, { backgroundColor: colors.brandPrimary }]}>
                <ActivityIndicator size="small" color={colors.brandOnPrimary} />
              </View>
            ) : canSend ? (
              <AnimatedPressable
                entering={FadeIn.duration(150)}
                exiting={FadeOut.duration(100)}
                onPress={handleSend}
                accessibilityRole="button"
                accessibilityLabel={t("chat.send")}
                style={[styles.sendBtn, { backgroundColor: colors.brandPrimary }]}
              >
                <ArrowUp size={19} color={colors.brandOnPrimary} strokeWidth={2.6} />
              </AnimatedPressable>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* Mounted whether or not this copy is the visible one, and told which it
          is: a background copy RETRACTS its sheet instead of being unmounted
          mid-presentation, which is what left a second, dead sheet on screen. */}
      <AskBottomSheet
        ask={pendingAsk}
        enabled={active}
        onAnswer={(answer) => {
          setPendingAsk(null);
          if (threadId) void sendMessageToAI(threadId, thesisId, answer);
        }}
        onClose={() => setPendingAsk(null)}
      />

      {/* Out of messages (or nearly). Sits above the input, where the answer
          would have gone, rather than interrupting with a modal. */}
      {active && (
        <View style={[styles.quotaOverlay, { paddingBottom: confirmInset + keyboardLift }]}>
          <QuotaNotice />
        </View>
      )}

      {/* Gated destructive AI action → Approve/Cancel card pinned above the input.
          The doc isn't visible on this screen, so there's no "undo AI changes" chip here. */}
      {active && pendingConfirm && (
        <View
          style={[
            styles.confirmOverlay,
            { backgroundColor: colors.bgCard, borderColor: colors.borderDefault, paddingBottom: confirmInset + keyboardLift },
          ]}
        >
          <ComposerConfirm
            confirm={pendingConfirm}
            onApprove={() => threadId && void approvePendingAction(threadId, thesisId, pendingConfirm.actionId)}
            onCancel={() => threadId && void declinePendingAction(threadId, thesisId, pendingConfirm.actionId)}
            rtl={i18n.language === "ar"}
          />
        </View>
      )}

      <MessageViewer
        visible={viewerContent !== null}
        content={viewerContent}
        onClose={() => setViewerContent(null)}
        onBlockPress={openThesisBlock}
      />

      {/* Full-screen view of a tapped attachment. */}
      <ChatImageViewer image={viewerImage} onClose={() => setViewerImage(null)} />

      {/* Full-screen conversation list — owns its own load/search/menu state;
          this screen only tells it whether it's open and what to do on a pick. */}
      <ChatHistoryPanel
        visible={historyOpen}
        thesisId={thesisId}
        onClose={() => setHistoryOpen(false)}
        onPick={handlePickThread}
        onNew={handleNewThread}
      />

      {/* The mode picker. Unmounted while closed (see ChatModeSheet) — a gorhom
          modal left mounted-but-hidden stops answering present(). */}
      <ChatModeSheet
        open={modeSheetOpen}
        mode={chatMode}
        rtl={i18n.language === "ar"}
        onSelect={pickMode}
        onClose={() => setModeSheetOpen(false)}
      />

      {/* Attach a thesis to an unattached conversation. Mounted only when there
          is nothing attached — once one is, there is nothing to pick. */}
      {!thesisId && <ThesisAttachSheet onPick={handleAttachThesis} />}
    </View>
  );
}

export default function ChatScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const thesisId = useThesisStore((s) => s.currentThesisId);
  const thesisTitle = useThesisStore((s) => {
    if (!s.currentThesisId) return "";
    return s.theses.find((t) => t.id === s.currentThesisId)?.title ?? "";
  });

  // The stack can hold more than one chat screen at a time (the drawer replaces
  // the top screen, and Open chat from a thesis pushes one over the chat that is
  // already the app's root), and every one of them stays MOUNTED. They all watch
  // the same global `pendingAsk`, so without this only luck decided how many ask
  // sheets presented at once. Focus is the tiebreaker: exactly one screen has it.
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, [])
  );

  // No thesis is no longer a dead end. A conversation can stand on its own — a
  // plain assistant that can still plan, draft and answer questions about
  // citation — and the student attaches a thesis from the composer whenever they
  // want document editing. Starting one is in the drawer: New thesis, Import,
  // Templates.
  return <ThesisChat thesisId={thesisId} thesisTitle={thesisTitle} focused={focused} />;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 14 },
  topTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", flex: 1, textAlign: "center" },
  topActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  // Roomier than the old 14: with no bubble around an answer, the gap between
  // turns is the ONLY thing separating one speaker from the next.
  messageList: { padding: 16, paddingBottom: 10, gap: 20, flexGrow: 1 },
  loadOlder: { paddingVertical: 10, alignItems: "center" },
  footerNote: { marginHorizontal: 4 },
  scrollDownFab: {
    position: "absolute",
    right: 16,
    bottom: 12,
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  inputContainer: { paddingHorizontal: 12, paddingTop: 8 },
  confirmOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // Same anchoring as confirmOverlay, but no background or top border of its
  // own: QuotaNotice is a self-contained card and a second surface behind it
  // reads as two stacked panels.
  quotaOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  suggestionsRow: { marginBottom: 10, marginHorizontal: 2 },
  attachRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
    marginHorizontal: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  attachHint: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
  attachCta: { fontSize: 12, fontFamily: "Inter_600SemiBold" },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
    marginHorizontal: 2,
    padding: 8,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  stagedRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 10, marginHorizontal: 2 },
  // Padded on the top/right so the remove button, which overhangs the thumbnail,
  // isn't clipped by the row.
  stagedItem: { paddingTop: 6, paddingRight: 6 },
  stagedThumb: { width: 62, height: 62, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  stagedRemove: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  attachmentFileIcon: { width: 44, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  attachmentInfo: { flex: 1, gap: 2 },
  attachmentName: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  attachmentMeta: { fontSize: 11, fontFamily: "Inter_400Regular" },
  attachmentRemove: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  toolsRow: { flexDirection: "row", gap: 8, marginBottom: 10, paddingHorizontal: 2 },
  toolBtn: { flex: 1, alignItems: "center", gap: 6, paddingVertical: 12, borderRadius: 14 },
  toolIconBg: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  toolLabel: { fontSize: 11, fontFamily: "Inter_500Medium" },
  // One floating pill. The hairline plus a whisper of shadow is what lifts it off
  // a page that is now the same colour behind it — a borderless box on bgPrimary
  // in the light theme has nothing to be seen against.
  composerPill: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    paddingVertical: 7,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  // The chip is ~26 tall and the buttons are 34, and the pill aligns its row on
  // flex-end — so bottom-aligning the chip parked its optical centre four points
  // below the ＋ and the mic, which is the "sitting too low" everyone could see
  // and nobody could name. Give it the buttons' own 34-point box and centre it
  // inside: one centre line across the row on a single-line input, and the box
  // still hugs the bottom as the input grows, exactly like the buttons do.
  // (flex-end stays — it is what makes a multi-line input grow UPWARD.)
  modeChipSlot: { height: 34, justifyContent: "center" },
  // Ghost buttons: no fill, sized for the thumb, aligned with the input's last line.
  plusBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  micBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, fontSize: 15, fontFamily: "Inter_400Regular", paddingVertical: 7, minHeight: INPUT_MIN_HEIGHT, maxHeight: INPUT_MAX_HEIGHT },
  sendBtn: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  noThesis: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  noThesisText: { fontSize: 16, fontFamily: "Inter_400Regular", textAlign: "center" },
  homeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 20,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 14,
  },
  homeBtnText: { color: "#FFFFFF", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
