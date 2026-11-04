import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { brand } from "@/constants/colors";
import { useThemeColors } from "@/hooks/useThemeColors";
import { hSelection } from "@/lib/haptics";
import type { RescueDotDTO } from "@/types/rescue-v2";

const DOT = 14;

interface Props {
  /** The dots of the page shown in the middle slot, already filtered. */
  dots: RescueDotDTO[];
  selectedN: number | null;
  onSelect: (n: number) => void;
  /** The middle page's box, in pixels. */
  width: number;
  height: number;
  /** The problem sentence for a dot, for its accessible name. */
  label: (dot: RescueDotDTO) => string;
}

/**
 * Numbered red dots on the outer edge of the middle page, at each problem's height. The layer is laid over the whole carousel and centred
 * on the middle page's own box, so the dots sit on that page and not on the side pages. Dots alternate sides by their number.
 */
export function DiagnosisDots({ dots, selectedN, onSelect, width, height, label }: Props) {
  const colors = useThemeColors();
  return (
    <View pointerEvents="box-none" style={styles.layer}>
      <View style={{ width, height }} pointerEvents="box-none">
        {dots.map((d) => {
          const on = d.n === selectedN;
          const side = d.n % 2 === 1 ? { left: -DOT / 2 } : { right: -DOT / 2 };
          return (
            <TouchableOpacity
              key={d.n}
              accessibilityRole="button"
              accessibilityLabel={label(d)}
              accessibilityState={{ selected: on }}
              hitSlop={10}
              onPress={() => { hSelection(); onSelect(d.n); }}
              style={[
                styles.dot,
                { top: d.topPct * height - DOT / 2, backgroundColor: colors.semanticError, borderColor: on ? colors.textPrimary : "transparent" },
                side,
              ]}
            >
              <Text style={[styles.num, { color: brand.onPrimary }]}>{d.n}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center" },
  dot: {
    position: "absolute",
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  num: { fontSize: 8, fontWeight: "800", lineHeight: 10 },
});
