import React, { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { hLight, hSelection } from "@/lib/haptics";
import { removeNoteChip, resolveNoteConflict, sendNote, startDiagnosis } from "@/lib/rescue-v2-api";
import { runNoteCta, waitForNote, type NoteReading } from "@/lib/rescue-v2-note-cta";
import { scaleFor, STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { visualTextAlign } from "@/lib/rtl-layout";
import { useRTL } from "@/hooks/useRTL";
import { getTextDirection } from "@/lib/text-direction";
import { recognizerLang } from "@/lib/voice";
import { useNoteDraft } from "@/stores/rescue-note-draft";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import { PageCarousel } from "../PageCarousel";
import { SkeletonPage } from "../SkeletonPage";
import { NoteChips } from "../NoteChips";
import { VoiceMic } from "../VoiceMic";
import { SheetTitle } from "../ui";
import type { RescueStep } from "./index";

const LANG_WORD: Record<string, string> = { "ar-SA": "rescueV2.common.langAr", "fr-FR": "rescueV2.common.langFr", "en-US": "rescueV2.common.langEn" };

/** Screen 5, the stage: three small pages of v0. */
function Stage() {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const s = scaleFor(width);
  const versionId = useRescueV2Store((st) => st.project?.originalVersionId ?? null);
  if (!versionId) {
    return (
      <View style={styles.stage}>
        <SkeletonPage width={42 * s} height={58 * s} />
        <SkeletonPage width={42 * s} height={58 * s} />
        <SkeletonPage width={42 * s} height={58 * s} />
      </View>
    );
  }
  return (
    <View style={[styles.stage, { backgroundColor: colors.rescueStageBottom }]}>
      <PageCarousel versionId={versionId} page={1} layout={STAGE_LAYOUT.notes} />
    </View>
  );
}

/** The dictation language the student is speaking: the thesis' own, unless they change it beside the mic. */
function defaultLang(language: "ar" | "fr" | "en" | null): string {
  if (language === "ar") return "ar-SA";
  if (language === "fr") return "fr-FR";
  if (language === "en") return "en-US";
  return recognizerLang();
}

function Sheet() {
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  return <NotesSheet key={id ?? "none"} />;
}

/** The note as the student writes it, the read-back chips, and the conflicts. A note is sent when the field loses focus, if it changed. */
function NotesSheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  const language = useRescueV2Store((s) => s.project?.language ?? null);
  const rtl = useRescueV2Store((s) => thesisIsRtl(s.project));
  const { isRTL: uiRtl } = useRTL();
  const note = useRescueV2Store((s) => s.project?.note ?? null);
  const apply = useRescueV2Store((s) => s.apply);
  const draftProject = useNoteDraft((d) => d.projectId);
  const draftText = useNoteDraft((d) => d.text);
  const draftLang = useNoteDraft((d) => d.lang);
  const setText = useNoteDraft((d) => d.setText);
  const setLang = useNoteDraft((d) => d.setLang);
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState(false);
  const removing = useRef(false);

  const saved = note?.text ?? "";
  const text = id && draftProject === id && draftText !== null ? draftText : saved;
  const options = language === "en" ? ["ar-SA", "fr-FR", "en-US"] : ["ar-SA", "fr-FR"];
  const lang = (id && draftProject === id && draftLang) || defaultLang(language);
  // Typed text sets the direction; an empty field shows the placeholder, which is in the UI's language, so it follows the UI.
  const dir = text.trim() ? getTextDirection(text, rtl ? "rtl" : "ltr") : uiRtl ? "rtl" : "ltr";

  const onChange = (value: string) => { if (id) setText(id, value); };
  const onBlur = () => {
    setFocused(false);
    if (!id || text === saved) return;
    void apply(() => sendNote(id, text, "start"));
  };
  const cycleLang = () => {
    if (!id) return;
    hSelection();
    const i = options.indexOf(lang);
    setLang(id, options[(i + 1) % options.length]);
  };
  const dictate = (chunk: string) => {
    if (!id) return;
    const next = text.trim() ? `${text.trimEnd()} ${chunk}` : chunk;
    setText(id, next);
  };
  const removeChip = async (chipId: string) => {
    if (removing.current || !id) return;
    removing.current = true;
    setPending(true);
    try { await apply(() => removeNoteChip(id, chipId)); } finally { removing.current = false; setPending(false); }
  };
  const resolve = async (conflictId: string, choice: "note" | "guide") => {
    if (removing.current || !id) return;
    hLight();
    removing.current = true;
    setPending(true);
    try { await apply(() => resolveNoteConflict(id, conflictId, choice)); } finally { removing.current = false; setPending(false); }
  };

  const parsing = note?.state === "parsing";
  const parseFailed = note?.state === "failed";

  return (
    <View>
      <SheetTitle>{t("rescueV2.notes.title")}</SheetTitle>

      <View style={[styles.box, { borderColor: focused ? colors.brandPrimary : colors.borderDefault, backgroundColor: colors.bgInput }]}>
        <BottomSheetTextInput
          multiline
          value={text}
          onChangeText={onChange}
          onFocus={() => setFocused(true)}
          onBlur={onBlur}
          placeholder={t("rescueV2.notes.placeholder")}
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.input, { color: colors.textPrimary, textAlign: visualTextAlign(dir === "rtl"), writingDirection: dir }]}
        />
        <View style={styles.micRow}>
          <Pressable accessibilityRole="button" onPress={cycleLang} hitSlop={6} style={[styles.langPill, { borderColor: colors.borderDefault }]}>
            <Text style={[styles.langText, { color: colors.textSecondary }]}>{t(LANG_WORD[lang] ?? "rescueV2.common.langFr")}</Text>
          </Pressable>
          <VoiceMic lang={lang} onText={dictate} disabled={parsing || pending} />
        </View>
      </View>

      {parsing ? <Text style={[styles.line, { color: colors.textSecondary, textAlign: visualTextAlign(uiRtl) }]}>{t("rescueV2.notes.parsing")}</Text> : null}
      {parseFailed ? <Text style={[styles.line, { color: colors.textSecondary, textAlign: visualTextAlign(uiRtl) }]}>{t("rescueV2.notes.parseFailed")}</Text> : null}

      {note ? (
        <NoteChips
          chips={note.chips}
          refused={note.refused}
          conflicts={note.conflicts}
          busy={pending}
          onRemove={(cid) => { void removeChip(cid); }}
          onResolve={(cid, choice) => { void resolve(cid, choice); }}
        />
      ) : null}
    </View>
  );
}

