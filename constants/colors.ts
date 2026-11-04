/**
 * The brand color, theme-independent. `useThemeColors()` is the way to reach it
 * from a component; this literal exists for the places a hook can't go —
 * StyleSheet.create at module scope, WebView CSS strings, Reanimated worklets,
 * native channel config. Never re-type the hex at a call site.
 */
export const brand = {
  primary: "#F59433",
  /** Lighter tint — safe as ink on a DARK surface, and as a low-alpha wash. */
  primaryLight: "#FFB166",
  /** Deeper shade — brand ink that stays readable on a LIGHT surface. */
  primaryDeep: "#C2670C",
  /** Ink that sits ON a brand fill — button labels, the ✦ bubble's glyph.
   *  One place to flip if the fill ever wants dark ink instead. */
  onPrimary: "#FFFFFF",
} as const;

/** "#F59433" → "245,148,51", for rgba() strings whose alpha is animated. */
export function rgbTriplet(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

export const colors = {
  dark: {
    bgPrimary: "#121220",
    bgSurface: "#232338",
    bgCard: "#1C1C2E",
    bgModal: "#171726",
    bgInput: "#1A1A28",
    textPrimary: "#FFFFFF",
    textSecondary: "#9999AE",
    textPlaceholder: "#666678",
    brandPrimary: brand.primary,
    brandPrimaryLight: brand.primaryLight,
    brandOnPrimary: brand.onPrimary,
    brandAccent: "#33D6A6",
    semanticSuccess: "#33D6A6",
    semanticWarning: "#FF9933",
    semanticError: "#FF5959",
    // Only the TYPING indicator and the loading skeleton still draw an assistant
    // surface — a finished answer sits on the page itself (components/chat/MessageBubble).
    chatAiBubble: "#1E2138",
    // Deliberately NOT the brand: a brand-filled bubble turns every message the
    // student sends into an accent, and white on the brand orange is only 2.3:1.
    // A neutral slate instead — a soft lift off bgPrimary rather than the heavy
    // chip it used to be (#414962), since it is now the only tinted surface in
    // the transcript and has nothing to be told apart FROM. 10.7:1 under white.
    chatUserBubble: "#282E42",
    chatUserText: "#FFFFFF",
    navBar: "#212133",
    navInactive: "#8D8D9E",
    navInactiveLabel: "#737385",
    borderDefault: "#333346",
    borderSubtle: "#232338",
    // Rescue v2 (the one-screen rescue). The paper stays light in dark mode: it is paper.
    rescueStageTop: "#17172A", rescueStageBottom: "#1B1B30", rescuePaper: "#FCFBF8", rescuePaperInk: "#2A2A36",
    brandWash: `rgba(${rgbTriplet(brand.primary)},0.18)`, successWash: "rgba(51,214,166,0.16)",
  },
  light: {
    bgPrimary: "#FAFAFE",
    bgSurface: "#F0F0F5",
    bgCard: "#FFFFFF",
    bgModal: "#F8F8FA",
    bgInput: "#F2F2F7",
    textPrimary: "#1A1A26",
    textSecondary: "#737385",
    textPlaceholder: "#A6A6B3",
    brandPrimary: brand.primary,
    // The "light" variant is the brand *ink* — links, action labels. On a white
    // card the tint is unreadable, so the light theme darkens instead.
    brandPrimaryLight: brand.primaryDeep,
    brandOnPrimary: brand.onPrimary,
    brandAccent: "#26B88C",
    semanticSuccess: "#26B88C",
    semanticWarning: "#E69919",
    semanticError: "#E64040",
    chatAiBubble: "#EDEEF8",
    // A WASH, not a fill. The dark slate this replaces (#343A4D) was the only
    // heavy block on a white page and it made a one-line question shout louder
    // than the answer under it. Same cool family, now a tint the answer's own
    // ink reads comfortably on (14.6:1).
    chatUserBubble: "#E8ECF8",
    chatUserText: "#1A1A26",
    navBar: "#FFFFFF",
    navInactive: "#8D8D9E",
    navInactiveLabel: "#737385",
    borderDefault: "#E0E0E6",
    borderSubtle: "#EDEDF0",
    // Rescue v2 (the one-screen rescue). The paper stays light in both themes: it is paper.
    rescueStageTop: "#ECECF3", rescueStageBottom: "#F4F4F8", rescuePaper: "#FCFBF8", rescuePaperInk: "#2A2A36",
    brandWash: `rgba(${rgbTriplet(brand.primary)},0.13)`, successWash: "rgba(38,184,140,0.13)",
  },
} as const;

export type ThemeColors = { readonly [K in keyof typeof colors.dark]: string };
export type ThemeName = keyof typeof colors;
