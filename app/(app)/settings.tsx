import { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Switch, Alert, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as FileSystem from "expo-file-system/legacy";
import { useTranslation } from "react-i18next";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { useSettingsStore, type ToolbarOrientation } from "@/stores/settings-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useByokStore } from "@/stores/byok-store";
import { registerForPushNotificationsAsync } from "@/lib/push-notifications";
import { restartApp, setLanguageWithRTL } from "@/lib/i18n";
import { BackButton } from "@/components/BackButton";
import { Card } from "@/components/ui/Card";
import {
  Globe, Moon, Sun, Bell, Sparkles, Clock,
  Trash2, AlertTriangle, RefreshCw,
  Info, FileText, Shield, ChevronRight, ChevronLeft, ChevronDown, Check, FlaskConical, Mic,
  Rows3, Columns3, KeyRound,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

type Language = "ar" | "en" | "fr";

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "ar", label: "العربية" },
];

interface SettingRow {
  icon: LucideIcon;
  iconColor: string;
  label: string;
  value?: string;
  type: "chevron" | "toggle" | "plain" | "select";
  toggleValue?: boolean;
  onToggle?: (v: boolean) => void;
  onPress?: () => void;
  destructive?: boolean;
  // select-only
  options?: { value: string; label: string }[];
  selectedValue?: string;
  onSelect?: (value: string) => void;
  expanded?: boolean;
}

