import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Mic } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { hSelection } from "@/lib/haptics";
import { useVoiceDictation } from "@/lib/voice";

interface VoiceMicProps {
  /** BCP-47 recognizer locale (`ar-SA`, `fr-FR`, `en-US`), chosen beside the mic. */
  lang?: string;
  /** Called with each final transcript; the caller appends it to its text. */
  onText?: (text: string) => void;
  disabled?: boolean;
}

/**
 * Dictation on the device's own recogniser (P-27). Hidden where the recogniser is not linked or not available, so a student never taps a
 * dead button. A denied permission is said in words, under the mic.
 */
export function VoiceMic({ lang, onText, disabled }: VoiceMicProps) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const voice = useVoiceDictation();
  const [denied, setDenied] = useState(false);
  if (!voice.supported) return null;

  const toggle = async () => {
    if (voice.listening) {
      voice.stop();
      return;
    }
    hSelection();
    setDenied(false);
    const ok = await voice.start(
      (text, isFinal) => { if (isFinal && text) onText?.(text); },
      { lang, addsPunctuation: true },
    );
    if (!ok) setDenied(true);
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("rescueV2.notes.micLabel")}
        accessibilityState={{ selected: voice.listening, disabled: !!disabled }}
        disabled={disabled}
        onPress={() => { void toggle(); }}
        hitSlop={8}
        style={[
          styles.mic,
          { backgroundColor: voice.listening ? colors.brandPrimary : colors.bgSurface, borderColor: colors.borderDefault },
        ]}
      >
        <Mic size={16} color={voice.listening ? colors.bgCard : colors.textSecondary} strokeWidth={2} />
      </Pressable>
      {denied ? <Text style={[styles.denied, { color: colors.semanticError }]}>{t("rescueV2.notes.micDenied")}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "flex-end", gap: 4 },
  mic: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  denied: { fontSize: 11, maxWidth: 160 },
});
