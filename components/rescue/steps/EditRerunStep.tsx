import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { useTranslation } from "react-i18next";
import { Chip, ChipRow, SheetTitle } from "@/components/rescue/ui";
import { NoteChips } from "@/components/rescue/NoteChips";
import { PageCarousel } from "@/components/rescue/PageCarousel";
import { RuleRow, RuleSwitch, useRuleWords } from "@/components/rescue/RuleRow";
import { RulePickerSheet, openRulePicker } from "@/components/rescue/RulePickerSheet";
import { Button } from "@/components/ui/Button";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { PURCHASES_HIDDEN } from "@/lib/purchases";
import { getImpact, removeNoteChip, resolveNoteConflict, saveAnswer, sendNote } from "@/lib/rescue-v2-api";
import { coverLabelKey, groupRuleRows, missingRow, type RuleValue } from "@/lib/rescue-v2-confirm";
import { impactLines } from "@/lib/rescue-v2-history";
import { STAGE_LAYOUT } from "@/lib/rescue-v2-layout";
import { thesisIsRtl } from "@/lib/rescue-v2-screen";
import { visualRow, visualTextAlign } from "@/lib/rtl-layout";
import { firstStrongDirection } from "@/lib/text-direction";
import { useBottomSheet } from "@/stores/bottom-sheet-store";
import { NO_EDITS, useConfirmUi } from "@/stores/rescue-confirm-ui";
import { useHistoryUi } from "@/stores/rescue-history-ui";
import { useRescueV2Store } from "@/stores/rescue-v2-store";
import type { RescueRuleFieldDTO, RescueRuleFieldId } from "@/types/rescue-v2";
import { CoverStep } from "./CoverStep";
import { saveEdits } from "./RulesStep";
import type { RescueStep } from "./index";

type Section = "rules" | "notes" | "answers" | "cover";

let impactSeq = 0;

/**
 * Reads what the saved choices would redo. The server compares them with the last done version, so the answer survives leaving this screen.
 * The last request wins: a reply for another project, or one overtaken by a newer read, is dropped.
 */
export async function loadImpact(pid: string): Promise<void> {
  const seq = ++impactSeq;
  try {
    const value = await getImpact(pid);
    if (seq === impactSeq && useRescueV2Store.getState().projectId === pid) useHistoryUi.getState().setImpact(pid, "ok", value);
  } catch {
    if (seq === impactSeq && useRescueV2Store.getState().projectId === pid) useHistoryUi.getState().setImpact(pid, "failed", null);
  }
}

/** Screen H5's stage: three small pages of the current version, the first page the change touches outlined. */
function Stage() {
  const colors = useThemeColors();
  const pid = useRescueV2Store((s) => s.projectId);
  const versionId = useRescueV2Store((s) => s.project?.currentVersion?.id ?? null);
  const first = useHistoryUi((s) => (s.key === pid && s.impact.state === "ok" ? s.impact.value?.pages[0] ?? null : null));
  const layout = STAGE_LAYOUT.edit_rerun;
  if (!versionId || layout.kind !== "three") return null;
  return (
    <View style={styles.stage}>
      <PageCarousel
        versionId={versionId}
        page={first ?? 1}
        layout={layout}
        midDecor={first !== null ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.outline, { borderColor: colors.brandPrimary }]} /> : null}
      />
    </View>
  );
}

function Accordion({ title, summary, open, onToggle, children }: {
  title: string; summary: string; open: boolean; onToggle: () => void; children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  return (
    <View style={[styles.acc, { borderColor: colors.borderDefault }]}>
      <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle} hitSlop={6} style={[styles.hdr, { flexDirection: visualRow(isRTL) }]}>
        <View style={styles.hdrMain}>
          <Text style={[styles.accTitle, { color: colors.textPrimary, textAlign: visualTextAlign(isRTL) }]}>{title}</Text>
          {summary ? <Text numberOfLines={1} style={[styles.accSummary, { color: colors.textSecondary, textAlign: visualTextAlign(isRTL) }]}>{summary}</Text> : null}
        </View>
        <Text style={[styles.accEdit, { color: colors.brandPrimary }]}>{open ? t("rescueV2.editRerun.close") : t("rescueV2.editRerun.edit")}</Text>
      </TouchableOpacity>
      {open ? <View style={styles.accBody}>{children}</View> : null}
    </View>
  );
}

