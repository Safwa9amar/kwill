import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Image,
  Pressable,
  FlatList,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { useTranslation } from "react-i18next";
import { Search, Check, X, GraduationCap } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useUniversityStore } from "@/stores/university-store";
import type { University } from "@/types/thesis";
import { visualTextAlign } from "@/lib/rtl-layout";
import { BottomSheetFlatList, BottomSheetTextInput } from "@gorhom/bottom-sheet";

/**
 * Searchable picker over the 130 Algerian institutions.
 *
 * Exists because a typed university string can never be joined to anything —
 * picking a real row is what lets the server recommend a starting point that
 * actually belongs to the student's school.
 *
 * Search matches French, Arabic AND English names plus city, because a student
 * may know their institution by any of them.
 */
/**
 * "Ain Oussara · Ain Oussara" reads like a bug. For many institutions the city
 * IS the wilaya, so collapse the two rather than repeating the word.
 */
function subtitleFor(u: University, isAr: boolean): string {
  const city = isAr ? u.cityAr : u.city;
  const wilaya = u.wilaya;
  if (!city) return wilaya;
  if (!wilaya || city.trim().toLowerCase() === wilaya.trim().toLowerCase()) return city;
  return `${city} · ${wilaya}`;
}

/**
 * Bigger institutions first. Sorting purely by name pushed every
 * "Annexe Universitaire d'…" to the top, so a student at a major university had
 * to scroll past nine annexes to reach it. Within a tier, alphabetical.
 */
const TYPE_RANK: Record<string, number> = {
  university: 0,
  ecole: 1,
  ens: 2,
  centre_universitaire: 3,
};

function byRelevance(a: University, b: University): number {
  const ra = TYPE_RANK[a.type] ?? 9;
  const rb = TYPE_RANK[b.type] ?? 9;
  if (ra !== rb) return ra - rb;
  return a.nameFr.localeCompare(b.nameFr);
}

/** The search field: gorhom's input inside a sheet (it keeps the keyboard above the field), the plain one everywhere else. */
function SearchField({ sheet, ...props }: { sheet: boolean } & React.ComponentProps<typeof TextInput>) {
  return sheet
    ? <BottomSheetTextInput {...props} autoCorrect={false} spellCheck={false} />
    : <TextInput {...props} autoCorrect={false} spellCheck={false} />;
}

export function UniversityPicker({
  value,
  onChange,
  onSkip,
  autoFocus,
  sheet,
}: {
  value: string | null;
  onChange: (id: string, university: University) => void;
  /** Lets a student whose institution genuinely is not listed carry on. */
  onSkip?: () => void;
  autoFocus?: boolean;
  /**
   * Inside a gorhom bottom sheet: the list and the field are gorhom's own, so the sheet scrolls the list and keeps the keyboard above the
   * field. Without it the picker renders plain components, as every existing screen expects.
   */
  sheet?: boolean;
}) {
  const colors = useThemeColors();
  const { t, i18n } = useTranslation();
  const isAr = i18n.language === "ar";

  // Primitives selected individually — a selector returning a fresh array would
  // re-render forever under Zustand v5's Object.is check.
  const universities = useUniversityStore((s) => s.universities);
  const loaded = useUniversityStore((s) => s.loaded);
  const loading = useUniversityStore((s) => s.loading);
  const error = useUniversityStore((s) => s.error);
  const load = useUniversityStore((s) => s.load);

  const [query, setQuery] = useState("");

  useEffect(() => {
    load();
  }, [load]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = !q
      ? universities
      : universities.filter(
          (u) =>
            u.nameFr.toLowerCase().includes(q) ||
            u.nameEn.toLowerCase().includes(q) ||
            u.nameAr.includes(query.trim()) ||
            u.city.toLowerCase().includes(q) ||
            u.cityAr.includes(query.trim()) ||
            u.wilaya.toLowerCase().includes(q)
        );
    return [...matched].sort(byRelevance);
  }, [universities, query]);

  const renderItem = ({ item }: { item: University }) => {
    const selected = item.id === value;
    return (
      <Pressable
        onPress={() => onChange(item.id, item)}
        style={[
          styles.row,
          {
            backgroundColor: selected ? colors.brandPrimary + "18" : colors.bgCard,
            borderColor: selected ? colors.brandPrimary : colors.borderSubtle,
          },
        ]}
      >
        {item.logoUrl ? (
          <Image source={{ uri: item.logoUrl }} style={styles.logo} resizeMode="contain" />
        ) : (
          <View style={[styles.logo, styles.logoFallback, { backgroundColor: colors.bgSurface }]}>
            <GraduationCap size={16} color={colors.textSecondary} strokeWidth={2} />
          </View>
        )}

        <View style={styles.rowText}>
          <Text style={[styles.nameFr, { color: colors.textPrimary, textAlign: visualTextAlign(isAr) }]} numberOfLines={2}>
            {isAr ? item.nameAr : item.nameFr}
          </Text>
          <Text
            style={[styles.meta, { color: colors.textSecondary, textAlign: visualTextAlign(isAr) }]}
            numberOfLines={1}
          >
            {subtitleFor(item, isAr)}
          </Text>
        </View>

        {selected ? <Check size={18} color={colors.brandPrimary} strokeWidth={2.5} /> : null}
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.searchBox, { backgroundColor: colors.bgInput, borderColor: colors.borderSubtle }]}>
        <Search size={16} color={colors.textPlaceholder} strokeWidth={2} />
        <SearchField
          sheet={!!sheet}
          value={query}
          onChangeText={setQuery}
          autoFocus={autoFocus}
          placeholder={t("university.searchPlaceholder")}
          placeholderTextColor={colors.textPlaceholder}
          style={[styles.searchInput, { color: colors.textPrimary, textAlign: visualTextAlign(isAr) }]}
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery("")} hitSlop={8}>
            <X size={16} color={colors.textSecondary} strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>

      {loading && !loaded ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={[styles.meta, { color: colors.semanticError }]}>{t("university.loadFailed")}</Text>
        </View>
      ) : (
        sheet ? (
          <BottomSheetFlatList
            data={results}
            renderItem={renderItem}
            keyExtractor={(u: University) => u.id}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            ListEmptyComponent={
              <View style={styles.centered}>
                <Text style={[styles.meta, { color: colors.textSecondary }]}>{t("university.noResults")}</Text>
              </View>
            }
          />
        ) : (
          <FlatList
            data={results}
            renderItem={renderItem}
            keyExtractor={(u) => u.id}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            ListEmptyComponent={
              <View style={styles.centered}>
                <Text style={[styles.meta, { color: colors.textSecondary }]}>{t("university.noResults")}</Text>
              </View>
            }
          />
        )
      )}

      {onSkip ? (
        <Pressable onPress={onSkip} style={styles.skip}>
          <Text style={[styles.skipText, { color: colors.textSecondary }]}>{t("university.notListed")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 10 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  list: { flex: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
  },
  logo: { width: 34, height: 34, borderRadius: 8 },
  logoFallback: { alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, gap: 2 },
  nameFr: { fontSize: 14, fontWeight: "600" },
  meta: { fontSize: 12 },
  centered: { paddingVertical: 24, alignItems: "center" },
  skip: { paddingVertical: 12, alignItems: "center" },
  skipText: { fontSize: 13, textDecorationLine: "underline" },
});
