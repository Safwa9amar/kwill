import { Platform } from "react-native";

// Apple guideline 3.1.1: digital content on iOS may only be sold through
// Apple's In-App Purchase, and the app may not sell another way OR steer to
// one — no prices, no "buy"/"renew"/"upgrade" wording, no link to the website.
// (App Review rejected 1.0 (1) for exactly this, 2026-09-01.)
//
// So on iOS the app shows plan STATUS only: what the student has, never how to
// buy more. Purchasing happens on Android and the web, and the entitlement
// follows the account (guideline 3.1.3(b), multiplatform services). The student
// is told by EMAIL — allowed, because anti-steering stops at the app's edge.
//
// Every surface that sells or names a purchase must branch on this constant,
// not on Platform.OS directly: if StoreKit ever ships, this is the one switch.
export const PURCHASES_HIDDEN = Platform.OS === "ios";
