import { create } from "zustand";

// Open/closed state for the app's navigation drawer.
//
// ⚠️ The drawer itself is NOT ours any more. It is Expo Router's `Drawer`
// navigator (see app/_layout.tsx and https://docs.expo.dev/router/advanced/drawer/),
// which owns the gesture, the slide, the scrim, the hardware back and the RTL
// side. This store is now a thin FAÇADE over it, kept because a dozen call sites
// — the ☰ button, the writer's fling, the dock, the outline panel — ask for the
// drawer imperatively from places that have no navigation prop to hand.
//
// It replaced a hand-rolled `PushDrawer` that duplicated all of the above and
// carried its own Reanimated `progress` / `dragging` shared values. Every bug
// that file accumulated was a synchronisation bug between those values and this
// boolean; there is nothing to synchronise now, because `open` is READ BACK from
// the navigator (see `syncOpen`) rather than being a second source of truth.
//
// The drawer hosts TWO views on the same panel: "app" — the global command list
// (new thesis, tools, recent theses), and "outline" — the thesis structure that
// used to own this drawer outright. Closing always returns to "app" so the next
// open starts from the index, never mid-drill.
export type DrawerView = "app" | "outline";

/**
 * The navigator's imperative handle. Registered by `AppDrawer` — which IS the
 * drawer's content component, so it is handed the navigation object by the
 * navigator itself — and torn down with it.
 *
 * Null until the drawer navigator has mounted (i.e. while the splash screen is
 * still up). Every action below is a no-op in that window, which is correct:
 * there is no drawer to open yet.
 */
type DrawerControls = { open: () => void; close: () => void; toggle: () => void };

let controls: DrawerControls | null = null;

export function registerDrawerControls(next: DrawerControls | null) {
  controls = next;
}

interface NavDrawerState {
  open: boolean;
  view: DrawerView;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  setView: (view: DrawerView) => void;
  /** Open straight onto a view — used by the workspace's Contents button. */
  openView: (view: DrawerView) => void;
  /**
   * Mirror the navigator's own status into the store. ⚠️ Called ONLY by
   * `AppDrawer`'s `useDrawerStatus()` effect — never from a screen. Opening and
   * closing go through the actions above, which ask the navigator; this is how
   * the answer comes back.
   */
  syncOpen: (open: boolean) => void;
}

/**
 * Force the drawer shut, ignoring what the store currently believes.
 *
 * Used on every return to the foreground: a slide interrupted by another
 * activity (the document picker Import and Combine open, the share sheet) can
 * come back part-finished, and returning to a closed drawer is always right.
 * Cheap to ask for when it is already closed — the navigator ignores it.
 */
export function forceCloseDrawer() {
  controls?.close();
}

export const useNavDrawerStore = create<NavDrawerState>((set, get) => ({
  open: false,
  view: "app",
  openDrawer: () => controls?.open(),
  closeDrawer: () => controls?.close(),
  toggleDrawer: () => controls?.toggle(),
  setView: (view) => set({ view }),
  openView: (view) => {
    // View first, then the slide: the panel has to be showing the right thing
    // before it starts moving, or the student watches it swap mid-animation.
    set({ view });
    controls?.open();
  },
  syncOpen: (open) => {
    if (get().open === open) return;
    // Reset the inner view on close, not on open: resetting on open would swap
    // the panel's content in the same frame the slide starts, which reads as a
    // flicker.
    set(open ? { open: true } : { open: false, view: "app" });
  },
}));
