import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * How far a bottom-docked bar must lift itself to clear the keyboard.
 *
 * ANDROID ONLY, and it is not optional: the app draws edge-to-edge, and once it
 * does, `windowSoftInputMode` is inert — the window is NEVER resized for the
 * IME. Nothing moves on its own, so a bar pinned to the bottom sits BEHIND the
 * keyboard unless it lifts by the measured height. Same math as BlockComposer's
 * dock and FloatingPill, which learned this the same way.
 *
 * iOS returns 0: there the screen's KeyboardAvoidingView (behavior="padding")
 * already shrinks the container, and adding a lift on top would double-count —
 * which is the bug behavior="height" used to cause on Android.
 *
 * ⚠️ THE HEIGHT REACT NATIVE REPORTS IS SHORT BY THE NAVIGATION BAR. On API 30+
 * ReactRootView.checkForKeyboardEvents() sends us
 *
 *     height = imeInsets.bottom - systemBars().bottom
 *
 * which is right only when the window is inset by the navigation bar. We draw
 * EDGE-TO-EDGE (android/gradle.properties `edgeToEdgeEnabled=true`), so the root
 * view spans the navigation bar and the honest number is the whole
 * `imeInsets.bottom`. Every Android student was therefore lifted short by their
 * navigation bar's height — about 16dp on gesture navigation, which reads as a
 * tight fit, and about 48dp on a three-button bar, which puts the input BEHIND
 * the keys. That is the "only on some phones" in the bug report: it is not the
 * phone, it is which navigation the phone uses.
 *
 * Adding the safe-area bottom inset back is exact, not a fudge: safe-area-context
 * asks for `statusBars | displayCutout | navigationBars | captionBar` and
 * pointedly NOT `ime()`, so at the bottom edge it returns the very inset RN
 * subtracted, and it keeps returning it while the keyboard is up.
 *
 * API < 30 is left alone: RN falls back to a visible-display-frame diff there,
 * which already measures the full height, and adding to it would over-lift.
 */
export function useKeyboardLift(): number {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    // Re-read on EVERY show: the height changes when the IME swaps layout
    // (language switch, emoji panel, suggestion strip) and the bar must re-lift.
    const showSub = Keyboard.addListener("keyboardDidShow", (e) =>
      setHeight(e?.endCoordinates?.height ?? 0),
    );
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  if (height <= 0) return 0;
  const underReported = Platform.OS === "android" && Number(Platform.Version) >= 30;
  return underReported ? height + insets.bottom : height;
}

/**
 * How much room a bottom-docked bar must leave beneath itself.
 *
 * Android runs EDGE-TO-EDGE (`edgeToEdgeEnabled=true`): the app owns the pixels
 * behind the system navigation, so anything docked to the bottom has to pad
 * ITSELF clear of it. How much is a DEVICE answer, never a design one — a
 * three-button navigation bar is ~48dp tall, a gesture pill ~16dp, a phone with
 * neither reports 0 — and that is exactly what the safe-area inset returns. iOS
 * reports the home indicator the same way. So: read it, never hardcode it.
 *
 * While the keyboard is up it covers the navigation bar, and nothing can
 * collide with a bar that isn't on screen. Holding the inset open then just
 * parks the docked bar a navigation bar's height above the keys, so the inset
 * collapses to `min` — which is also the floor on devices that report nothing.
 *
 * This is CLEARANCE, not keyboard avoidance. A bar that has to stay visible
 * while typing adds `useKeyboardLift()` on top.
 */
export function useBottomInset(min = 0): number {
  const insets = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    // iOS gets the `will` events so the bar moves WITH the keyboard animation;
    // Android only fires the `did` pair.
    const showEvt = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvt = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvt, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return keyboardVisible ? min : Math.max(insets.bottom, min);
}
