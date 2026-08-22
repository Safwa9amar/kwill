import { memo, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { AlertCircle, RotateCcw } from "lucide-react-native";
import { Markdown } from "@/components/Markdown";
import { FileCard } from "@/components/FileCard";
import { ThinkingTrace } from "@/components/ThinkingTrace";
import { AiWorkingNote } from "@/components/AiWorkingNote";
import { ChatImageGrid } from "@/components/ChatImages";
import { MessageActions } from "@/components/chat/MessageActions";
import { PlanCard } from "@/components/chat/PlanCard";
import { splitFileFrames } from "@/lib/file-frames";
import { parsePlanFrames, stripPlanFrames, stripPlanStepFrames, type PlanPayload, type PlanStepProgress } from "@/lib/plan-frames";
import { splitImageFrames } from "@/lib/chat-images";
import { deriveThinkingMs } from "@/lib/thinking";
import { getTextDirection } from "@/lib/text-direction";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import type { ThemeColors } from "@/constants/colors";
import type { BlockLink } from "@/lib/block-links";
import type { ChatMessage, ChatImage, FilePayload } from "@/types/chat";

// ─────────────────────────────────────────────────────────────────────────────
// One turn in the transcript.
//
// The two speakers are drawn differently ON PURPOSE, and only one of them gets a
// bubble:
//
//   • The STUDENT's message is short and belongs to them — a soft pill at the
//     reading end, the way every messaging app draws your own words.
//   • The ASSISTANT's answer is the page. No bubble, no avatar, no 75% cap: it
//     is prose with headings, tables and lists in it, and boxing that inside a
//     tinted three-quarter-width card is what made every long answer a narrow
//     column of wrapped fragments. Full width, on the page's own ground.
//
// That asymmetry is the whole redesign; everything below (thinking trace, file
// cards, image grid, retry) hangs off it unchanged.
// ─────────────────────────────────────────────────────────────────────────────

// Above this length an answer is clipped to a preview with expand / open-full
// affordances. Generous, because a full-width answer fits far more before it
// dominates the scroll than the old 75% bubble did — the threshold used to be
// 280 characters, which collapsed answers barely longer than this comment.
const EXPAND_THRESHOLD = 1200;
// Height of the clipped preview shown before the reader expands the message.
const COLLAPSED_HEIGHT = 420;

// Shared empties, so "no plans" / "nothing run yet" is the same reference on
// every render rather than a fresh array each time.
const NO_PLANS: PlanPayload[] = [];
const NO_DONE: string[] = [];
const NO_TICKS: PlanStepProgress[] = [];
const NO_STEPS: Record<string, PlanStepProgress[]> = {};

/**
 * Gradient-style fade from transparent to the page color, masking the hard clip
 * at the bottom of a collapsed answer. Built from stacked opacity bands so we
 * don't need a gradient dependency.
 */
function FadeOverlay({ color }: { color: string }) {
  const SLICES = 10;
  const H = 56;
  return (
    <View pointerEvents="none" style={[styles.fadeOverlay, { height: H }]}>
      {Array.from({ length: SLICES }).map((_, i) => (
        <View key={i} style={{ height: H / SLICES, backgroundColor: color, opacity: (i + 1) / SLICES }} />
      ))}
    </View>
  );
}

interface Props {
  item: ChatMessage;
  colors: ThemeColors;
  isStreaming?: boolean;
  isLiveTurn?: boolean;
  isLastAssistant?: boolean;
  isUnanswered?: boolean;
  onExpand?: (content: string) => void;
  onPreviewFile?: (file: FilePayload) => void;
  onRegenerate?: () => void;
  onRetryMessage?: (id: string) => void;
  onViewImage?: (image: ChatImage) => void;
  onBlockPress?: (link: BlockLink, label: string) => void;
  /** Plan mode: run the plan on this message's card. */
  onExecutePlan?: (planId: string) => void;
  /** Plan mode: the student wants it different — hands them back the composer. */
  onAskPlanChanges?: () => void;
  /** The plan executing right now, app-wide (chat-store). */
  runningPlanId?: string | null;
  /** Plans already run this session — their cards keep the steps, lose the button. */
  donePlanIds?: string[];
  /** Which steps of which plan are ticked off (chat-store's `planSteps`). Keyed
   *  by planId because the ticks and the card do NOT live on the same message —
   *  see the comment on `plans` below. */
  planSteps?: Record<string, PlanStepProgress[]>;
}

export const MessageBubble = memo(function MessageBubble({
  item,
  colors,
  isStreaming,
  isLiveTurn,
  isLastAssistant,
  isUnanswered,
  onExpand,
  onPreviewFile,
  onRegenerate,
  onRetryMessage,
  onViewImage,
  onBlockPress,
  onExecutePlan,
  onAskPlanChanges,
  runningPlanId,
  donePlanIds = NO_DONE,
  planSteps = NO_STEPS,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const isUser = item.role === "user";
  // Both roles can carry frames in `content`, and neither may ever render one as
  // text. Assistant: [[MODK_FILE]] artifacts (an export) → file cards. User:
  // [[MODK_IMG]] attachments → thumbnails. Live sends arrive on item.files /
  // item.images with the frame already handled; a message reloaded from history
  // still holds it, so parse here too and prefer the live copy when there is one.
  const { text: framedText, files: framedFiles, images: framedImages } = isUser
    ? { ...splitImageFrames(item.content), files: [] as FilePayload[] }
    : { ...splitFileFrames(item.content), images: [] as ChatImage[] };
  const files = item.files?.length ? item.files : framedFiles;
  const images = item.images?.length ? item.images : framedImages;
  // [[MODK_PLAN]] reaches this component by TWO different routes and both are
  // real. LIVE: the stream pump eats the frame and fires onPlan, so ai-service
  // has already put the plan on item.plans and the streamed content never held
  // it — parsePlanFrames here would find nothing. RELOAD: the server persists the
  // frame onto the stored message, so a bubble read back from history has it in
  // `content` and nothing has ever called onPlan for it. Handle one and the card
  // works in one of the two situations only.
  const plans = isUser ? NO_PLANS : item.plans?.length ? item.plans : parsePlanFrames(item.content);
  // [[MODK_PLAN_STEP]] takes BOTH routes too, but it never lands on the message
  // that shows the card: the ticks are persisted in the message that EXECUTED
  // the plan, several messages further down. So they are not derived here at all
  // — chat-store folds every tick in the thread into one planId-keyed record
  // (live from the pump, rebuilt from stored content on load) and the card looks
  // itself up in it.
  //
  // …and whichever route either frame came by, it must never be readable as
  // text. Both strippers also drop a DANGLING open frame, which an aborted turn
  // can leave persisted — likelier for a step frame, which is written mid-turn.
  const bodyText = isUser ? framedText : stripPlanStepFrames(stripPlanFrames(framedText));
  // Whether there's answer text below the thinking block. While the model is
  // still reasoning, content is empty — so the thinking wrapper must not draw
  // its separator/spacing or it renders as an empty framed box.
  const hasContent = bodyText.trim().length > 0;
  // Only completed assistant answers collapse — streaming text stays fully visible.
  const isLong = !isUser && !isStreaming && bodyText.length > EXPAND_THRESHOLD;
  const collapsed = isLong && !expanded;
  // The most recent assistant reply gets a "Regenerate" affordance — re-runs the
  // last user turn for a different answer. Hidden while streaming. Deliberately
  // NOT gated on there being answer text: a turn that ends with only a thinking
  // trace (or nothing at all) is exactly when the student needs to retry, and
  // gating on content made that message a dead end.
  const canRegenerate = !!isLastAssistant && !isStreaming;
  // The student's own last message never got an answer (they hit Stop, or the turn
  // died before a reply existed). Offer the same retry there — otherwise the only
  // way back is retyping the question.
  // A send whose turn never landed is marked failed by ai-service, wherever it
  // sits in the list — not only when it happens to be last. `isUnanswered` still
  // covers the softer case (the student hit Stop, or the turn ended with no
  // answer), so both routes to a dead end offer the same way out.
  const sendFailed = isUser && !!item.failed;
  const canRetryOwn = isUser && (sendFailed || !!isUnanswered);
  // The reasoning is still streaming (no answer text yet) → the "Thinking" toggle
  // shows live bouncing dots so it reads as active, replacing the separate typing
  // indicator. Once the answer starts (or the turn ends) the dots stop and it
  // stays as a collapsed, tappable toggle for reviewing the reasoning.
  const thinkingActive = !!isStreaming && !hasContent;
  // Direction follows the message's own language so a mix of Arabic/English/French
  // chats each align correctly regardless of the app's locale.
  const dir = getTextDirection(bodyText);
  const rtl = dir === "rtl";
  const textDirStyle = { textAlign: visualTextAlign(rtl), writingDirection: dir } as const;

  // ——— The student ———
  if (isUser) {
    return (
      <View style={styles.userRow}>
        <View style={[styles.userBubble, { backgroundColor: colors.chatUserBubble }]}>
          {/* Attachments sit ABOVE the caption, the way every messaging app puts
              them — the picture is the subject, the text is what's being asked
              about it. */}
          {images.length > 0 && (
            <View style={hasContent ? styles.bubbleImagesSpaced : undefined}>
              <ChatImageGrid images={images} onPress={onViewImage} />
            </View>
          )}
          {hasContent ? (
            <Text selectable style={[styles.messageText, { color: colors.chatUserText }, textDirStyle]}>
              {bodyText}
            </Text>
          ) : null}
        </View>
        {canRetryOwn && (
          <View style={[styles.retryRow, { flexDirection: visualRow(rtl) }]}>
            {/* Say it plainly. A failed send that looks delivered is what makes a
                student send the same request again — the retry beside it exists
                so they never have to retype it. */}
            {sendFailed && (
              <View style={[styles.retryItem, { flexDirection: visualRow(rtl) }]}>
                <AlertCircle size={13} color={colors.semanticError} strokeWidth={2} />
                <Text style={[styles.retryLabel, { color: colors.semanticError }]}>
                  {t("chat.notSent", { defaultValue: "Not sent" })}
                </Text>
              </View>
            )}
            <Pressable
              // A FAILED send re-runs this exact row (no new message, and no
              // server-side regenerate — that path deletes the reply it replaces).
              // The unanswered case keeps the old regenerate behaviour.
              onPress={() => (sendFailed ? onRetryMessage?.(item.id) : onRegenerate?.())}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t("chat.tryAgain", { defaultValue: "Try again" })}
              style={[styles.retryItem, { flexDirection: visualRow(rtl) }]}
            >
              <RotateCcw size={13} color={colors.textSecondary} strokeWidth={2} />
              <Text style={[styles.retryLabel, { color: colors.textSecondary }]}>
                {t("chat.tryAgain", { defaultValue: "Try again" })}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  // ——— The assistant ———
  return (
    <View style={styles.aiRow}>
      {item.thinking ? (
        <ThinkingTrace
          text={item.thinking}
          streaming={thinkingActive}
          durationMs={deriveThinkingMs(item)}
          dividerBelow={hasContent}
          rtl={rtl}
          // The answer sits on the page now, not in a tinted card — so the live
          // window's top fade has to blend into the page.
          surfaceColor={colors.bgPrimary}
        />
      ) : null}
      {hasContent ? (
        // Markdown renders live while streaming too — <Markdown streaming> re-parses
        // on a timer instead of per token, so headings/tables/lists appear as they
        // are written without the O(n²) re-lex that made per-token parsing janky.
        <View style={collapsed ? styles.collapsedWrap : undefined}>
          <Markdown content={bodyText} color={colors.textPrimary} direction={dir} streaming={isStreaming} onBlockPress={onBlockPress} />
          {collapsed && <FadeOverlay color={colors.bgPrimary} />}
        </View>
      ) : null}
      {/* The turn is still running but nothing has streamed for a while — the
          AI is off running tools (reading the source .docx, writing blocks).
          Mounted for the whole live turn; it stays invisible until the stream
          actually goes quiet. */}
      {isLiveTurn && <AiWorkingNote rtl={rtl} />}
      {files.length > 0 && (
        <View style={[styles.fileCards, hasContent && styles.fileCardsSpaced]}>
          {files.map((f, i) => (
            <FileCard key={(f.url || "file") + i} file={f} onPress={() => onPreviewFile?.(f)} />
          ))}
        </View>
      )}
      {/* Plan mode: what Kwill proposes to do, and the tap that starts it. Sits
          under the prose that introduced it, like the file cards.

          Withheld until the turn has ENDED, like the action row below. A plan is
          the turn's last word, so the wait is a moment — and executing one takes
          the floor from whatever turn is still running, which is not what a
          student tapping "Execute" is asking for. It also keeps the card's
          own double-tap latch out of a state it cannot leave: the latch closes on
          the press and only reopens when a run it started has ended. */}
      {!isStreaming && plans.length > 0 && (
        <View style={[styles.planCards, hasContent && styles.fileCardsSpaced]}>
          {plans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              rtl={rtl}
              running={runningPlanId === p.id}
              done={donePlanIds.includes(p.id)}
              ticks={planSteps[p.id] ?? NO_TICKS}
              onExecute={() => onExecutePlan?.(p.id)}
              onAskChanges={() => onAskPlanChanges?.()}
            />
          ))}
        </View>
      )}
      {/* Nothing to act on while the answer is still arriving, and nothing to
          copy or read aloud from a turn that produced no text. */}
      {!isStreaming && (hasContent || canRegenerate) && (
        <MessageActions
          text={bodyText}
          rtl={rtl}
          canExpand={isLong}
          expanded={expanded}
          onToggleExpand={() => setExpanded((e) => !e)}
          onViewFull={() => onExpand?.(item.content)}
          canRegenerate={canRegenerate}
          onRegenerate={onRegenerate}
        />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  // The student's column: pill at the reading end, retry underneath it. `flex-end`
  // is direction-relative, so RN's own mirroring puts it on the correct side in
  // an Arabic UI without a second flip here (see lib/rtl-layout).
  userRow: { alignItems: "flex-end" },
  userBubble: { maxWidth: "84%", borderRadius: 22, paddingHorizontal: 16, paddingVertical: 11 },
  // The answer owns the full width of the list.
  aiRow: { width: "100%" },
  messageText: { fontSize: 15, fontFamily: "Inter_400Regular", lineHeight: 23 },
  collapsedWrap: { maxHeight: COLLAPSED_HEIGHT, overflow: "hidden" },
  fadeOverlay: { position: "absolute", left: 0, right: 0, bottom: 0, justifyContent: "flex-end" },
  bubbleImagesSpaced: { marginBottom: 8 },
  fileCards: { gap: 8 },
  planCards: { gap: 8 },
  fileCardsSpaced: { marginTop: 10 },
  retryRow: { alignItems: "center", columnGap: 14, marginTop: 6, paddingHorizontal: 2 },
  retryItem: { alignItems: "center", columnGap: 5 },
  retryLabel: { fontSize: 12, fontFamily: "Inter_500Medium" },
});