/** What the CTA reads from the store, now: the note's state and whether a conflict is open, for the project `pid`. */
function readNote(pid: string): NoteReading {
  const st = useRescueV2Store.getState();
  const note = st.project?.note;
  return {
    parsing: note?.state === "parsing",
    conflict: (note?.conflicts ?? []).some((c) => c.choice === null),
    live: st.projectId === pid,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The CTA sends a changed note, waits while it is read (the same words as the sheet's line, and the button stays busy), then starts the
 * diagnosis once. A conflict keeps the student here with the conflict buttons. Skip does the same: typed text is never dropped silently.
 * Disabled while the note is being read, while a conflict is open (with the reason beneath), and while the guide is still being read.
 */
function Foot() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  const note = useRescueV2Store((s) => s.project?.note ?? null);
  const guideState = useRescueV2Store((s) => s.project?.setup.guide.state ?? "none");
  const apply = useRescueV2Store((s) => s.apply);
  const draftProject = useNoteDraft((d) => d.projectId);
  const draftText = useNoteDraft((d) => d.text);
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const gate = useRef(false);

  const parsing = note?.state === "parsing";
  const openConflict = (note?.conflicts ?? []).some((c) => c.choice === null);
  const guideReading = guideState === "reading";
  const blocked = !id || parsing || openConflict || guideReading || pending;
  const reason = openConflict ? t("rescueV2.notes.pickOne") : guideReading ? t("rescueV2.notes.waitGuide") : null;

  const run = async () => {
    if (gate.current || blocked || !id) return;
    gate.current = true;
    setPending(true);
    try {
      // The latest values, not the ones this render saw: a blur-send may have landed since.
      const saved = useRescueV2Store.getState().project?.note?.text ?? "";
      const draft = useNoteDraft.getState();
      const text = draft.projectId === id && draft.text !== null ? draft.text : saved;
      await runNoteCta(text !== saved, {
        send: () => apply(() => sendNote(id, text, "start")),
        wait: async () => {
          setWaiting(true);
          return waitForNote({
            read: () => readNote(id),
            refresh: () => useRescueV2Store.getState().refresh(),
            sleep,
          });
        },
        start: () => apply(() => startDiagnosis(id)),
      });
    } finally {
      gate.current = false;
      setWaiting(false);
      setPending(false);
    }
  };

  return (
    <View style={styles.foot}>
      {reason ? <Text style={[styles.fine, { color: colors.semanticWarning }]}>{reason}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: blocked, busy: pending }}
        disabled={blocked}
        onPress={() => { void run(); }}
        style={[styles.cta, { backgroundColor: colors.brandPrimary, opacity: blocked ? 0.5 : 1 }]}
      >
        <Text style={[styles.ctaText, { color: colors.bgCard }]}>{t(waiting ? "rescueV2.notes.parsing" : "rescueV2.notes.cta")}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" disabled={blocked} onPress={() => { void run(); }} hitSlop={8} style={styles.skip}>
        <Text style={[styles.skipText, { color: colors.textSecondary, opacity: blocked ? 0.5 : 1 }]}>{t("rescueV2.notes.skip")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  box: { borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 10, minHeight: 120 },
  input: { fontSize: 15, lineHeight: 22, minHeight: 72, textAlignVertical: "top" },
  micRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 },
  langPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  langText: { fontSize: 12, fontWeight: "700" },
  line: { fontSize: 13, lineHeight: 18, marginBottom: 8 },
  foot: { gap: 6, paddingBottom: 10 },
  fine: { fontSize: 12, textAlign: "center" },
  cta: { height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  ctaText: { fontSize: 16, fontWeight: "800" },
  skip: { alignSelf: "center", paddingVertical: 4 },
  skipText: { fontSize: 13, textDecorationLine: "underline" },
});

export const NotesStep: RescueStep = { Stage, Sheet, Foot, scrollable: true };