/** The rules as screen 10 shows them: the same rows, each into its picker. A value is saved as it is chosen. */
function RulesRows({ pid }: { pid: string }) {
  const { t } = useTranslation();
  const rules = useRescueV2Store((s) => s.project?.rules ?? null);
  const captions = useRescueV2Store((s) => s.project?.diagnosis?.captionNumbersToAdd ?? 0);
  const errorCode = useRescueV2Store((s) => s.errorCode);
  const errorInfo = useRescueV2Store((s) => s.errorInfo);
  const pending = useConfirmUi((s) => (s.key === pid ? s.rulesPending : NO_EDITS));
  const busy = useConfirmUi((s) => s.busy);
  const pickerRow = useConfirmUi((s) => (s.key === pid ? s.pickerRow : null));
  const setPickerRow = useConfirmUi((s) => s.setPickerRow);
  useEffect(() => { useConfirmUi.getState().ensure(pid); }, [pid]);
  if (!rules) return null;
  const shown: RescueRuleFieldDTO[] = rules.fields.map((f) => ({ ...f, value: pending[f.id] ?? f.value }));
  const groups = groupRuleRows(shown);
  const outOfRangeId = errorCode === "rule_out_of_range" ? (errorInfo?.fieldId as RescueRuleFieldId | undefined) ?? null : null;
  return (
    <>
      {groups.map((g) => g.row === "additions" ? (
        <View key="additions">
          {g.fields.map((f) => (
            <RuleSwitch
              key={f.id}
              field={f}
              value={f.value === true}
              disabled={busy}
              captionsToAdd={f.id === "captionNumbers" ? captions : undefined}
              onChange={(v) => { void saveEdits(pid, { [f.id]: v }); }}
            />
          ))}
        </View>
      ) : (
        <RuleRow key={g.row} row={g.row} fields={g.fields} onPress={() => openRulePicker(g.row, setPickerRow)} />
      ))}
      <RulePickerSheet
        row={pickerRow}
        fields={shown}
        busy={busy}
        outOfRangeId={outOfRangeId}
        onEdit={(fid, v: RuleValue) => { void saveEdits(pid, { [fid]: v }); }}
        onClose={() => { setPickerRow(null); useBottomSheet.getState().closeSheet("rescue-rule-picker"); }}
        onDismiss={() => setPickerRow(null)}
      />
    </>
  );
}

/**
 * The supervisor's note, as screen 17 takes it: typed, saved when the field loses focus, with the chips and conflicts beneath. A draft still
 * typed when the section closes is saved too, so no edit is dropped by collapsing it.
 */
function NotesEditor({ pid }: { pid: string }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const rtl = useRescueV2Store((s) => thesisIsRtl(s.project));
  const note = useRescueV2Store((s) => s.project?.note ?? null);
  const apply = useRescueV2Store((s) => s.apply);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState(false);
  const gate = useRef(false);
  const draftRef = useRef("");
  draftRef.current = draft;

  const send = async (text: string) => {
    if (!text || gate.current) return;
    gate.current = true;
    setPending(true);
    try {
      const ok = await apply(() => sendNote(pid, text, "supervisor"));
      if (ok && draftRef.current.trim() === text) setDraft("");
    } finally {
      gate.current = false;
      setPending(false);
    }
  };
  // Closing the section unmounts the field without a blur: the draft still typed goes now.
  useEffect(() => () => { const text = draftRef.current.trim(); if (text) void useRescueV2Store.getState().apply(() => sendNote(pid, text, "supervisor")); }, [pid]);

  const withLock = async (call: () => Promise<unknown>) => {
    if (gate.current) return;
    gate.current = true;
    setPending(true);
    try { await call(); } finally { gate.current = false; setPending(false); }
  };

  if (!note) return null;
  return (
    <>
      <View style={[styles.box, { borderColor: focused ? colors.brandPrimary : colors.borderDefault, backgroundColor: colors.bgInput }]}>
        <BottomSheetTextInput
          multiline
          editable={!pending}
          value={draft}
          onChangeText={setDraft}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); void send(draft.trim()); }}
          placeholder={t("rescueV2.revisions.supervisorPlaceholder")}
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.input, { color: colors.textPrimary, textAlign: visualTextAlign(rtl), writingDirection: rtl ? "rtl" : "ltr" }]}
        />
      </View>
      <NoteChips
        chips={note.chips}
        refused={note.refused}
        conflicts={note.conflicts}
        busy={pending}
        onRemove={(cid) => { void withLock(() => apply(() => removeNoteChip(pid, cid))); }}
        onResolve={(cid, choice) => { void withLock(() => apply(() => resolveNoteConflict(pid, cid, choice))); }}
      />
    </>
  );
}

