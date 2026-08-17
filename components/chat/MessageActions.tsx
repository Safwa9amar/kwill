import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  View,
  Text,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  useWindowDimensions,
  type GestureResponderEvent,
} from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  Library,
  ListChecks,
  Maximize2,
  MoreHorizontal,
  RotateCcw,
  Share2,
  type LucideIcon,
} from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useChatThreadsStore } from "@/stores/chat-threads-store";
import { useThesisStore } from "@/stores/thesis-store";
import { useZoomOriginStore } from "@/stores/zoom-origin-store";
import { exportThesis } from "@/lib/api";
import { downloadExport } from "@/lib/download-export";
import { visualRow } from "@/lib/rtl-layout";
import { TASKS_ENABLED } from "@/lib/tasks-enabled";

// ─────────────────────────────────────────────────────────────────────────────
// The row under a finished assistant answer.
//
// TWO JOBS, in this order, kept apart by a hairline:
//
//   1. WHERE TO GO — the Writer, the Library, the student's Tasks. Labelled
//      chips, first in the row, because they are why the row is worth its space:
//      these are the app's three destinations and the conversation is its front
//      door. They used to live in the drawer, which put every trip to the
//      document behind a swipe.
//   2. WHAT TO DO WITH THIS ANSWER — share, expand, regenerate. Bare glyphs,
//      after the rule, in the quiet way every assistant app draws them.
//
// The chips are labelled and the glyphs are not, deliberately: an unlabelled
// document icon sitting next to Share reads as one more thing to do to the text
// rather than a place to go.
//
// Copy and read-aloud were here and are gone — the row could not hold eight
// controls on a phone, and between them and the three destinations the
// destinations are what a student reaches for. Sharing still hands over the
// text, which is what copying was mostly used for.
//
// Every control does something REAL. Writer and Tasks are simply ABSENT when
// there is no thesis to open, rather than present and dead.
// ─────────────────────────────────────────────────────────────────────────────

const ICON = 17;
const CHIP_ICON = 13;

/** One borderless icon button. Generous hit slop — the glyphs are small. */
function ActionIcon({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label}>
      {children}
    </Pressable>
  );
}

/**
 * One destination. A STATIC style array — never `style={({pressed}) => …}`,
 * which under the New Architecture can silently apply nothing and leave the chip
 * as a borderless glyph stacked on its own label.
 */
