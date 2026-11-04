import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The app had no test runner until the docx-editor migration. This runs PURE
// modules only — no React Native, no Expo, no DOM — which is why `include` is a
// short allow-list rather than a glob over the repo: `lib/` is full of modules
// that import `react-native` at the top, and importing one under node fails
// before the first assertion. Add a path here when you add a pure module with a
// test beside it; do not widen the glob.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    include: [
      "lib/docx-block-id.test.ts",
      "lib/rescue-v2-screen.test.ts",
      "lib/rescue-v2-layout.test.ts",
      "lib/rescue-v2-upload.test.ts",
      "lib/rescue-v2-locales.test.ts",
      "lib/rescue-v2-pick.test.ts",
      "lib/rescue-v2-errors.test.ts",
      "lib/rescue-v2-lost-upload.test.ts",
      "lib/thesis-open-check.test.ts",
      "stores/rescue-revisions-ui.test.ts",
      "stores/rescue-confirm-ui.test.ts",
      "lib/export-filename.test.ts",
      "lib/rescue-v2-confirm.test.ts",
      "lib/rescue-v2-finish.test.ts",
      "lib/rescue-v2-history.test.ts",
      "lib/rescue-v2-diagnosis.test.ts",
      "lib/rescue-v2-payment.test.ts",
      "stores/rescue-v2-store.test.ts",
      "stores/rescue-history-ui.test.ts",
      "stores/rescue-payment-ui.test.ts",
      "stores/rescue-diagnosis-view.test.ts",
      "lib/rescue-v2-note-cta.test.ts",
      "stores/rescue-note-draft.test.ts",
      "stores/rescue-preview-view.test.ts",
      "hooks/useRescueBack.test.ts",
      "components/workspace/docx-editor/bridge/**/*.test.ts",
      "components/workspace/docx-editor/overlays/**/*.test.ts",
      "components/workspace/docx-editor/host/**/*.test.ts",
      "components/workspace/docx-editor/features/scroll-anchor.test.ts",
      "components/workspace/docx-editor/features/swipe.test.ts",
    ],
    exclude: ["**/node_modules/**", "android/**", "ios/**", "dist/**"],
    passWithNoTests: true,
  },
});