/** Each answered question: its excerpt, its choice, and the other choices on tap. A choice is saved at once. */
function AnswersEditor({ pid }: { pid: string }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { isRTL } = useRTL();
  const questions = useRescueV2Store((s) => s.project?.questions ?? null);
  const apply = useRescueV2Store((s) => s.apply);
  const rtl = useRescueV2Store((s) => thesisIsRtl(s.project));
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!questions) return null;
  const answered = questions.filter((q) => q.answer !== null);

  const choose = async (key: string, answer: { role: string } | { decide: true }) => {
    const ui = useConfirmUi.getState();
    ui.ensure(pid);
    if (!ui.begin()) return;
    setBusy(true);
    try {
      const ok = await apply(() => saveAnswer(pid, key, answer));
      if (ok) setEditing(null);
    } finally {
      useConfirmUi.getState().end();
      setBusy(false);
    }
  };

  return (
    <>
      {answered.map((q) => {
        const a = q.answer;
        const decided = a !== null && "decide" in a;
        const chosen = a === null ? null : "decide" in a
          ? t("rescueV2.question.decide")
          : q.options.find((o) => o.role === a.role)?.label ?? null;
        const dir = firstStrongDirection(q.excerpt, rtl ? "rtl" : "ltr");
        return (
          <View key={q.key} style={[styles.answer, { borderColor: colors.borderSubtle }]}>
            <Text style={[styles.excerpt, { color: colors.textPrimary, textAlign: visualTextAlign(dir === "rtl"), writingDirection: dir }]}>{q.excerpt}</Text>
            <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => setEditing(editing === q.key ? null : q.key)} hitSlop={6}>
              <Text style={[styles.chosen, { color: colors.brandPrimary, textAlign: visualTextAlign(isRTL) }]}>{chosen ?? ""}</Text>
            </TouchableOpacity>
            {editing === q.key ? (
              <ChipRow>
                {q.options.map((o) => (
                  <Chip
                    key={o.role}
                    label={o.label}
                    selected={a !== null && !decided && "role" in a && a.role === o.role}
                    onPress={() => { if (!busy) void choose(q.key, { role: o.role }); }}
                  />
                ))}
                <Chip label={t("rescueV2.question.decide")} selected={decided} onPress={() => { if (!busy) void choose(q.key, { decide: true }); }} />
              </ChipRow>
            ) : null}
          </View>
        );
      })}
    </>
  );
}

/**
 * H5, the sheet: four sections of the saved choices. Rules, the note and the cover are the screens they came from (10, 17 and 12), so the
 * same rows and the same saves answer here. Every change is saved where it is made; the impact is read again after each one.
 */
function Sheet() {
  const pid = useRescueV2Store((s) => s.projectId);
  return <EditSheet key={pid ?? "none"} />;
}

function EditSheet() {
  const { t } = useTranslation();
  const words = useRuleWords();
  const project = useRescueV2Store((s) => s.project);
  const pid = project?.id ?? null;
  const [open, setOpen] = useState<Record<Section, boolean>>({ rules: false, notes: false, answers: false, cover: false });
  const toggle = (k: Section) => setOpen((o) => ({ ...o, [k]: !o[k] }));

  // The impact is read on opening and after each saved change (a 400 ms pause, so a run of taps reads once).
  useEffect(() => {
    if (!pid) return;
    const timer = setTimeout(() => { void loadImpact(pid); }, 400);
    return () => clearTimeout(timer);
  }, [pid, project]);

  if (!project || !pid) return null;
  const fields = project.rules?.fields ?? [];
  const field = (id: RescueRuleFieldId) => fields.find((f) => f.id === id);
  const rulesLine = (["bodyFont", "bodySize", "lineSpacing"] as RescueRuleFieldId[])
    .map((id) => field(id))
    .filter((f): f is RescueRuleFieldDTO => !!f)
    .map((f) => (f.kind === "enum" ? words.enumLabel(f.id, f.value) : String(f.value)))
    .join(" · ");
  const answeredCount = project.questions.filter((q) => q.answer !== null).length;
  const cover = project.cover;

  return (
    <>
      <SheetTitle>{t("rescueV2.editRerun.title")}</SheetTitle>
      {/* An accordion mounts its body only while it is open, so each section's effects run on opening. */}
      <Accordion title={t("rescueV2.editRerun.rules")} summary={rulesLine} open={open.rules} onToggle={() => toggle("rules")}>
        <RulesRows pid={pid} />
      </Accordion>
      <Accordion title={t("rescueV2.editRerun.notes")} summary={t("rescueV2.editRerun.notesCount", { count: project.note.count })} open={open.notes} onToggle={() => toggle("notes")}>
        <NotesEditor pid={pid} />
      </Accordion>
      <Accordion title={t("rescueV2.editRerun.answers")} summary={t("rescueV2.editRerun.answersCount", { count: answeredCount })} open={open.answers} onToggle={() => toggle("answers")}>
        <AnswersEditor pid={pid} />
      </Accordion>
      {cover ? (
        <Accordion title={t("rescueV2.editRerun.cover")} summary={t(`rescueV2.cover.${cover.choice ?? cover.defaultChoice}`)} open={open.cover} onToggle={() => toggle("cover")}>
          {/* Screen 12 itself: the choice, its sample pair and the field rows. Its own effects read the samples when it opens. */}
          {open.cover ? (
            <View>
              <CoverStep.Stage />
              <CoverStep.Sheet />
            </View>
          ) : null}
        </Accordion>
      ) : null}
    </>
  );
}

