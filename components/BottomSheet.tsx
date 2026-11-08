import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { StyleSheet, BackHandler } from "react-native";
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetScrollView,
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { useThemeColors } from "@/hooks/useThemeColors";
import type { ThemeColors } from "@/constants/colors";
import { useBottomSheet, type SheetName } from "@/stores/bottom-sheet-store";

interface BottomSheetProps {
  /** Store key that drives open/close. Open with useBottomSheet.getState().openSheet(name). */
  name: SheetName;
  children: ReactNode;
  /** Fixed snap points (e.g. ["50%"]). Omit to size the sheet to its content. */
  snapPoints?: (string | number)[];
  /**
   * How the sheet reacts to the keyboard:
   * - "interactive" (default): translates up with the keyboard.
   * - "extend": grows to its TOP snap point while the keyboard is open, then
   *   collapses back when it closes (needs ≥2 snap points to be visible).
   * - "fillParent": expands to fill the screen while the keyboard is open.
   */
  keyboardBehavior?: "interactive" | "extend" | "fillParent";
  /** Blocking sheet: no swipe-down, no backdrop-dismiss, swallow Android back. */
  blocking?: boolean;
  /** Hide the grabber handle at the top. */
  hideHandle?: boolean;
  /**
   * Content scrolls inside the sheet (BottomSheetScrollView) instead of sizing it
   * (BottomSheetView). Needed whenever the content can be taller than the SMALLEST
   * snap point — gorhom has to own the scroll view for the drag-vs-scroll handoff
   * to work, so a plain ScrollView here would fight the sheet's pan.
   */
  scrollable?: boolean;
  /** Fires after the sheet is dismissed by the user (swipe / backdrop). */
  onDismiss?: () => void;
}

/**
 * Reusable wrapper around gorhom's BottomSheetModal, driven by the global
 * bottom-sheet store so any screen can open it by name without prop plumbing.
 *
 * It conditionally UNMOUNTS when closed (`!isOpen → null`): on the New
 * Architecture an always-mounted modal won't re-present after its first dismiss,
 * so we mount fresh on open and present once via a single requestAnimationFrame.
 * Compose concrete sheets by rendering their content as children.
 */
export function BottomSheet({ name, children, snapPoints, keyboardBehavior, blocking, hideHandle, scrollable, onDismiss }: BottomSheetProps) {
  const colors = useThemeColors();
  const isOpen = useBottomSheet((s) => s.openSheets.has(name));
  if (!isOpen) return null;
  return (
    <BottomSheetInner
      name={name}
      snapPoints={snapPoints}
      keyboardBehavior={keyboardBehavior}
      blocking={blocking}
      hideHandle={hideHandle}
      scrollable={scrollable}
      onDismiss={onDismiss}
      colors={colors}
    >
      {children}
    </BottomSheetInner>
  );
}

function BottomSheetInner({
  name,
  children,
  snapPoints,
  keyboardBehavior,
  blocking,
  hideHandle,
  scrollable,
  onDismiss,
  colors,
}: BottomSheetProps & { colors: ThemeColors }) {
  const sheetRef = useRef<BottomSheetModal>(null);
  const closeSheet = useBottomSheet((s) => s.closeSheet);

  // Present once, on mount. Single rAF avoids the New-Arch "won't open" race.
  useEffect(() => {
    const id = requestAnimationFrame(() => sheetRef.current?.present());
    return () => cancelAnimationFrame(id);
  }, []);

  // Blocking sheets swallow Android hardware back so it can't dismiss them.
  useEffect(() => {
    if (!blocking) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, [blocking]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior={blocking ? "none" : "close"}
      />
    ),
    [blocking]
  );

  // Dismissed by swipe/backdrop → sync the store (which unmounts us) and notify.
  const handleDismiss = useCallback(() => {
    closeSheet(name);
    onDismiss?.();
  }, [closeSheet, name, onDismiss]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={snapPoints}
      // No snap points → size to content.
      enableDynamicSizing={!snapPoints}
      enablePanDownToClose={!blocking}
      // Keep a focused input above the keyboard (see keyboardBehavior prop).
      keyboardBehavior={keyboardBehavior ?? "interactive"}
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      handleComponent={hideHandle ? null : undefined}
      onDismiss={handleDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.bgModal }}
      handleIndicatorStyle={{ backgroundColor: colors.textPlaceholder }}
    >
      {scrollable ? (
        // "handled": a tap on a button while a field has the keyboard is that button's tap. By default the first tap only closed the
        // keyboard, so a sheet's Save needed two (the rescue cover field).
        <BottomSheetScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{children}</BottomSheetScrollView>
      ) : (
        <BottomSheetView style={styles.content}>{children}</BottomSheetView>
      )}
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 28 },
});
