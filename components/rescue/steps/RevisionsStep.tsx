import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import * as DocumentPicker from "expo-document-picker";
import { useTranslation } from "react-i18next";
import { NoteChips } from "@/components/rescue/NoteChips";
import { PageCarousel } from "@/components/rescue/PageCarousel";
import { Pill, SheetBody, SheetTitle, WashCard } from "@/components/rescue/ui";
import { VoiceMic } from "@/components/rescue/VoiceMic";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { ackVersion, getImpact, removeNoteChip, requestRescueReview, resolveNoteConflict, sendNote } from "@/lib/rescue-v2-api";
import { keepDocx, partsRefusal } from "@/lib/rescue-v2-pick";
import { STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { recognizerLang } from "@/lib/voice";
import { NO_FILES, useRevisionsUi } from "@/stores/rescue-revisions-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueStep } from "./index";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** `not_same_thesis` (P-57): the one case where this screen is a failure. Its sheet offers the review and the new start, and no re-run. */
function isForced(project: { phase: string; failure: { code: string } | null } | null): boolean {
  return project?.phase === "failed" && project.failure?.code === "not_same_thesis";
}

/** The dictation language for the note: the thesis' own, else the device's. */
function dictationLang(language: "ar" | "fr" | "en" | null): string {
  if (language === "ar") return "ar-SA";
  if (language === "fr") return "fr-FR";
  if (language === "en") return "en-US";
  return recognizerLang();
}

/** Screen 17, the stage: the current version, the middle page outlined in brand. */
function Stage() {
  const colors = useThemeColors();
  const versionId = useRescueV2Store((s) => s.project?.currentVersion?.id ?? null);
  const layout = STAGE_LAYOUT.revisions;
  if (!versionId || layout.kind !== "three") return null;
  return (
    <View style={styles.stage}>
      <PageCarousel
        versionId={versionId}
        page={2}
        layout={layout}
        midDecor={<View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.outline, { borderColor: colors.brandPrimary }]} />}
      />
    </View>
  );
}

/** Screen 17's sheet. Keyed by the project, so the note being typed and the chosen files never carry to another project. */
function Sheet() {
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  return <RevisionsSheet key={id ?? "none"} />;
}

