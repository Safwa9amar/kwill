import { useEffect, useState } from "react";
import { AppState, BackHandler, I18nManager, Platform, useWindowDimensions } from "react-native";
import { SplashScreen, useRouter, usePathname, useSegments } from "expo-router";
import { Drawer } from "expo-router/drawer";
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from "@expo-google-fonts/inter";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { AppDrawer } from "@/components/AppDrawer";
import { BottomInsertDrawer } from "@/components/BottomInsertDrawer";
import { DockToolsSheet } from "@/components/DockToolsSheet";
import { HeaderFooterSheet } from "@/components/HeaderFooterSheet";
import { CaptionSheet } from "@/components/CaptionSheet";
import { EquationSheet } from "@/components/EquationSheet";
import { ThemeProvider } from "@/components/ThemeProvider";
import { NetworkBanner } from "@/components/NetworkBanner";
// import { ChatHead } from "@/components/ChatHead"; // disabled for now
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useProfileStore } from "@/stores/profile-store";
import { useThesisStore } from "@/stores/thesis-store";
import { useRescueStore } from "@/stores/rescue-store";
import { forceCloseDrawer, useNavDrawerStore } from "@/stores/nav-drawer-store";
import { listTheses } from "@/lib/api";
import { registerForPushNotificationsAsync, addNotificationListeners } from "@/lib/push-notifications";
import { notifyRoute, rescueRouteTarget } from "@/lib/rescue-v2-notify";
import { reopenIfOpen } from "@/stores/rescue-v2-store";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";
import { useRescueColdStart } from "@/hooks/useRescueColdStart";
import { useAuthDeepLink } from "@/lib/auth-deeplink";
import { AuthLinkOverlay } from "@/components/AuthLinkOverlay";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { applyDeviceRTLOnFirstLaunch, getStoredLanguage, restartApp } from "@/lib/i18n";
import i18n from "@/lib/i18n";
import "../global.css";

SplashScreen.preventAutoHideAsync();

// The app's root surface is the chat, on the thesis you last worked on — there is
// no dashboard to land on any more. It takes no params (the chat reads the current
// thesis from the store, restored below), and with no thesis at all it renders the
// empty writer's starters, so this href is correct in every state.
const HOME_HREF = "/(app)/chat";

// The drawer covers 72% of the width; the pushed screen keeps a 28% dimmed peek.
const DRAWER_FRACTION = 0.72;
// Width of the leading-edge zone that starts an open-swipe. Wide enough to be
// found without looking — this is the only gesture into the app's index, from
// every screen, so it can't be a hairline. (React Navigation's own default is
// the same 32, but state it rather than inherit it: it is a product decision.)
const SWIPE_EDGE_WIDTH = 32;
// Which side the drawer lives on. The navigator would derive this itself from
// the locale direction, but `I18nManager` is what the REST of the app mirrors
// off (see lib/rtl-layout.ts), and the two must not be allowed to disagree:
// RTL (Arabic) → right edge, LTR (fr/en) → left.
const DRAWER_POSITION = I18nManager.isRTL ? "right" : "left";

/**
 * The three things the navigator does not do for us.
 *
 * Everything else about the drawer — the pan, the slide, the scrim, the side —
 * belongs to `Drawer` now and is deliberately NOT reimplemented here.
 */
function useDrawerHousekeeping() {
  const pathname = usePathname();
  const open = useNavDrawerStore((s) => s.open);

  // 1. Close on every route change. The drawer's own rows already close before
  //    they navigate, but the writer, the chat chips and the notification taps
  //    can all move the stack underneath an open panel.
  useEffect(() => {
    useNavDrawerStore.getState().closeDrawer();
  }, [pathname]);

  // 2. Android hardware back closes the drawer rather than leaving the screen.
  //    The drawer's router would do this, but only if the request reached it —
  //    back is offered to the FOCUSED navigator first, and that is the (app)
  //    stack, which happily pops the screen behind the open panel instead.
  //    Registered only while open, so it is the newest listener and runs first.
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      useNavDrawerStore.getState().closeDrawer();
      return true;
    });
    return () => sub.remove();
  }, [open]);

  // 3. Force it shut on every return to the foreground — see forceCloseDrawer.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") forceCloseDrawer();
    });
    return () => sub.remove();
  }, []);
}

function useProtectedRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const recoveryMode = useAuthStore((s) => s.recoveryMode);
  const hasCompletedOnboarding = useSettingsStore((s) => s.hasCompletedOnboarding);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === "(auth)";

    // Small delay for Android — router needs a tick to be ready
    const timer = setTimeout(() => {
      // PRIORITY-ORDERED, not three independent checks — otherwise the branches
      // fight and the router ping-pongs. Onboarding gates everything, then auth,
      // then the app. Each level only acts while the user is on the WRONG side,
      // and a lower level never runs until the higher condition is satisfied.
      //
      // The bug this fixes: an authenticated user who hasn't finished onboarding
      // used to bounce forever between (auth)/onboarding (sent there because
      // onboarding is incomplete) and the app (sent there because "authenticated +
      // in (auth) → app"). Gating the app redirect behind hasCompletedOnboarding
      // breaks the loop — onboarding now wins until it's actually complete.
      if (!hasCompletedOnboarding) {
        // Must finish onboarding first; it lives in (auth). Don't redirect while
        // already inside (auth), or every step within the flow snaps back to it.
        if (!inAuthGroup) router.replace("/(auth)/onboarding" as any);
      } else if (!isAuthenticated) {
        if (!inAuthGroup) router.replace("/(auth)/login" as any);
      } else if (inAuthGroup) {
        // ...unless a password reset is mid-flight. Verifying the emailed code
        // signs the student in — that session is what authorises the password
        // change — so an authenticated user inside (auth) is EXPECTED here, and
        // ejecting them would skip the screen that actually sets the password.
        // The flag is cleared by finishRecovery() on the confirmation screen,
        // and this effect re-runs on it to perform the redirect then.
        if (!recoveryMode) router.replace(HOME_HREF as any);
      }
    }, Platform.OS === "android" ? 100 : 0);

    return () => clearTimeout(timer);
  }, [isAuthenticated, isLoading, recoveryMode, hasCompletedOnboarding, segments]);
}

