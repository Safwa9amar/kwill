import { useTranslation } from "react-i18next";
import { Image, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { BookOpen, Sparkles } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { RescueHomeCard } from "@/components/rescue/RescueHomeCard";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";

// The welcome artwork. Everything below is sized off the image's own aspect
// ratio, so a different picture needs no other change.
//
// This was briefly an animated GIF. It went back to a still because GIF carries
// only 1-bit alpha: every soft edge pixel is forced fully on or fully off, and
// since the animation was generated against black, the ones it kept were a dark
// navy that read as a speckled fringe around the robot on the light theme. A
// PNG has real 8-bit alpha and no such edge. Anything animated here wants a
// format that can hold partial transparency — Lottie or Rive, not GIF.
const WELCOME_ART = require("../../assets/welcome-chat-avatar.png");

/**
 * What an empty conversation shows instead of nothing.
 *
 * This replaced a fake assistant message that ai-service used to insert. That
 * bubble looked like the model had spoken before the student said anything, and
 * it sat in the transcript as a real message — it could be read aloud,
 * regenerated, and counted toward "has history". A rendered empty state says the
 * same thing without pretending to be part of the conversation.
 */
export function ChatWelcome() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  const { flexDirection } = useRTL();

  return (
    <View style={styles.wrap}>
      {/* Copy sits ABOVE the art: the student reads what this can do for them
          first, and the illustration is the warm full stop, not the headline. */}
      <Image
        source={WELCOME_ART}
        style={styles.art}
        resizeMode="contain"
        accessibilityRole="image"
        accessibilityLabel={t("chat.welcome.body")}
      />

      <Text style={[styles.body, { color: colors.textSecondary }]}>
        {t("chat.welcome.body")}
      </Text>

      {/* Rescue v2's card, under the body text and above the two doors. Off in a release build. */}
      {RESCUE_V2_ENABLED ? <RescueHomeCard /> : null}

      {/* The one line above can only ever hint. This opens the full account of
          what it can do and how to ask for it — an outline button, because the
          composer below is where the student is meant to end up, not here.

          A STATIC style array, and TouchableOpacity for the press feedback. NOT
          `Pressable style={({pressed}) => …}` — under the New Architecture that
          style function can silently apply NOTHING, which left this button as a
          borderless column with the ✦ stacked on top of its own label. */}
      {/* Two doors, and they answer different questions. "What Kwill can do" is
          the catalogue — for the student who doesn't yet know what to expect.
          "Writing guide" is the method — the build order, how to phrase a
          request, prompts to copy — for the student who knows and wants to get
          it right. The catalogue stays first because it is the smaller ask. */}
      <View style={styles.ctaRow}>
        <TouchableOpacity
          onPress={() => router.push("/(app)/chat-guide" as any)}
          style={[styles.cta, { flexDirection, borderColor: colors.borderDefault }]}
          activeOpacity={0.6}
          hitSlop={8}
          accessibilityRole="button"
        >
          <Sparkles size={16} color={colors.brandPrimary} strokeWidth={2} />
          <Text style={[styles.ctaLabel, { color: colors.brandPrimary }]}>
            {t("chat.welcome.cta", { defaultValue: "See what Kwill can do" })}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => router.push("/(app)/support-guide" as any)}
          style={[styles.cta, { flexDirection, borderColor: colors.borderDefault }]}
          activeOpacity={0.6}
          hitSlop={8}
          accessibilityRole="button"
        >
          <BookOpen size={16} color={colors.brandPrimary} strokeWidth={2} />
          <Text style={[styles.ctaLabel, { color: colors.brandPrimary }]}>
            {t("support.guide.title", { defaultValue: "Writing guide" })}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Centred in whatever space the empty list leaves, with generous side padding
  // so the copy never runs edge to edge on a small phone.
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 20 },
  body: { fontSize: 15, fontFamily: "Inter_400Regular", lineHeight: 23, textAlign: "center" },
  art: { width: 200, height: 200 },
  // Wraps rather than a fixed row: at two pills the pair fits side by side on a
  // normal phone, but Arabic and French labels are longer than the English, and
  // a wrap lets the second drop under the first instead of squeezing both.
  ctaRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  // alignSelf so the pill hugs its label instead of stretching across the
  // column's full width the way a bare `alignItems: center` parent would.
  cta: { alignSelf: "center", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 999, paddingHorizontal: 18, paddingVertical: 11 },
  ctaLabel: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
