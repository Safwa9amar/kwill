import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { visualTextAlign } from "@/lib/rtl-layout";
import { firstStrongDirection } from "@/lib/text-direction";

interface Props {
  /** The part's own first lines (`RescuePartDTO.openingText`). */
  text: string;
  width: number;
  height: number;
}

/**
 * A small paper with a part's opening lines: the mini page of screens 2 and 5. The direction is the text's own, from its first strong
 * character, so an Arabic part reads right to left in a French UI.
 */
export function MiniTextPage({ text, width, height }: Props) {
  const colors = useThemeColors();
  const dir = firstStrongDirection(text, "ltr");
  return (
    <View style={[styles.paper, { width, height, backgroundColor: colors.rescuePaper }]}>
      <Text
        numberOfLines={Math.max(3, Math.floor(height / 8))}
        style={[styles.text, { color: colors.rescuePaperInk, textAlign: visualTextAlign(dir === "rtl"), writingDirection: dir }]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  paper: { borderRadius: 3, padding: 5, overflow: "hidden" },
  text: { fontSize: 5, lineHeight: 7.5 },
});