export default function RootLayout() {
  const [appReady, setAppReady] = useState(false);
  const initialize = useAuthStore((s) => s.initialize);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const router = useRouter();
  const { width } = useWindowDimensions();
  const drawerWidth = Math.round(width * DRAWER_FRACTION);

  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });

  useEffect(() => {
    async function prepare() {
      // Clear stale thesis cache (one-time migration)
      const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
      await AsyncStorage.removeItem("modakerati-thesis");

      // The student's chosen language, or the device's on a fresh install.
      const lang = await getStoredLanguage();
      await i18n.changeLanguage(lang);
      // The settings store is the other reader of this (the Settings radio, and
      // the language AI completions are written in). It holds its own persisted
      // copy, so line it up with i18next — the text on screen is the truth.
      // Deferred until `persist` has rehydrated: writing before that lands, then
      // gets replaced by whatever was on disk a tick later.
      const syncSettingsLanguage = () => {
        if (useSettingsStore.getState().language !== lang) {
          useSettingsStore.getState().setLanguage(lang);
        }
      };
      if (useSettingsStore.persist.hasHydrated()) syncSettingsLanguage();
      else useSettingsStore.persist.onFinishHydration(syncSettingsLanguage);
      // Arabic must be laid out right-to-left, and RN only mirrors at startup.
      // Still behind the splash screen here, so the reboot is invisible — and it
      // happens at most once per install (see applyDeviceRTLOnFirstLaunch).
      if (await applyDeviceRTLOnFirstLaunch(lang)) {
        // Nothing below runs once the reload lands. Give it a moment to, then
        // launch anyway — a mirrored-wrong first session beats a stuck splash.
        if (await restartApp(0)) await new Promise((r) => setTimeout(r, 2000));
      }
      await initialize();
      setAppReady(true);
    }
    prepare();
  }, []);

  useEffect(() => {
    if (appReady && fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [appReady, fontsLoaded]);

  // Push notifications bootstrap — runs only while authenticated.
  useEffect(() => {
    if (!isAuthenticated) return;

    registerForPushNotificationsAsync().catch(() => {});
    useProfileStore.getState().fetchProfile().catch(() => {});
    useNotificationStore.getState().loadPreferences().catch(() => {});
    useNotificationStore.getState().fetchNotifications().catch(() => {});

    // Restore WHICH thesis the app is about. The chat is the first screen and it
    // reads `currentThesisId` from the (in-memory) thesis store, so without this
    // every cold start would open on "pick a thesis" even for a returning student.
    // The id lands synchronously from the persisted setting; the list follows over
    // the network and only supplies titles.
    const remembered = useSettingsStore.getState().lastThesisId;
    if (remembered) useThesisStore.getState().setCurrentThesis(remembered);
    listTheses()
      .then((rows) => {
        const store = useThesisStore.getState();
        store.setTheses(rows);
        // The remembered thesis can be gone — deleted here or on another device.
        // Fall back to the most recently touched one rather than stranding the
        // chat on an id the server no longer knows.
        if (!rows.some((r) => r.id === store.currentThesisId)) {
          const newest = [...rows].sort((a, b) =>
            (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
          )[0];
          store.setCurrentThesis(newest?.id ?? null);
          useSettingsStore.getState().setLastThesisId(newest?.id ?? null);
        }
      })
      .catch(() => {
        // Offline / transient: keep whatever the persisted id gave us.
      });

    // Cold-start: an unfinished rescue run (paid repair in flight, finished, or
    // still waiting at its verdict) resumes into the actual screen instead of
    // silently vanishing back to the app root — best-effort, same as the
    // profile/preferences/notification calls above. The lastThesisId restore
    // just above never navigates: chat is already HOME_HREF, so setting the id
    // is enough for the root route to pick it up. Rescue has no such luxury —
    // rescue-working/result/verdict are not the root — so it navigates for real,
    // the same way the notification listener below does (a bare router call in
    // this same effect, not gated on appReady since it's fire-and-forget).
    (async () => {
      const resumed = await useRescueStore.getState().resume();
      if (!resumed) return;
      const status = useRescueStore.getState().status;
      if (status === "repairing") router.replace("/(app)/rescue-working" as any);
      else if (status === "done") router.replace("/(app)/rescue-result" as any);
      else if (status === "verdict") router.replace("/(app)/rescue-verdict" as any);
    })().catch(() => {});

    const cleanup = addNotificationListeners((route, data) => {
      const to = notifyRoute(route, data, RESCUE_V2_ENABLED);
      // The project already on the living screen: its params do not change, so it would never re-read (a staff retry stayed hidden).
      if (RESCUE_V2_ENABLED) reopenIfOpen(rescueRouteTarget(to));
      router.push(to as never);
    });
    return cleanup;
  }, [isAuthenticated]);

  useProtectedRoute();
  useDrawerHousekeeping();

  // A password-reset or confirmation link coming back into the app. Gated on the
  // same condition as the render below, because it navigates: the router does
  // not exist while this returns null, and a `replace()` issued into that gap is
  // silently dropped — which would strand the student on the chat with an
  // unchanged password.
  useAuthDeepLink(appReady && fontsLoaded);
  useRescueColdStart(appReady && fontsLoaded && isAuthenticated);

  if (!appReady || !fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <ThemeProvider>
          {/* Inside ThemeProvider so the fallback can read the theme, outside
              everything that can throw. A render error below this point used to
              unmount the whole app and leave a white screen. */}
          <RootErrorBoundary>
            <BottomInsertDrawer>
            {/* Running header / footer editor — same push-drawer surface as the Insert
                menu. Nested INSIDE it: only one of the two is ever open. */}
            <HeaderFooterSheet>
            {/* Word's Insert Caption dialog — same push-drawer surface, nested the
                same way: only one of the three sheets is ever open. */}
            <CaptionSheet>
            {/* Word's Insert Equation — the same push-drawer surface again, nested
                the same way: only one of the sheets is ever open. */}
            <EquationSheet>
            {/* The writer's global document tools — same push-drawer surface again,
                opened by the bottom-edge grip or the bubble's ⋮⋮ drop target. */}
            <DockToolsSheet>
            <BottomSheetModalProvider>
              <NetworkBanner />
              {/* THE app's index, and the root navigator with it. Every screen
                  hangs off `(app)`, so putting the drawer here is what makes it
                  reachable from all of them with no per-screen wiring — the same
                  job the old hand-rolled `PushDrawer` did by wrapping the tree,
                  minus the gesture, scrim, back-handling and RTL mirroring it had
                  to reimplement.

                  `drawerType: "slide"` is the push: the whole screen travels with
                  the panel instead of the panel floating over it, which is the
                  movement the app has always had.

                  ⚠️ `(auth)` and `index` turn the swipe OFF. There is no app to
                  index before sign-in, and login / onboarding own their own
                  horizontal gestures. The option is read from the FOCUSED route,
                  so this is per-screen and not a global switch. */}
              <Drawer
                drawerContent={(props) => <AppDrawer {...props} />}
                screenOptions={{
                  headerShown: false,
                  drawerType: "slide",
                  drawerPosition: DRAWER_POSITION,
                  // Transparent: `AppDrawer` paints the panel itself, in the
                  // theme's colours. The navigator's default is the navigation
                  // theme's card colour, which is white in either app theme.
                  drawerStyle: { width: drawerWidth, backgroundColor: "transparent" },
                  swipeEdgeWidth: SWIPE_EDGE_WIDTH,
                  // The writer's keyboard is up more often than not, and dragging
                  // the app aside while it stays is the wrong picture.
                  keyboardDismissMode: "on-drag",
                }}
              >
                <Drawer.Screen name="index" options={{ swipeEnabled: false }} />
                <Drawer.Screen name="(auth)" options={{ swipeEnabled: false }} />
                <Drawer.Screen name="(app)" />
              </Drawer>
              {/* Last child, so it paints over the stack: the seconds between
                  tapping an emailed link and arriving somewhere. */}
              <AuthLinkOverlay />
              {/* Floating chat-head disabled for now — re-add <ChatHead /> here
                  (and its import) to restore the draggable bubble. */}
            </BottomSheetModalProvider>
            </DockToolsSheet>
            </EquationSheet>
            </CaptionSheet>
            </HeaderFooterSheet>
            </BottomInsertDrawer>
          </RootErrorBoundary>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
