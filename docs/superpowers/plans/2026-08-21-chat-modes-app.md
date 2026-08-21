# Chat modes (app) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mode chip in the composer that shows the conversation's mode and opens a sheet to change it — Ask, Assist, Agent — sending the choice with every turn.

**Architecture:** The mode is a property of the conversation, held in `chat-threads-store` and sent as one field on the chat request. One presentational component (`ChatModeChip`) and one sheet (`ChatModeSheet`) serve both composers — the chat screen's own pill row and the workspace composer sheet.

**Tech Stack:** Expo v56 (read https://docs.expo.dev/versions/v56.0.0/ before writing code), React Native, Zustand, `@gorhom/bottom-sheet`, i18next. **This repo has no JS test runner** — the gate is `npx tsc --noEmit`.

**Repo:** `~/modakerati`. **Prerequisite:** the server plan is deployed, or the picker sends a field nothing reads yet (harmless — the server falls back to `assist`).

**Branch:** create `feat/chat-modes` from `master` — NOT from `feat/web-version`, which carries unrelated WIP.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/chat-modes.ts` **(new)** | The three modes as app-side data: key, icon, i18n keys. Mirrors the server registry; holds no behaviour. |
| `components/chat/ChatModeChip.tsx` **(new)** | The chip: current mode's icon + label, opens the sheet. Presentational. |
| `components/chat/ChatModeSheet.tsx` **(new)** | The picker sheet: three rows, one line of explanation each. |
| `lib/api.ts` | `mode` on `ChatThread`; `mode` option on `chatSendStream`. |
| `stores/chat-threads-store.ts` | `modeFor(threadId)` + `setMode(threadId, mode)`. |
| `app/(app)/chat.tsx` | Chip in the composer pill row; mode passed to the send call. |
| `components/workspace/WorkspaceComposerSheet.tsx` | Same chip, same call. |
| `locales/{en,fr,ar}.json` | `chatModes.*` strings. |

⚠️ **Naming.** `components/workspace/ComposerModeToggle.tsx` already exists and already calls something a "mode" — the `ai | edit` toggle that chooses which composer you are typing into. That is a different axis. Do not extend it, do not reuse its `Mode` type, and name everything here `chatMode` so the two never read as the same thing in a diff.

---

### Task 1: The mode table

**Files:**
- Create: `lib/chat-modes.ts`

- [ ] **Step 1: Write it**

```ts
// lib/chat-modes.ts
import { MessageCircleQuestion, Sparkles, Zap } from "lucide-react-native";

// The three conversation modes, mirrored from the server registry
// (~/modakerati-server/src/lib/ai/chat-modes.ts). Data only — what a mode DOES
// is decided server-side; the app only shows it and sends it.
export type ChatMode = "ask" | "assist" | "agent";

export const CHAT_MODES: ChatMode[] = ["ask", "assist", "agent"];
export const DEFAULT_CHAT_MODE: ChatMode = "assist";

export const CHAT_MODE_ICONS: Record<ChatMode, typeof Sparkles> = {
  ask: MessageCircleQuestion,
  assist: Sparkles,
  agent: Zap,
};

/** i18n key for a mode's short label (the chip) and its one-line description (the sheet). */
export const chatModeLabelKey = (m: ChatMode) => `chatModes.${m}.label`;
export const chatModeHintKey = (m: ChatMode) => `chatModes.${m}.hint`;

export function isChatMode(v: unknown): v is ChatMode {
  return v === "ask" || v === "assist" || v === "agent";
}

/** A thread's mode, tolerating an older server that returns none. */
export function chatModeOf(value: unknown): ChatMode {
  return isChatMode(value) ? value : DEFAULT_CHAT_MODE;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/chat-modes.ts
git commit -m "feat(chat-modes): the app-side mode table"
```

---

### Task 2: The strings, in three languages

**Files:**
- Modify: `locales/en.json`, `locales/fr.json`, `locales/ar.json`

⚠️ **These files contain ~155 duplicate keys each.** `json.load` / `json.dump` silently drops them. Edit them **surgically** — open the file, insert the block by hand next to the existing `chat` block, save. Never round-trip them through a JSON parser, and never let a formatter touch them.

- [ ] **Step 1: Add the block to `locales/en.json`**

```json
  "chatModes": {
    "title": "How should the assistant work?",
    "ask": { "label": "Ask", "hint": "Answers your questions. Never changes the document." },
    "assist": { "label": "Assist", "hint": "Edits your thesis, and asks before anything it cannot take back." },
    "agent": { "label": "Agent", "hint": "Does the whole job without stopping to ask. Undo it all in one tap." }
  },
```

- [ ] **Step 2: Add it to `locales/fr.json`**

```json
  "chatModes": {
    "title": "Comment l'assistant doit-il travailler ?",
    "ask": { "label": "Question", "hint": "Répond à vos questions. Ne modifie jamais le document." },
    "assist": { "label": "Assistant", "hint": "Modifie votre mémoire et demande avant tout changement irréversible." },
    "agent": { "label": "Agent", "hint": "Fait tout le travail sans s'arrêter. Tout annuler en une seule fois." }
  },
```

- [ ] **Step 3: Add it to `locales/ar.json`**

```json
  "chatModes": {
    "title": "كيف تريد أن يعمل المساعد؟",
    "ask": { "label": "سؤال", "hint": "يجيب عن أسئلتك ولا يعدّل المذكرة أبداً." },
    "assist": { "label": "مساعدة", "hint": "يعدّل مذكرتك ويستأذنك قبل أي تغيير لا يمكن التراجع عنه." },
    "agent": { "label": "تنفيذ", "hint": "ينجز العمل كاملاً دون توقّف. يمكنك التراجع عن كل شيء بضغطة واحدة." }
  },
```

- [ ] **Step 4: Prove nothing was lost**

Run: `for f in locales/en.json locales/fr.json locales/ar.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "$f parses"; done`
Expected: three "parses" lines. (This only proves the file is valid JSON — the duplicate keys are unaffected because you edited by hand.)

Run: `git diff --stat locales/`
Expected: three files, roughly +6 lines each. **If any file shows hundreds of changed lines, a formatter round-tripped it — `git checkout` that file and redo it by hand.**

- [ ] **Step 5: Commit**

```bash
git add locales/en.json locales/fr.json locales/ar.json
git commit -m "feat(chat-modes): trilingual strings for the mode picker"
```

---

### Task 3: The chip

**Files:**
- Create: `components/chat/ChatModeChip.tsx`

- [ ] **Step 1: Write it**

```tsx
// components/chat/ChatModeChip.tsx
import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { visualRow } from "@/lib/rtl-layout";
import { CHAT_MODE_ICONS, chatModeLabelKey, type ChatMode } from "@/lib/chat-modes";

interface Props {
  mode: ChatMode;
  onPress: () => void;
  rtl: boolean;
  disabled?: boolean;
}

/**
 * What this conversation is FOR, sitting in the composer where the student can
 * see it while they type — which is the moment it matters. Tapping opens the
 * picker sheet; this component decides nothing itself.
 *
 * Agent is tinted, the other two are not: "no prompts, runs on its own" is the
 * state worth noticing before you press send.
 */
export function ChatModeChip({ mode, onPress, rtl, disabled }: Props) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const Icon = CHAT_MODE_ICONS[mode];
  const accent = mode === "agent" ? colors.brandPrimary : colors.textSecondary;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={t(chatModeLabelKey(mode))}
      style={[
        styles.chip,
        {
          flexDirection: visualRow(rtl),
          backgroundColor: colors.bgInput,
          borderColor: mode === "agent" ? colors.brandPrimary : colors.borderDefault,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Icon size={13} color={accent} strokeWidth={2.2} />
      <Text style={[styles.label, { color: accent }]} numberOfLines={1}>
        {t(chatModeLabelKey(mode))}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, borderWidth: 1 },
  label: { fontSize: 11, fontFamily: "Inter_600SemiBold" },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. If `visualRow` is not exported from `@/lib/rtl-layout`, run `grep -n "export" lib/rtl-layout.ts` and use the row helper that is — `ComposerModeToggle.tsx` uses `visualRow`, so it exists.

- [ ] **Step 3: Commit**

```bash
git add components/chat/ChatModeChip.tsx
git commit -m "feat(chat-modes): the composer mode chip"
```

---

### Task 4: The picker sheet

**Files:**
- Create: `components/chat/ChatModeSheet.tsx`

⚠️ gorhom rules that have bitten this repo before: the sheet must be **unmounted when closed**, presented with exactly one `requestAnimationFrame(present)`, and re-presented only **after** `onDismiss` has fired.

- [ ] **Step 1: Write it**

```tsx
// components/chat/ChatModeSheet.tsx
import React, { useCallback, useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import BottomSheet, { BottomSheetBackdrop, BottomSheetView } from "@gorhom/bottom-sheet";
import { Check } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { visualRow } from "@/lib/rtl-layout";
import { CHAT_MODES, CHAT_MODE_ICONS, chatModeHintKey, chatModeLabelKey, type ChatMode } from "@/lib/chat-modes";

interface Props {
  open: boolean;
  mode: ChatMode;
  rtl: boolean;
  onSelect: (m: ChatMode) => void;
  onClose: () => void;
}

/** The three modes, one line of plain thesis language each. */
export function ChatModeSheet({ open, mode, rtl, onSelect, onClose }: Props) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const ref = useRef<BottomSheet>(null);

  // One frame, once — presenting twice in a row is what wedges this sheet shut.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => ref.current?.expand());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
    [],
  );

  // Unmounted when closed, deliberately: a mounted-but-hidden gorhom sheet is
  // the state that stops responding to the next present.
  if (!open) return null;

  return (
    <BottomSheet
      ref={ref}
      index={-1}
      snapPoints={["45%"]}
      enablePanDownToClose
      onClose={onClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.bgCard }}
      handleIndicatorStyle={{ backgroundColor: colors.borderDefault }}
    >
      <BottomSheetView style={styles.body}>
        <Text style={[styles.title, { color: colors.textPrimary, textAlign: rtl ? "right" : "left" }]}>
          {t("chatModes.title")}
        </Text>
        {CHAT_MODES.map((m) => {
          const Icon = CHAT_MODE_ICONS[m];
          const active = m === mode;
          return (
            <Pressable
              key={m}
              onPress={() => onSelect(m)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[
                styles.row,
                { flexDirection: visualRow(rtl), borderColor: active ? colors.brandPrimary : colors.borderDefault },
              ]}
            >
              <Icon size={18} color={active ? colors.brandPrimary : colors.textSecondary} strokeWidth={2.2} />
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, { color: colors.textPrimary, textAlign: rtl ? "right" : "left" }]}>
                  {t(chatModeLabelKey(m))}
                </Text>
                <Text style={[styles.rowHint, { color: colors.textSecondary, textAlign: rtl ? "right" : "left" }]}>
                  {t(chatModeHintKey(m))}
                </Text>
              </View>
              {active && <Check size={16} color={colors.brandPrimary} strokeWidth={2.6} />}
            </Pressable>
          );
        })}
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold", marginBottom: 4 },
  row: { alignItems: "center", gap: 12, padding: 12, borderRadius: 14, borderWidth: 1 },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  rowHint: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 17 },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. If the gorhom import names differ, check an existing sheet — `components/workspace/HistorySheet.tsx` — and match it exactly rather than guessing.

- [ ] **Step 3: Commit**

```bash
git add components/chat/ChatModeSheet.tsx
git commit -m "feat(chat-modes): the mode picker sheet"
```

---

### Task 5: The mode travels with the turn

**Files:**
- Modify: `lib/api.ts:774-783` (`ChatThread`) and `:719-753` (`chatSendStream`)
- Modify: `stores/chat-threads-store.ts`

- [ ] **Step 1: Add `mode` to the thread type**

In `lib/api.ts`, inside `export interface ChatThread`, after `pinned: boolean;`:

```ts
  /** Ask / Assist / Agent. Absent on a server that predates modes — read it
   *  through chatModeOf(), which falls back to "assist". */
  mode?: string;
```

- [ ] **Step 2: Send it**

In `chatSendStream`, add `mode` to the options type:

```ts
  options?: { chapterId?: string; sectionId?: string; selection?: string; docBlockIndex?: number | null; docBlockIndices?: number[]; regenerate?: boolean; attachments?: ChatAttachmentUpload[]; mode?: string; signal?: AbortSignal }
```

and to the body, after `regenerate`:

```ts
    // The conversation's mode (Ask / Assist / Agent). The server persists it on
    // the thread, so sending it every turn is what keeps the two in step — and
    // omitting it (an older build) leaves the thread on whatever it had.
    mode: options?.mode,
```

- [ ] **Step 3: Hold it in the store**

In `stores/chat-threads-store.ts`, add to `ChatThreadsState`:

```ts
  /** Mode per thread, seeded from the server's thread list and updated when the
   *  student picks one. Kept here rather than in chat-store because it belongs
   *  to the CONVERSATION, not to the messages on screen. */
  modes: Record<string, ChatMode>;
  modeFor: (threadId: string | null) => ChatMode;
  setMode: (threadId: string, mode: ChatMode) => void;
```

and in the store body:

```ts
  modes: {},
  modeFor: (threadId) => (threadId ? get().modes[threadId] ?? DEFAULT_CHAT_MODE : DEFAULT_CHAT_MODE),
  setMode: (threadId, mode) => set((s) => ({ modes: { ...s.modes, [threadId]: mode } })),
```

In `load()`, seed the map from the fetched threads, next to where `threads` is set:

```ts
      const modes = Object.fromEntries(list.map((th) => [th.id, chatModeOf(th.mode)]));
      set({ threads: list, modes: { ...get().modes, ...modes }, loading: false });
```

with `import { chatModeOf, DEFAULT_CHAT_MODE, type ChatMode } from "@/lib/chat-modes";`.

⚠️ Selector rule: components read `useChatThreadsStore((s) => s.modes[threadId])` — a **primitive**. Never `useChatThreadsStore((s) => ({ mode: ... }))`; a fresh object literal every render is the "Maximum update depth exceeded" this codebase has already paid for.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/api.ts stores/chat-threads-store.ts
git commit -m "feat(chat-modes): the mode rides with the turn and lives on the thread"
```

---

### Task 6: Wire it into the chat screen

**Files:**
- Modify: `app/(app)/chat.tsx` (the composer pill, ~line 1320)

- [ ] **Step 1: Add the state and the handlers**

Near the other composer state:

```tsx
  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  const chatMode = useChatThreadsStore((s) => (threadId ? s.modes[threadId] : undefined)) ?? DEFAULT_CHAT_MODE;
  const setThreadMode = useChatThreadsStore((s) => s.setMode);
```

with `import { ChatModeChip } from "@/components/chat/ChatModeChip";`, `import { ChatModeSheet } from "@/components/chat/ChatModeSheet";` and `import { DEFAULT_CHAT_MODE, type ChatMode } from "@/lib/chat-modes";`.

- [ ] **Step 2: Put the chip in the pill**

Immediately after the `＋` `Pressable` inside `styles.composerPill` and before the `RNTextInput`:

```tsx
            <ChatModeChip
              mode={chatMode}
              rtl={isRtl}
              disabled={isGenerating}
              onPress={() => setModeSheetOpen(true)}
            />
```

Use whatever this screen already calls its RTL flag — `grep -n "rtl" app/\(app\)/chat.tsx | head` — rather than introducing a second one.

- [ ] **Step 3: Render the sheet**

At the end of the screen's tree, beside the other sheets:

```tsx
      <ChatModeSheet
        open={modeSheetOpen}
        mode={chatMode}
        rtl={isRtl}
        onSelect={(m: ChatMode) => {
          if (threadId) setThreadMode(threadId, m);
          setModeSheetOpen(false);
        }}
        onClose={() => setModeSheetOpen(false)}
      />
```

- [ ] **Step 4: Send the mode**

Find the `chatSendStream(` call in this file (`grep -n "chatSendStream(" app/\(app\)/chat.tsx`) and add `mode: chatMode,` to its options object.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "app/(app)/chat.tsx"
git commit -m "feat(chat-modes): mode chip in the chat composer"
```

---

### Task 7: Wire it into the workspace composer

**Files:**
- Modify: `components/workspace/WorkspaceComposerSheet.tsx`

- [ ] **Step 1: Add the state**

```tsx
import { ChatModeChip } from "@/components/chat/ChatModeChip";
import { ChatModeSheet } from "@/components/chat/ChatModeSheet";
import { DEFAULT_CHAT_MODE, type ChatMode } from "@/lib/chat-modes";

  const [modeSheetOpen, setModeSheetOpen] = useState(false);
  const chatMode = useChatThreadsStore((s) => (threadId ? s.modes[threadId] : undefined)) ?? DEFAULT_CHAT_MODE;
  const setThreadMode = useChatThreadsStore((s) => s.setMode);
```

- [ ] **Step 2: Put the chip in the composer row**

Beside the attach control, in the same row as `ComposerModeToggle` and NOT inside it:

```tsx
            <ChatModeChip
              mode={chatMode}
              rtl={isRtl}
              disabled={isGenerating}
              onPress={() => setModeSheetOpen(true)}
            />
```

- [ ] **Step 3: Render the sheet at the end of the tree**

```tsx
      <ChatModeSheet
        open={modeSheetOpen}
        mode={chatMode}
        rtl={isRtl}
        onSelect={(m: ChatMode) => {
          if (threadId) setThreadMode(threadId, m);
          setModeSheetOpen(false);
        }}
        onClose={() => setModeSheetOpen(false)}
      />
```

- [ ] **Step 4: Send it**

Find this file's send call (`grep -n "chatSendStream(" components/workspace/WorkspaceComposerSheet.tsx`) and add `mode: chatMode,` to its options object. Use whatever this file already calls its RTL flag and its generating flag rather than introducing new ones.

⚠️ This file has been rewritten by hand before and had uncommitted work applied on top of it. Before editing: `git status --porcelain components/workspace/WorkspaceComposerSheet.tsx`. If it is dirty, stop and ask — do not fold your change into somebody else's WIP.

⚠️ Do not confuse this with `ComposerModeToggle` (`ai | edit`), which already lives in this file. The chip goes beside it, not inside it.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add components/workspace/WorkspaceComposerSheet.tsx
git commit -m "feat(chat-modes): mode chip in the workspace composer"
```

---

### Task 8: Verify on a device

- [ ] **Step 1: Typecheck the whole app**

Run: `npx tsc --noEmit`
Expected: clean. This is the only automated gate this repo has.

- [ ] **Step 2: Check the `use dom` gate**

Run: `node scripts/verify-use-dom.mjs`
Expected: pass. (Nothing here touches a DOM component, but the gate is cheap and a named export in one of those files breaks a whole screen at bundle time, invisibly to tsc.)

- [ ] **Step 3: Run it**

Run: `npm start`, open the app, and check by hand:
- the chip shows **Assist** on a new conversation;
- picking **Agent** and asking for something destructive (e.g. "change the header on every part") completes with **no Approve prompt**;
- the "Undo AI changes" chip still appears afterwards and restores the document;
- picking **Ask** and asking it to edit gets an offer to switch modes, not "I can't do that";
- reopening the conversation shows the mode it was left in;
- the sheet reads correctly right-to-left in Arabic.

- [ ] **Step 4: Ship**

JS-only change, so an OTA carries it — but resolve the fingerprint first and compare against the installed APK before publishing:

```bash
npx expo-updates runtimeversion:resolve --platform android
unzip -p android/app/build/outputs/apk/release/app-release.apk assets/fingerprint
```

Equal → `./scripts/publish-update.sh "chat modes: Ask / Assist / Agent"`. Different → build the APK **first**, verify the fingerprint again, then publish.

---

# Addendum — the plan card (2026-08-21)

Written after Plan mode was added server-side. Everything above still stands; these
three tasks come after Task 7 and before the device checks in Task 8.

**What the server now sends.** In Plan mode the assistant calls `propose_plan`, which
ends the turn and emits a frame the server does NOT strip before saving:

```
[[MODK_PLAN]]{"id":"…","title":"…","steps":[{"title":"…","detail":"…"}]}[[/MODK_PLAN]]
```

Because it is persisted, the card must render both live (from the stream) and on reload
(from the stored message) — unlike `[[MODK_CONFIRM]]`, which is live-only.

**What runs it.** `POST /api/chat/execute-plan { threadId, planId }` streams back through
the same frame protocol as `/api/chat/confirm-action`, so no new stream handling is needed.
An unknown `planId` is refused by the server — never retry with a different one.

---

### Task 9: Parse the plan frame

**Files:** `lib/plan-frames.ts` (new), `lib/api.ts`

- [ ] **Step 1: Mirror the server's parser** in `lib/plan-frames.ts`:

```ts
// The [[MODK_PLAN]] frame — a plan the assistant proposed, rendered as a card
// with an Execute button. Mirrors ~/modakerati-server/src/lib/ai/plan-frames.ts.
//
// PERSISTED, unlike [[MODK_CONFIRM]]: the server saves it onto the message, so the
// card must survive reopening the conversation. That means parsing it in TWO
// places — the live stream pump AND stored message content.
export interface PlanStep { title: string; detail?: string }
export interface PlanPayload { id: string; title: string; steps: PlanStep[] }

export const PLAN_FRAME_OPEN = "[[MODK_PLAN]]";
const PLAN_FRAME_RE = /\[\[MODK_PLAN\]\]([\s\S]*?)\[\[\/MODK_PLAN\]\]/g;

/** Every plan in a message, oldest first. Malformed frames are skipped, never thrown. */
export function parsePlanFrames(text: string): PlanPayload[] {
  const out: PlanPayload[] = [];
  for (const m of text.matchAll(PLAN_FRAME_RE)) {
    try {
      const p = JSON.parse(m[1]) as PlanPayload;
      if (p && typeof p.id === "string" && Array.isArray(p.steps)) out.push(p);
    } catch {
      // A half-streamed frame is not a plan yet. Skip it.
    }
  }
  return out;
}

/** The message text with its plan frames removed — what the bubble should show. */
export function stripPlanFrames(text: string): string {
  return text.replace(PLAN_FRAME_RE, "").trim();
}
```

- [ ] **Step 2: Handle it in the stream pump.** In `lib/api.ts`, `postChatStream` already
  watches for `[[MODK_CONFIRM]]`, `[[MODK_IMG]]` and friends — read that code and follow it
  exactly. Add `onPlan?: (plan: PlanPayload) => void` to `ChatStreamHandlers` and fire it
  when a complete plan frame arrives. ⚠️ A frame can arrive SPLIT across chunks; the
  existing frames already solve that — reuse the same buffering, do not invent a second
  mechanism.

- [ ] **Step 3: Add the execute call** to `lib/api.ts`, beside `chatConfirmAction`:

```ts
/** Run a plan the assistant proposed. Streams the work back through the same
 *  frame protocol as chatConfirmAction. */
export async function chatExecutePlan(
  threadId: string,
  planId: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return postChatStream("/api/chat/execute-plan", { threadId, planId }, handlers, signal);
}
```

- [ ] **Step 4:** `npx tsc --noEmit` — clean. Commit: `feat(chat-modes): parse the plan frame`

---

### Task 10: The plan card

**Files:** `components/chat/PlanCard.tsx` (new)

- [ ] **Step 1: Write it.** Numbered steps, the title, an Execute button and a secondary
  "Ask for changes" that just focuses the composer. Match the visual language of
  `components/workspace/ComposerConfirm.tsx` (the Approve/Cancel chips) — this is the same
  family of thing: the assistant asking for a decision.

  Requirements:
  - `useThemeColors()`, never a hardcoded colour; typography from `constants/`.
  - RTL: the steps read from the correct edge — use the helpers in `lib/rtl-layout.ts`,
    not raw `left`/`right`.
  - While running, the Execute button shows a spinner and is disabled; when the run ends
    the card shows as done. It must never be tappable twice — a double tap would run the
    plan twice.
  - Trilingual strings under `chatModes.plan.*` — ⚠️ locale JSONs carry duplicate keys,
    edit them SURGICALLY, never through a JSON parser.

- [ ] **Step 2:** `npx tsc --noEmit` — clean. Commit: `feat(chat-modes): the plan card`

---

### Task 11: Render and run it

**Files:** `app/(app)/chat.tsx`, `components/workspace/WorkspaceComposerSheet.tsx`, `stores/chat-store.ts`

- [ ] **Step 1: Show the card in the conversation.** Where a message is rendered, run
  `parsePlanFrames` over its content; if it holds a plan, render `<PlanCard>` under the
  bubble and `stripPlanFrames` the text so the raw frame never shows as text. This covers
  BOTH cases at once — live and reloaded — because the frame is persisted.

- [ ] **Step 2: Wire Execute** to `chatExecutePlan(threadId, plan.id, handlers)`, reusing
  the same handlers the normal send path uses so the streamed reply lands in the thread
  exactly like any other turn.

- [ ] **Step 3: Guard the double run.** Keep the running plan's id in `chat-store` and
  refuse a second execute while one is in flight. ⚠️ Select a PRIMITIVE from the store
  (`s.runningPlanId`), never an object literal.

- [ ] **Step 4:** `npx tsc --noEmit`, then `node scripts/verify-use-dom.mjs`.
  Commit: `feat(chat-modes): run a plan from its card`