function DestinationChip({
  label,
  icon: Icon,
  onPress,
  rtl,
  colors,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  rtl: boolean;
  colors: ReturnType<typeof useThemeColors>;
}) {
  return (
    <Pressable
      // The tap point is left in the store BEFORE navigating, so the screen being
      // pushed can grow out of the thumb that opened it (see ZoomFromOrigin).
      // `pageX/pageY` off the press event rather than measuring this chip:
      // measurement is async and would land after the push, and the finger is a
      // truer origin than the button's centre anyway.
      onPress={(e) => {
        useZoomOriginStore.getState().setOrigin(e.nativeEvent.pageX, e.nativeEvent.pageY);
        onPress();
      }}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.chip, { borderColor: colors.borderDefault, flexDirection: visualRow(rtl) }]}
    >
      <Icon size={CHIP_ICON} color={colors.brandPrimary} strokeWidth={2} />
      <Text style={[styles.chipLabel, { color: colors.textPrimary }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

interface Props {
  /** The answer's text — what share hands over. */
  text: string;
  /** Direction of THIS message, so the row reads the way the answer does. */
  rtl?: boolean;
  /** Long answers collapse; these drive the inline expand and the full-screen viewer. */
  canExpand?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onViewFull?: () => void;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
}

export function MessageActions({
  text,
  rtl,
  canExpand,
  expanded,
  onToggleExpand,
  onViewFull,
  canRegenerate,
  onRegenerate,
}: Props) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const pathname = usePathname();
  // The thesis the CONVERSATION is about.
  //
  // The THREAD's own attachment answers this, not the app-wide selection. A
  // thread records what it is attached to on the server, and that is the whole
  // question here — is there a document this answer was written about? Reading
  // the selection alone made the chip depend on a second piece of state that
  // every path had to remember to move in step, and the one that forgot (attach
  // a thesis to a running conversation) left the student holding an answer about
  // a document with no way to open it.
  //
  // The selection is kept as a fallback for the window before the row lands: an
  // attachment is optimistic on the tap, and the PATCH that puts `thesisId` on
  // the thread row takes a round-trip to come back.
  const threadThesisId = useChatThreadsStore((s) => {
    const id = s.currentThreadId;
    return id ? s.threads.find((th) => th.id === id)?.thesisId ?? null : null;
  });
  const selectedThesisId = useThesisStore((s) => s.currentThesisId);
  const thesisId = threadThesisId ?? selectedThesisId;
  // Names the downloaded file. The server sends a filename of its own, but the
  // student's title is the one they will recognise in their Downloads folder —
  // safeFilename strips the bidi marks an Arabic title arrives with.
  const title = useThesisStore((s) => s.theses.find((th) => th.id === thesisId)?.title);
  // A .docx render is a server round-trip of a few seconds, and the popup has
  // already closed by then — so the spinner replaces the glyph that was tapped,
  // which is where the student is still looking.
  const [exporting, setExporting] = useState(false);
  // This row is also rendered by the floating chat overlay, which can sit ON TOP
  // of the Writer. Offering "Writer" there would push a second copy of the screen
  // the student is already looking at.
  const onWriter = pathname.includes("thesis-workspace");
  // The ⋯ glyph's screen rect, measured at press time. Non-null IS the popup's
  // open state — one value rather than a boolean plus a rect that could disagree.
  const moreRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  /**
   * Export the thesis as it stands and hand the file to the OS.
   *
   * A fresh export on every tap, deliberately. The .docx is rendered from the
   * document's current state, and the reason this lives under an answer is that
   * the answer has very likely just changed it — reusing an earlier URL would
   * save a few seconds and hand back the thesis from before the edit. (The
   * server's links are signed for an hour anyway, so an old one would refuse.)
   *
   * Until now the only way to get the file was to ASK for it and tap the card
   * that came back. That works, but it makes downloading your own thesis a thing
   * you have to know the phrasing for.
   */
  async function handleDownload() {
    if (!thesisId || exporting) return;
    setExporting(true);
    try {
      const built = await exportThesis(thesisId);
      await downloadExport({ url: built.url, filename: built.filename, format: built.format, title });
    } catch {
      // Either the render failed or the share sheet is unavailable. Both leave
      // the student with no file, which is the only part they can act on.
      Alert.alert(t("common.error"), t("preview.downloadFailed"));
    } finally {
      setExporting(false);
    }
  }

  async function handleShare() {
    try {
      // The share SHEET, not a file: an answer is text, and the student is
      // usually sending it to a supervisor in whatever app they already use.
      await Share.share({ message: text });
    } catch {
      // Dismissed, or no share target. Nothing to say.
    }
  }

  const ink = colors.textSecondary;

  // Both destinations are the SAME document, so they come and go together. The
  // Library looked like the exception — it is always on the drawer — but the
  // screen is thesis-scoped end to end: with nothing attached it renders "pick a
  // thesis" and an empty list. Offering it under an answer in an unattached chat
  // was a door onto an empty room, immediately after the answer had explained
  // there is no document yet.
  const hasDestinations = !!thesisId;

  return (
    <View style={[styles.row, { flexDirection: visualRow(!!rtl) }]}>
      {/* The destinations are ONE cluster, tighter inside than the row's own gap.
          Spaced like the glyphs they'd read as unrelated buttons that happen to be
          adjacent; pulled together they read as the set they are.

          Only the two a student reaches for mid-answer are out here. Tasks is a
          place you go deliberately, not something you glance at while reading a
          reply, so it moved into the ⋯ menu with the other second thoughts. */}
      {hasDestinations && (
        <View style={[styles.cluster, { flexDirection: visualRow(!!rtl) }]}>
          {!onWriter && (
            <DestinationChip
              label={t("drawer.writer")}
              icon={FileText}
              rtl={!!rtl}
              colors={colors}
              onPress={() =>
                router.push({ pathname: "/(app)/thesis-workspace", params: { thesisId } } as any)
              }
            />
          )}

          <DestinationChip
            label={t("drawer.library")}
            icon={Library}
            rtl={!!rtl}
            colors={colors}
            onPress={() => router.push("/(app)/library" as any)}
          />
        </View>
      )}

      {/* The hairline is what makes the two halves legible as two halves: go
          somewhere, or act on this answer. With nowhere to go there are no two
          halves — a rule leading the row would read as a stray mark. */}
      {hasDestinations && <View style={[styles.rule, { backgroundColor: colors.borderSubtle }]} />}

      {canExpand && (
        <>
          <ActionIcon
            label={expanded ? t("chat.showLess", { defaultValue: "Show less" }) : t("chat.viewMore", { defaultValue: "View more" })}
            onPress={() => onToggleExpand?.()}
          >
            {expanded ? (
              <ChevronUp size={ICON + 1} color={ink} strokeWidth={1.9} />
            ) : (
              <ChevronDown size={ICON + 1} color={ink} strokeWidth={1.9} />
            )}
          </ActionIcon>
        </>
      )}

      {canRegenerate && (
        <ActionIcon label={t("chat.regenerate", { defaultValue: "Regenerate" })} onPress={() => onRegenerate?.()}>
          <RotateCcw size={ICON} color={ink} strokeWidth={1.9} />
        </ActionIcon>
      )}

      {/* Everything a student wants OCCASIONALLY. Sharing an answer, blowing it up
          to full screen and opening the task list are all real, and all rare next
          to reading the reply — out on the row they cost permanent width and made
          the row wrap on a narrow phone.

          Measured on press rather than on layout: this row lives in a scrolling
          transcript, so where the glyph WAS at layout time is not where it is when
          the finger lands. `measureInWindow` answers in screen coordinates, which
          is the frame the popup is positioned in. */}
      <Pressable
        ref={moreRef}
        onPress={() => {
          moreRef.current?.measureInWindow((x, y, w, h) => setAnchor({ x, y, w, h }));
        }}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={
          exporting
            ? t("preview.download", { defaultValue: "Download" })
            : t("chat.more", { defaultValue: "More" })
        }
      >
        {/* Sized to the glyph it stands in for, so the row does not reflow while
            the export renders. */}
        {exporting ? (
          <ActivityIndicator size="small" color={ink} style={{ width: ICON + 2, height: ICON + 2 }} />
        ) : (
          <MoreHorizontal size={ICON + 2} color={ink} strokeWidth={1.9} />
        )}
      </Pressable>

      <MorePopup
        anchor={anchor}
        onClose={() => setAnchor(null)}
        rtl={!!rtl}
        colors={colors}
        items={[
          {
            key: "share",
            label: t("chat.share", { defaultValue: "Share" }),
            icon: Share2,
            onPress: () => void handleShare(),
          },
          ...(canExpand
            ? [
                {
                  key: "full",
                  label: t("chat.viewFull", { defaultValue: "View full" }),
                  icon: Maximize2,
                  onPress: () => onViewFull?.(),
                },
              ]
            : []),
          // These need a document to act on, so they arrive with the thesis and
          // leave with it — the same rule the Kwiller and Library chips follow.
          ...(thesisId
            ? [
                // One row per format rather than a single "Download" that asks a
                // second question. Two of the three are not built yet and say so:
                // the export engine renders .docx, and PDF and LaTeX are named
                // here so the student can see they are coming instead of hunting
                // for a setting that does not exist.
                ...DOWNLOAD_FORMATS.map((f) => ({
                  key: `download-${f.format}`,
                  label: t("chat.downloadFormat", { format: f.label, defaultValue: `Download ${f.label}` }),
                  icon: Download,
                  disabled: !f.ready,
                  onPress: () => void handleDownload(),
                })),
                // Tasks — HIDDEN, not deleted (see lib/tasks-enabled.ts).
                ...(TASKS_ENABLED
                  ? [
                      {
                        key: "tasks",
                        label: t("tasks.title"),
                        icon: ListChecks,
                        onPress: (e: GestureResponderEvent) => {
                          // Same tap-point capture the chips do — Tasks grows out
                          // of the row that was pressed, here inside the popup.
                          useZoomOriginStore
                            .getState()
                            .setOrigin(e.nativeEvent.pageX, e.nativeEvent.pageY);
                          router.push({ pathname: "/(app)/tasks", params: { thesisId } } as any);
                        },
                      },
                    ]
                  : []),
              ]
            : []),
        ]}
      />
    </View>
  );
}

interface PopupItem {
  key: string;
  label: string;
  icon: LucideIcon;
  onPress: (e: GestureResponderEvent) => void;
  /** Shown, dimmed, with a "soon" badge, and inert. A format the export engine
   *  cannot produce yet is worth NAMING — it tells the student the shape of what
   *  is coming and stops them hunting for it — but it must not look tappable. */
  disabled?: boolean;
}

// What the student can take the thesis away as.
//
// `ready` is the honest state of the EXPORT ENGINE, not a feature flag: only the
// .docx renderer exists (POST /api/export). A PDF is produced elsewhere for the
// page view (OnlyOffice) but is not wired to a download, and LaTeX has a format
// argument on the endpoint and nothing behind it — so both are named and
// disabled rather than offered and then failing in the student's hands.
const DOWNLOAD_FORMATS: { format: "docx" | "pdf" | "latex"; label: string; ready: boolean }[] = [
  { format: "docx", label: "Word (.docx)", ready: true },
  { format: "pdf", label: "PDF", ready: false },
  { format: "latex", label: "LaTeX", ready: false },
];

// Popup geometry. ROW_H has to match the row's real height or the flip-above
// calculation lands the card in the wrong place — it is the one number here that
// is a measurement rather than a taste.
//
// Widened for the download rows: "Télécharger Word (.docx)" beside a soon badge
// does not fit the old 196, and the label truncates rather than wrapping.
const POPUP_W = 244;
const POPUP_ROW_H = 44;
const POPUP_PAD = 6;
const POPUP_GAP = 6;
const SCREEN_MARGIN = 12;

/**
 * The ⋯ menu: a small card ANCHORED TO THE GLYPH, not a sheet at the bottom of
 * the screen. A sheet makes a three-item menu feel like a decision; a popup that
 * opens where the thumb already is reads as the button unfolding, and keeps the
 * answer it belongs to in view behind it.
 *
 * A transparent Modal is still the host — it is the only way to draw above the
 * transcript's own stacking context and to catch the outside tap — but nothing
 * about it is sheet-shaped.
 */
function MorePopup({
  anchor,
  items,
  onClose,
  rtl,
  colors,
}: {
  anchor: { x: number; y: number; w: number; h: number } | null;
  items: PopupItem[];
  onClose: () => void;
  rtl: boolean;
  colors: ReturnType<typeof useThemeColors>;
}) {
  const { t } = useTranslation();
  const { width: screenW, height: screenH } = useWindowDimensions();
  if (!anchor) return null;

  const height = items.length * POPUP_ROW_H + POPUP_PAD * 2;
  // Below the glyph by default; above it when there is not enough room left —
  // which is the common case, since this row sits near the bottom of a transcript
  // that is scrolled to its end.
  const below = anchor.y + anchor.h + POPUP_GAP;
  const flip = below + height > screenH - SCREEN_MARGIN;
  const top = flip ? Math.max(SCREEN_MARGIN, anchor.y - height - POPUP_GAP) : below;

  // The card hangs from the glyph's own edge — its trailing edge in an LTR row,
  // its leading edge in RTL — then is clamped so it can never run off screen.
  const rawLeft = rtl ? anchor.x : anchor.x + anchor.w - POPUP_W;
  const left = Math.min(Math.max(SCREEN_MARGIN, rawLeft), screenW - POPUP_W - SCREEN_MARGIN);

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      {/* No scrim: the point of anchoring is that the answer stays visible. The
          backdrop is here only to catch the tap that dismisses. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <Pressable
          onPress={() => {}}
          style={[
            styles.popup,
            {
              top,
              left,
              backgroundColor: colors.bgModal,
              borderColor: colors.borderDefault,
            },
          ]}
        >
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <Pressable
                key={it.key}
                disabled={it.disabled}
                onPress={(e) => {
                  onClose();
                  it.onPress(e);
                }}
                accessibilityRole="button"
                accessibilityState={{ disabled: !!it.disabled }}
                accessibilityLabel={it.label}
                style={[styles.popupRow, { flexDirection: visualRow(rtl) }, it.disabled && styles.popupRowSoon]}
              >
                <Icon size={17} color={colors.textSecondary} strokeWidth={2} />
                <Text style={[styles.popupLabel, { color: colors.textPrimary }]} numberOfLines={1}>
                  {it.label}
                </Text>
                {it.disabled && (
                  <View style={[styles.popupSoon, { backgroundColor: colors.semanticWarning }]}>
                    <Text style={styles.popupSoonText}>{t("ribbon.soon", { defaultValue: "soon" })}</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // The row WRAPS rather than clipping or scrolling: three labelled chips plus
  // the glyphs outrun a narrow phone, and with the chips first it is the glyphs
  // that fall to the second line — the right way round. rowGap keeps that second
  // line off the one above it.
  row: {
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: 14,
    rowGap: 10,
    marginTop: 10,
    paddingVertical: 2,
  },
  // The chips sit half a row-gap apart. It wraps too, so the cluster degrades on
  // a very narrow phone instead of pushing the row sideways.
  cluster: { alignItems: "center", flexWrap: "wrap", columnGap: 7, rowGap: 8 },
  // Vertical hairline between the two halves. Negative margins against the row's
  // columnGap pull it closer to both sides than two taps ever are, so it reads as
  // a divider rather than as another control.
  rule: { width: StyleSheet.hairlineWidth, height: ICON, marginHorizontal: -4 },
  chip: { alignItems: "center", gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  chipLabel: { fontSize: 11.5, fontFamily: "Inter_600SemiBold" },

  // The ⋯ popup: a small card placed against the glyph, positioned in screen
  // coordinates by MorePopup. The border does the lifting off the transcript —
  // there is no scrim behind it, so a fill alone would float unanchored.
  popup: {
    position: "absolute",
    width: POPUP_W,
    paddingVertical: POPUP_PAD,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    // Android draws no shadow from shadow*; elevation also lifts it above the
    // transcript's own stacking.
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  popupRow: { alignItems: "center", gap: 12, height: POPUP_ROW_H, paddingHorizontal: 14 },
  // Dimmed as a whole, badge included: a full-strength "soon" pill on a faded row
  // reads as the one live thing in it.
  popupRowSoon: { opacity: 0.45 },
  popupLabel: { flex: 1, fontSize: 14.5, fontFamily: "Inter_500Medium" },
  // Matches the ribbon's soon badge — same idea, same shape, so a format that is
  // not ready looks the same wherever the student meets it.
  popupSoon: { paddingHorizontal: 5, paddingVertical: 1.5, borderRadius: 6 },
  popupSoonText: { fontSize: 8.5, fontFamily: "Inter_700Bold", color: "#1a1300", letterSpacing: 0.3 },
});