/**
 * The CTA: redo the thesis for free with the saved choices. Off only when nothing would change; disabled while the impact is read, so a tap
 * never starts a run on an answer not yet read. Fine print names the pages the change touches, or says nothing will change.
 */
function Foot() {
  const pid = useRescueV2Store((s) => s.projectId);
  return <EditFoot key={pid ?? "none"} />;
}

function EditFoot() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const pid = useRescueV2Store((s) => s.projectId);
  const project = useRescueV2Store((s) => s.project);
  const impact = useHistoryUi((s) => (s.key === pid ? s.impact : null));
  const errorCode = useRescueV2Store((s) => s.errorCode);
  const errorInfo = useRescueV2Store((s) => s.errorInfo);
  const beginRerun = useRescueV2Store((s) => s.beginRerun);
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  if (!project || !pid) return null;

  const value = impact?.value ?? null;
  const state = impact?.state ?? "loading";
  const blocked = busy || state === "loading" || value?.scope === "none";
  const sep = thesisIsRtl(project) ? "، " : ", ";
  const fine = value ? impactLines(value, sep).map((l) => t(`rescueV2.${l.key}`, l.params)).join(" ") : "";
  const missing = errorInfo?.missing ?? [];
  const missingRowId = errorCode === "cover_fields_missing" && missing.length > 0 ? missingRow(missing) : null;
  const reason = errorCode === "rescue_rerun_expired" ? t("rescueV2.revisions.expired")
    : errorCode === "rescue_rerun_daily_cap" ? t("rescueV2.revisions.dailyCap")
    : errorCode === "cover_fields_missing" ? (missingRowId ? t("rescueV2.cover.needed", { label: t(coverLabelKey(missingRowId)) }) : t("rescueV2.cover.titleMissing"))
    : null;

  const run = async () => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    try {
      await beginRerun([]);
    } finally {
      gate.current = false;
      setBusy(false);
    }
  };

  const retry = () => {
    useHistoryUi.getState().setImpact(pid, "loading", value);
    void loadImpact(pid);
  };

  return (
    <View style={styles.foot}>
      {state === "failed" ? (
        <TouchableOpacity accessibilityRole="button" onPress={retry} hitSlop={8}>
          <Text style={[styles.fine, { color: colors.brandPrimary }]}>{t("rescueV2.common.somethingWrong")} · {t("rescueV2.common.retry")}</Text>
        </TouchableOpacity>
      ) : null}
      {fine ? <Text style={[styles.fine, { color: colors.textPrimary }]}>{fine}</Text> : null}
      {value ? <Text style={[styles.fine, { color: colors.textSecondary }]}>{t("rescueV2.editRerun.nextVersion", { n: value.nextN })}</Text> : null}
      {reason ? <Text style={[styles.reason, { color: colors.semanticWarning }]}>{reason}</Text> : null}
      <Button
        title={t(PURCHASES_HIDDEN ? "rescueV2.editRerun.ctaStatus" : "rescueV2.editRerun.cta")}
        onPress={() => { void run(); }}
        loading={busy}
        disabled={blocked}
      />
    </View>
  );
}

export const EditRerunStep: RescueStep = { Stage, Sheet, Foot, scrollable: true };

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: "center", justifyContent: "center" },
  outline: { borderWidth: 2, borderRadius: 4 },
  acc: { borderWidth: 1, borderRadius: 16, marginBottom: 10, overflow: "hidden" },
  hdr: { alignItems: "center", gap: 10, padding: 14 },
  hdrMain: { flex: 1, gap: 2 },
  accTitle: { fontSize: 15, fontWeight: "700" },
  accSummary: { fontSize: 13 },
  accEdit: { fontSize: 13, fontWeight: "700" },
  accBody: { paddingHorizontal: 14, paddingBottom: 12 },
  box: { borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 10, minHeight: 72 },
  input: { fontSize: 15, lineHeight: 22, minHeight: 48, textAlignVertical: "top" },
  answer: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10, gap: 6 },
  excerpt: { fontSize: 14, lineHeight: 20 },
  chosen: { fontSize: 13, fontWeight: "700" },
  foot: { gap: 8, paddingBottom: 10 },
  fine: { fontSize: 13, lineHeight: 18, textAlign: "center" },
  reason: { fontSize: 13, lineHeight: 18, textAlign: "center" },
});
