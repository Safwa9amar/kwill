# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## This repo is one of three

Kwill (formerly Modakerati) is an Expo app for Algerian university students writing their thesis (mémoire/مذكرة). It cannot be understood alone — three sibling repos under `~/` share **one Supabase project** (`janzgpfnjzihelcwmkkg`):

| Repo | What it owns |
|---|---|
| `~/kwill` (here) | Expo React Native app — the student-facing product |
| `~/kwill-server` | Hono API + **all AI tools and prompts** + the .docx engine integration |
| `~/kwill-dashboard` | Next.js staff console (Vercel, deploys on push to `master`) |
| `~/mdocxengine` | The OOXML engine (`Doc`, part managers, the docx "doctor") |

The AI's behaviour lives in the **server**, not here. A change to what the assistant says or does is `~/kwill-server/src/lib/ai/` — this repo only renders it.

## Verification

**This app runs Vitest for PURE modules only** (`npx vitest run`; the allow-list is in `vitest.config.ts` — anything importing `react-native` cannot run under node). There is no lint config. The gate before claiming anything works is:

```bash
npx tsc --noEmit          # the only automated check that exists here
npx vitest run              # pure lib modules (docx-editor bridge, block ids)
```

The server and dashboard *do* have vitest:

```bash
cd ~/kwill-server && npx vitest run                                    # full suite (~1000 tests)
cd ~/kwill-server && npx vitest run src/lib/ai/__tests__/foo.test.ts   # one file
```

Some server suites are slow under full-suite load and time out at the 5s default; re-run with `--testTimeout=60000` before treating a timeout as a failure.

## Commands

```bash
npm start                    # Expo dev server
npm run android / npm run ios
./scripts/dev-net.sh         # after a Wi-Fi change: repoint .env files, Supabase, server, adb
./scripts/build-apk.sh       # prod-signed release APK (local Gradle, not EAS Build)
./scripts/publish-update.sh "what changed" [channel]   # OTA via EAS Update
```

### Releasing

Order matters and is not negotiable: **commit → build the APK → verify its fingerprint → publish the OTA.** A Gradle release build rewrites a file inside `node_modules` that is a fingerprint input, so the runtime version differs before and after every build. Publishing first orphans the binary you are about to ship.

- `runtimeVersion` is `{"policy":"fingerprint"}`. Only binaries at the *same* fingerprint are offered an update. A JS-only change leaves it unmoved, so no rebuild is needed — resolve it and compare before publishing:
  ```bash
  npx expo-updates runtimeversion:resolve --platform android
  unzip -p android/app/build/outputs/apk/release/app-release.apk assets/fingerprint
  ```
- Gradle can package a **stale cached fingerprint**. Verify the two above match on every release build; `BUILD SUCCESSFUL` is not evidence.
- `EXPO_PUBLIC_*` values are **inlined into the bundle**. Publishing with the working `.env` points every installed app at your LAN box. `publish-update.sh` swaps in `.env.production` for you — use it rather than calling `eas update` directly.
- `app.json` and `eas.json` are fingerprint inputs. Editing either cuts every installed binary off from future updates.

## The document model

A thesis is a **live .docx**, and the app addresses it as an ordered list of blocks (`DocBlockDTO` in [lib/api.ts](lib/api.ts)) — paragraph / table / image / chart / textbox, each with an integer `index`.

Two consequences that bite:

- **Indices shift.** Blocks have no stable id. Anything that stores an index for later (a chat message, a cached anchor) must tolerate the document changing underneath it — see [lib/block-links.ts](lib/block-links.ts) for the pattern: trust the index while its text still matches, otherwise re-find by label.
- **Indices are machinery.** The student must never see one. The server strips them (`no-index-leak.ts`); when the AI needs to point at a place it emits a `modk://b/N` link that the app renders as a tap.

Editing is optimistic and local-first (`stores/thesis-doc-store.ts`); mutations queue durably and endpoints echo back the mutated document.

## Conventions

- **State is Zustand**, one store per concern in [stores/](stores/). Select **primitives**, never a fresh object literal — `useStore(s => ({a: s.a}))` returns a new reference every render and throws "Maximum update depth exceeded".
- **Colors come from `useThemeColors()`**, never hardcoded. Same for typography in [constants/](constants/).
- **Trilingual: ar / fr / en.** ⚠️ The locale JSONs contain ~155 duplicate keys each. `json.load`/`json.dump` silently drops them — **edit these files surgically**, never by round-tripping.
- **RTL is content-driven, not locale-driven.** A thesis's language field is unreliable; direction is detected from the text so an Arabic answer stays RTL in an English UI. Physical `left`/`right` styles are swapped by `I18nManager` — use the helpers in `lib/rtl-layout.ts` rather than raw values.
- **Adding an AI document tool touches three places in the server**: register it in `src/mcp/tools/`, gate it in `LIVE_DOCX_TOOLS` (`mcp-tool-sets.ts`), and describe it in the prompt catalogue (`src/lib/ai/types.ts`). ⚠️ That catalogue is one big template literal — an unescaped backtick breaks the build and vitest blames a dozen unrelated suites.
- Design docs live in `docs/superpowers/specs/` (what and why) and `docs/superpowers/plans/` (how), dated. Worth reading the relevant one before changing a subsystem.
