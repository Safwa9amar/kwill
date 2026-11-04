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