function RevisionsSheet() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const project = useRescueV2Store((s) => s.project);
  const config = useRescueV2Store((s) => s.config);
  const apply = useRescueV2Store((s) => s.apply);
  const id = project?.id ?? null;
  const forced = isForced(project);
  const files = useRevisionsUi((s) => (s.key === id ? s.files : NO_FILES));
  const ensure = useRevisionsUi((s) => s.ensure);
  const setFiles = useRevisionsUi((s) => s.setFiles);
  const rtl = useRescueV2Store((s) => thesisIsRtl(s.project));
  const language = useRescueV2Store((s) => s.project?.language ?? null);
  const [note, setNote] = useState("");
  const [focused, setFocused] = useState(false);
  const [pickNotice, setPickNotice] = useState<string | null>(null);
  const [impact, setImpact] = useState<{ state: "loading" | "ok" | "failed"; pages: number }>({ state: "loading", pages: 0 });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const gate = useRef(false);
  // The text last sent, so a blur with nothing new sends nothing.
  const sent = useRef("");

  useEffect(() => { if (id) ensure(id); }, [id, ensure]);

  // The changed pages, asked only when the student edited in Kwill and chose no file (the file wins otherwise, P-67).
  const needImpact = !!project?.editedInKwill && files.length === 0 && !forced;
  useEffect(() => {
    if (!id || !needImpact) return;
    let alive = true;
    setImpact({ state: "loading", pages: 0 });
    getImpact(id).then(
      (r) => { if (alive) setImpact({ state: "ok", pages: r.pages.length }); },
      () => { if (alive) setImpact({ state: "failed", pages: 0 }); },
    );
    return () => { alive = false; };
  }, [id, needImpact, attempt]);

  if (!project || !id) return null;
  const align = { textAlign: visualTextAlign(isRTL) };
  const noteDto = project.note;
  const pickFiles = async () => {
    if (gate.current) return;
    gate.current = true;
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: [DOCX_MIME], multiple: true, copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.length) return;
      const picked = keepDocx(res.assets.map((a) => ({ uri: a.uri, name: a.name, size: a.size ?? 0 })));
      if (picked.length === 0) { setPickNotice(t("rescueV2.start.notDocx")); return; }
      const refusal = config ? partsRefusal(picked, config.limits) : null;
      if (refusal?.key === "tooMany") { setPickNotice(t("rescueV2.start.tooMany")); return; }
      if (refusal?.key === "tooLarge") { setPickNotice(t("rescueV2.start.tooLarge", { mb: refusal.mb })); return; }
      setPickNotice(null);
      setFiles(id, picked);
    } catch {
      setPickNotice(t("rescueV2.common.somethingWrong"));
    } finally {
      gate.current = false;
    }
  };

  // A changed note is sent when the field loses focus. Nothing typed, or nothing new, sends nothing.
  const saveNote = () => {
    setFocused(false);
    const text = note.trim();
    if (!text || text === sent.current) return;
    sent.current = text;
    void apply(() => sendNote(id, text, "supervisor"));
  };

  const dictate = (chunk: string) => setNote((prev) => (prev.trim() ? `${prev.trimEnd()} ${chunk}` : chunk));

  const withLock = async (call: () => Promise<unknown>) => {
    if (gate.current) return;
    gate.current = true;
    setPending(true);
    try { await call(); } finally { gate.current = false; setPending(false); }
  };

  const removeChip = (chipId: string) => withLock(() => apply(() => removeNoteChip(id, chipId)));
  const resolve = (conflictId: string, choice: "note" | "guide") => withLock(() => apply(() => resolveNoteConflict(id, conflictId, choice)));

  const failure = project.failure;
  const askReview = () => {
    if (!failure) return;
    void withLock(() => apply(() => requestRescueReview(failure.versionId)));
  };
  const startNew = () => {
    if (!failure) return;
    // Acknowledged on the server first; only then is the local project let go, so a failed acknowledgement stays on the error line.
    void withLock(async () => {
      const ok = await apply(() => ackVersion(failure.versionId));
      if (ok) useRescueV2Store.getState().reset();
    });
  };

  if (forced && failure) {
    return (
      <>
        <SheetTitle>{t("rescueV2.revisions.title")}</SheetTitle>
        <WashCard><Text style={[styles.wash, { color: colors.textPrimary }, align]}>{t("rescueV2.revisions.differentThesis")}</Text></WashCard>
        {failure.reviewRequested ? (
          <SheetBody>{t("rescueV2.revisions.reviewSent")}</SheetBody>
        ) : failure.reviewable ? (
          <Button title={t("rescueV2.revisions.askReview")} variant="secondary" loading={pending} disabled={pending} onPress={askReview} />
        ) : null}
        <TouchableOpacity accessibilityRole="button" disabled={pending} onPress={startNew} hitSlop={8} style={styles.link}>
          <Text style={[styles.linkText, { color: colors.brandPrimary }, align]}>{t("rescueV2.revisions.startNew")}</Text>
        </TouchableOpacity>
      </>
    );
  }

  const lang = dictationLang(language);
  return (
    <>
      <View style={[styles.titleRow, { flexDirection: visualRow(isRTL) }]}>
        <Text style={[styles.title, { color: colors.textPrimary }, align]}>{t("rescueV2.revisions.title")}</Text>
        {!PURCHASES_HIDDEN ? <Pill label={t("rescueV2.revisions.free")} /> : null}
      </View>
      <SheetBody>{t("rescueV2.revisions.body")}</SheetBody>

      {project.editedInKwill ? (
        files.length > 0 ? (
          <SheetBody>{t("rescueV2.revisions.editedNotInFile")}</SheetBody>
        ) : impact.state === "ok" ? (
          <>
            <SheetBody>{t("rescueV2.revisions.editedInKwill")}</SheetBody>
            {impact.pages > 0 ? <Text style={[styles.count, { color: colors.textPrimary }, align]}>{t("rescueV2.revisions.changedPages", { count: impact.pages })}</Text> : null}
          </>
        ) : impact.state === "failed" ? (
          <TouchableOpacity accessibilityRole="button" onPress={() => setAttempt((a) => a + 1)} hitSlop={8} style={styles.link}>
            <Text style={[styles.linkText, { color: colors.brandPrimary }, align]}>{t("rescueV2.common.somethingWrong")} · {t("rescueV2.common.retry")}</Text>
          </TouchableOpacity>
        ) : null
      ) : null}

      <TouchableOpacity
        accessibilityRole="button"
        disabled={pending}
        onPress={() => { void pickFiles(); }}
        style={[styles.pick, { borderColor: colors.borderDefault, backgroundColor: colors.bgSurface }]}
      >
        <Text style={[styles.pickText, { color: colors.brandPrimary }, align]}>{t("rescueV2.revisions.pickFile")}</Text>
        {files.length > 0 ? (
          <Text style={[styles.chosen, { color: colors.textPrimary }, align]}>{t("rescueV2.revisions.fileChosen", { name: files.map((f) => f.name).join(" · ") })}</Text>
        ) : null}
      </TouchableOpacity>
      {pickNotice ? <Text style={[styles.notice, { color: colors.semanticError }, align]}>{pickNotice}</Text> : null}

      <SheetTitle>{t("rescueV2.revisions.supervisorLabel")}</SheetTitle>
      <View style={[styles.box, { borderColor: focused ? colors.brandPrimary : colors.borderDefault, backgroundColor: colors.bgInput }]}>
        <BottomSheetTextInput
          multiline
          value={note}
          onChangeText={setNote}
          onFocus={() => setFocused(true)}
          onBlur={saveNote}
          placeholder={t("rescueV2.revisions.supervisorPlaceholder")}
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.input, { color: colors.textPrimary, textAlign: visualTextAlign(rtl), writingDirection: rtl ? "rtl" : "ltr" }]}
        />
        <View style={[styles.micRow, { flexDirection: visualRow(isRTL) }]}>
          <VoiceMic lang={lang} onText={dictate} disabled={pending || noteDto.state === "parsing"} />
        </View>
      </View>
      <NoteChips
        chips={noteDto.chips}
        refused={noteDto.refused}
        conflicts={noteDto.conflicts}
        busy={pending}
        onRemove={(cid) => { void removeChip(cid); }}
        onResolve={(cid, choice) => { void resolve(cid, choice); }}
      />

      <Pill label={t("rescueV2.revisions.keepAnswers")} tone="success" />
    </>
  );
}