export default function SettingsScreen() {
  // Dev-only crash switch — see the "Crash the app (test)" row below. Throwing
  // during RENDER is the only thing an error boundary catches, so the tap sets
  // state and the next render is what raises.
  const [crash, setCrash] = useState(false);
  if (crash) throw new Error("Deliberate crash from Settings → Developer (error-boundary test)");

  const { t } = useTranslation();
  const colors = useThemeColors();
  // This screen had NO direction handling at all — it leaned entirely on RN's
  // native mirroring, which reorders the rows but leaves every label to RN's
  // default alignment. In Arabic that stranded each one at the far side of its
  // row from its own icon. The chevron was hardcoded to point right, too.
  const rtl = useRTL();
  const RowChevron = rtl.isRTL ? ChevronLeft : ChevronRight;
  const router = useRouter();
  const theme = useSettingsStore((s) => s.theme);
  const language = useSettingsStore((s) => s.language);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const autocompleteEnabled = useSettingsStore((s) => s.autocompleteEnabled);
  const setAutocompleteEnabled = useSettingsStore((s) => s.setAutocompleteEnabled);
  const toolbarOrientation = useSettingsStore((s) => s.toolbarOrientation);
  const setToolbarOrientation = useSettingsStore((s) => s.setToolbarOrientation);
  const writerEngine = useSettingsStore((s) => s.writerEngine);
  const setWriterEngine = useSettingsStore((s) => s.setWriterEngine);
  // Selected as two primitives, not a derived object — a fresh literal from a
  // selector re-renders on every store write (see the Zustand selector trap).
  const byokEnabled = useByokStore((s) => s.enabled);
  const byokHasKey = useByokStore((s) => s.apiKey.length > 0);
  const byokActive = byokEnabled && byokHasKey;

  const preferences = useNotificationStore((s) => s.preferences);
  const updatePreferences = useNotificationStore((s) => s.updatePreferences);
  const [langExpanded, setLangExpanded] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  // Shown while the app reboots itself after an RTL⇄LTR language switch.
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    useNotificationStore.getState().loadPreferences();
  }, []);

  const handleSelectLanguage = async (code: Language) => {
    setLangExpanded(false);
    if (code === language || restarting) return;
    setLanguage(code);
    const needsRestart = await setLanguageWithRTL(code);
    // Switching in/out of Arabic flips I18nManager, which RN only honours at
    // startup — so restart the app ourselves instead of asking the student to.
    if (needsRestart) {
      setRestarting(true);
      await restartApp();
    }
  };

  // Clears the app's temporary cache directory (downloaded previews, exported
  // PDFs, picked-file copies). Does NOT touch AsyncStorage, the session, or any
  // saved preferences — only disposable on-device files.
  const handleClearCache = () => {
    Alert.alert(
      t("settings.clearCacheConfirmTitle"),
      t("settings.clearCacheConfirmMessage"),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("settings.clearCache"),
          style: "destructive",
          onPress: async () => {
            try {
              const dir = FileSystem.cacheDirectory;
              if (dir) {
                const entries = await FileSystem.readDirectoryAsync(dir);
                await Promise.all(
                  entries.map((name) => FileSystem.deleteAsync(dir + name, { idempotent: true })),
                );
              }
              Alert.alert(t("settings.clearCacheDoneTitle"), t("settings.clearCacheDoneMessage"));
            } catch {
              Alert.alert(t("common.error"), t("settings.clearCacheError"));
            }
          },
        },
      ],
    );
  };

  const languageLabel = LANGUAGES.find((l) => l.value === language)?.label ?? language;

  // How the workspace's floating block toolbar lays out: a wide pill under the block
  // (default) or a narrow side column that leaves the line being edited visible.
  const TOOLBAR_LAYOUTS: { value: ToolbarOrientation; label: string }[] = [
    { value: "horizontal", label: t("settings.toolbarHorizontal", { defaultValue: "Horizontal" }) },
    { value: "vertical", label: t("settings.toolbarVertical", { defaultValue: "Vertical" }) },
  ];
  const toolbarLabel = TOOLBAR_LAYOUTS.find((o) => o.value === toolbarOrientation)?.label ?? toolbarOrientation;

  const sections: { title: string; rows: SettingRow[] }[] = [
    {
      title: t("settings.general"),
      rows: [
        {
          icon: Globe, iconColor: colors.brandPrimary, label: t("settings.language"),
          type: "select", value: languageLabel, options: LANGUAGES, selectedValue: language,
          expanded: langExpanded, onPress: () => setLangExpanded((e) => !e),
          onSelect: (v) => handleSelectLanguage(v as Language),
        },
        {
          icon: theme === "dark" ? Moon : Sun, iconColor: colors.brandAccent, label: t("settings.theme"),
          type: "toggle", toggleValue: theme === "dark",
          onToggle: (v) => setTheme(v ? "dark" : "light"),
        },
        {
          icon: Sparkles, iconColor: colors.brandAccent, label: t("settings.autocomplete"),
          type: "toggle", toggleValue: autocompleteEnabled,
          onToggle: (v: boolean) => setAutocompleteEnabled(v),
        },
        {
          icon: toolbarOrientation === "vertical" ? Columns3 : Rows3,
          iconColor: colors.brandPrimary,
          label: t("settings.toolbarLayout", { defaultValue: "Toolbar layout" }),
          type: "select", value: toolbarLabel, options: TOOLBAR_LAYOUTS,
          selectedValue: toolbarOrientation, expanded: toolbarExpanded,
          onPress: () => setToolbarExpanded((e) => !e),
          onSelect: (v) => { setToolbarOrientation(v as ToolbarOrientation); setToolbarExpanded(false); },
        },
      ],
    },
    {
      title: t("settings.aiSection", { defaultValue: "AI" }),
      rows: [
        {
          icon: KeyRound,
          iconColor: colors.brandPrimary,
          label: t("settings.aiKey", { defaultValue: "Your own AI key" }),
          // The row doubles as the free-tier's status line: "On" means the
          // student's own key is paying for the AI, not us.
          value: byokActive
            ? t("settings.aiKeyOn", { defaultValue: "On" })
            : t("settings.aiKeyOff", { defaultValue: "Off" }),
          type: "chevron",
          onPress: () => router.push("/(app)/ai-key" as any),
        },
      ],
    },
    {
      title: t("settings.notificationsSection"),
      rows: [
        { icon: Bell, iconColor: colors.brandPrimary, label: t("settings.pushNotifications"), type: "toggle", toggleValue: preferences.pushEnabled, onToggle: (v) => { updatePreferences({ pushEnabled: v }); if (v) registerForPushNotificationsAsync().catch(() => {}); } },
        { icon: Sparkles, iconColor: colors.brandAccent, label: t("settings.aiSuggestionsSetting"), type: "toggle", toggleValue: preferences.aiSuggestions, onToggle: (v) => updatePreferences({ aiSuggestions: v }) },
        { icon: Clock, iconColor: colors.semanticWarning, label: t("settings.exportReminders"), type: "toggle", toggleValue: preferences.exportReminders, onToggle: (v) => updatePreferences({ exportReminders: v }) },
      ],
    },
    {
      title: t("settings.dataPrivacy"),
      rows: [
        { icon: Trash2, iconColor: colors.semanticWarning, label: t("settings.clearCache"), type: "plain", onPress: handleClearCache },
        { icon: AlertTriangle, iconColor: colors.semanticError, label: t("settings.deleteAccount"), type: "plain", destructive: true, onPress: () => router.push("/(app)/delete-account" as any) },
      ],
    },
    {
      title: t("settings.about"),
      rows: [
        { icon: Info, iconColor: colors.textSecondary, label: t("settings.version"), value: "1.0.0", type: "plain" },
        { icon: FileText, iconColor: colors.textSecondary, label: t("settings.terms"), type: "chevron", onPress: () => router.push("/(app)/terms-of-service" as any) },
        { icon: Shield, iconColor: colors.textSecondary, label: t("settings.privacy"), type: "chevron", onPress: () => router.push("/(app)/privacy-policy" as any) },
      ],
    },
    // Dev-only: reach the Lexical rich-text spike (native bubble ⇄ web editor).
    ...(__DEV__
      ? [
          {
            title: "Developer",
            rows: [
              {
                // Proves the root error boundary actually catches. Throwing from
                // an onPress would NOT work — React only catches errors raised
                // during RENDER — so this flips state and the throw happens on
                // the next render, which is the real failure shape.
                icon: AlertTriangle,
                iconColor: colors.semanticError,
                label: t("errors.crashTest", { defaultValue: "Crash the app (test)" }),
                type: "chevron" as const,
                onPress: () => setCrash(true),
              },
              {
                icon: FlaskConical,
                iconColor: colors.brandPrimary,
                label: "Lexical Lab",
                type: "chevron" as const,
                onPress: () => router.push("/(app)/lexical-lab" as any),
              },
              {
                icon: RefreshCw,
                iconColor: colors.brandPrimary,
                label: "Lexical Round-trip",
                type: "chevron" as const,
                onPress: () => router.push("/(app)/lexical-roundtrip" as any),
              },
              {
                icon: RefreshCw,
                iconColor: colors.brandPrimary,
                label: "Lexical Write-back",
                type: "chevron" as const,
                onPress: () => router.push("/(app)/lexical-writeback" as any),
              },
              {
                icon: Mic,
                iconColor: colors.brandPrimary,
                label: "Voice Lab",
                type: "chevron" as const,
                onPress: () => router.push("/(app)/voice-lab" as any),
              },
              {
                // The eigenpal docx-editor, hosted from the web app in a
                // WebView. Needs EXPO_PUBLIC_WEB_URL pointing at a reachable
                // `next dev` in ~/kwill-dashboard; the screen says so if not.
                icon: FileText,
                iconColor: colors.brandPrimary,
                label: "Word Editor (trial)",
                type: "chevron" as const,
                onPress: () => router.push("/(app)/word-trial" as any),
              },
              {
                // Spec D12: the docx-editor as THE Writer surface in the workspace,
                // instead of the Lexical editor. Persisted; takes effect on the next
                // workspace open.
                icon: FileText,
                iconColor: colors.brandPrimary,
                label: "Writer: docx-editor",
                type: "toggle" as const,
                toggleValue: writerEngine === "docx",
                onToggle: (v: boolean) => setWriterEngine(v ? "docx" : "lexical"),
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.bgPrimary }]} edges={["top"]}>
      <View style={styles.header}>
        <BackButton />
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t("settings.settings")}</Text>
        <View style={{ width: 30 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {sections.map((section, si) => (
          <View key={si} style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.textSecondary, textAlign: rtl.textAlign }]}>{section.title}</Text>
            <Card style={styles.sectionCard}>
              {section.rows.map((row, ri) => (
                <View key={ri}>
                  <Pressable
                    style={styles.settingRow}
                    onPress={row.type === "toggle" ? undefined : row.onPress}
                  >
                    <View style={[styles.iconBox, { backgroundColor: row.iconColor + "26" }]}>
                      <row.icon size={18} color={row.iconColor} />
                    </View>
                    <Text
                      style={[
                        styles.rowLabel,
                        { color: row.destructive ? colors.semanticError : colors.textPrimary, textAlign: rtl.textAlign },
                      ]}
                    >
                      {row.label}
                    </Text>
                    {row.type === "chevron" && (
                      <View style={styles.rowRight}>
                        {row.value && <Text style={[styles.rowValue, { color: colors.textSecondary, textAlign: rtl.textAlign }]}>{row.value}</Text>}
                        <RowChevron size={16} color={colors.textSecondary} />
                      </View>
                    )}
                    {row.type === "select" && (
                      <View style={styles.rowRight}>
                        {row.value && <Text style={[styles.rowValue, { color: colors.textSecondary, textAlign: rtl.textAlign }]}>{row.value}</Text>}
                        {row.expanded
                          ? <ChevronDown size={16} color={colors.textSecondary} />
                          : <RowChevron size={16} color={colors.textSecondary} />}
                      </View>
                    )}
                    {row.type === "toggle" && (
                      <Switch
                        value={row.toggleValue}
                        onValueChange={row.onToggle}
                        trackColor={{ false: colors.borderDefault, true: colors.brandPrimary + "80" }}
                        thumbColor={row.toggleValue ? colors.brandPrimary : colors.textPlaceholder}
                      />
                    )}
                    {row.type === "plain" && row.value && (
                      <Text style={[styles.rowValue, { color: colors.textSecondary, textAlign: rtl.textAlign }]}>{row.value}</Text>
                    )}
                  </Pressable>

                  {row.type === "select" && row.expanded && row.options && (
                    <View style={[styles.optionsWrap, { borderTopColor: colors.borderSubtle }]}>
                      {row.options.map((opt) => {
                        const active = opt.value === row.selectedValue;
                        return (
                          <Pressable
                            key={opt.value}
                            style={styles.optionRow}
                            onPress={() => row.onSelect?.(opt.value)}
                          >
                            <Text
                              style={[
                                styles.optionLabel,
                                { color: active ? colors.brandPrimary : colors.textPrimary },
                              ]}
                            >
                              {opt.label}
                            </Text>
                            {active && <Check size={18} color={colors.brandPrimary} />}
                          </Pressable>
                        );
                      })}
                    </View>
                  )}

                  {ri < section.rows.length - 1 && (
                    <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
                  )}
                </View>
              ))}
            </Card>
          </View>
        ))}
      </ScrollView>

      {restarting && (
        <View style={[styles.restartOverlay, { backgroundColor: colors.bgPrimary + "F2" }]}>
          <ActivityIndicator size="large" color={colors.brandPrimary} />
          <Text style={[styles.restartTitle, { color: colors.textPrimary }]}>
            {t("settings.rtlRestartTitle")}
          </Text>
          <Text style={[styles.restartMessage, { color: colors.textSecondary }]}>
            {t("settings.rtlRestartMessage")}
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 12 },
  title: { fontSize: 18, fontFamily: "Inter_600SemiBold" },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  section: { marginBottom: 24 },
  sectionLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", marginBottom: 8 },
  sectionCard: { padding: 0 },
  settingRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  iconBox: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, fontSize: 15, fontFamily: "Inter_500Medium" },
  rowRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowValue: { fontSize: 13, fontFamily: "Inter_400Regular" },
  divider: { height: 1, marginLeft: 60 },
  optionsWrap: { borderTopWidth: 1, marginLeft: 60, paddingRight: 16 },
  optionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingRight: 4 },
  optionLabel: { fontSize: 15, fontFamily: "Inter_500Medium" },
  restartOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 12,
  },
  restartTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold", textAlign: "center" },
  restartMessage: { fontSize: 14, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 20 },
});