/**
 * The CTA: a changed-files re-run (or a re-run on the same files for the auto source). Disabled while a note is read or a conflict is open,
 * with the reason beneath. While the upload runs, the bar replaces the CTA: the sheet stays here (P-66).
 */
function Foot() {
  const id = useRescueV2Store((s) => s.project?.id ?? null);
  return <RevisionsFoot key={id ?? "none"} />;
}

function RevisionsFoot() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const project = useRescueV2Store((s) => s.project);
  const upload = useRescueV2Store((s) => s.upload);
  const errorCode = useRescueV2Store((s) => s.errorCode);
  const beginRerun = useRescueV2Store((s) => s.beginRerun);
  const busy = useRevisionsUi((s) => s.busy);
  const id = project?.id ?? null;
  const files = useRevisionsUi((s) => (s.key === id ? s.files : NO_FILES));
  if (!project || isForced(project)) return null;

  if (project.phase === "uploading") {
    const fraction = upload?.fraction ?? 0;
    return (
      <View style={styles.foot}>
        <Text style={[styles.reason, { color: colors.textSecondary }]}>{t("rescueV2.reading.stepUpload")}</Text>
        <View style={[styles.track, { backgroundColor: colors.borderSubtle }]}>
          <View style={[styles.fill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: colors.brandPrimary }]} />
        </View>
      </View>
    );
  }

  const parsing = project.note.state === "parsing";
  const openConflict = project.note.conflicts.some((c) => c.choice === null);
  const blocked = parsing || openConflict || busy;
  const reason = errorCode === "rescue_rerun_expired" ? t("rescueV2.revisions.expired")
    : errorCode === "rescue_rerun_daily_cap" ? t("rescueV2.revisions.dailyCap")
    : openConflict ? t("rescueV2.notes.pickOne")
    : parsing ? t("rescueV2.notes.parsing")
    : null;

  const run = async () => {
    const ui = useRevisionsUi.getState();
    if (!ui.begin()) return;
    try {
      // The files as they are now, not as this render saw them: a pick may have landed since.
      await beginRerun(useRevisionsUi.getState().files);
    } finally {
      useRevisionsUi.getState().end();
    }
  };

  return (
    <View style={styles.foot}>
      {reason ? <Text style={[styles.reason, { color: colors.semanticWarning }]}>{reason}</Text> : null}
      <Button title={t(PURCHASES_HIDDEN ? "rescueV2.revisions.ctaStatus" : "rescueV2.revisions.cta")} onPress={() => { void run(); }} loading={busy} disabled={blocked} />
    </View>
  );
}

export const RevisionsStep: RescueStep = { Stage, Sheet, Foot, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  outline: { borderWidth: 2, borderRadius: 4 },
  titleRow: { alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" },
  title: { fontSize: 22, fontWeight: "800", lineHeight: 28 },
  count: { fontSize: 14, fontWeight: "700", marginBottom: 10 },
  wash: { fontSize: 14, lineHeight: 20 },
  link: { alignSelf: "flex-start", paddingVertical: 8, marginBottom: 8 },
  linkText: { fontSize: 14, fontWeight: "700" },
  pick: { borderWidth: 1.5, borderStyle: "dashed", borderRadius: 16, padding: 14, marginBottom: 12, gap: 4 },
  pickText: { fontSize: 15, fontWeight: "700" },
  chosen: { fontSize: 13, lineHeight: 18 },
  notice: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
  box: { borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 12, minHeight: 96 },
  input: { fontSize: 15, lineHeight: 22, minHeight: 56, textAlignVertical: "top" },
  micRow: { justifyContent: "flex-end", marginTop: 6 },
  foot: { gap: 8, paddingBottom: 10 },
  reason: { fontSize: 13, lineHeight: 18, textAlign: "center" },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
});
