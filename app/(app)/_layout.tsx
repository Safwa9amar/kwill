import { Stack } from "expo-router";

// `gestureEnabled: false` — the LEADING EDGE BELONGS TO THE DRAWER. The native
// stack's interactive back-swipe lives in the same strip and, on any screen with
// something behind it, wins the touch, so the edge-swipe appeared to work on the
// workspace (stack root, nothing to pop) and nowhere else. Going back is the back
// arrow's job now, and every screen the drawer opens has one.
// The three destinations that hang off an assistant answer (see
// components/chat/MessageActions). They GROW OUT OF THE CHIP that opened them
// and collapse back into it on close, so the chat reads as the place they came
// from rather than as somewhere the navigator moved on from.
//
// The native transition is switched OFF here on purpose. That movement is not a
// stack animation — it is anchored to a point the navigator knows nothing about
// — so it is done by `components/ZoomFromOrigin`, which each of these three
// screens wraps its content in. Leaving a native animation on would run a slide
// underneath the zoom and the two would fight.
//
// `animation: "none"`, NOT `presentation: "modal"`, for the separate reason that
// the drawer is not part of this navigator: it is the `Drawer` navigator this
// whole stack is a SCREEN OF (see app/_layout.tsx), which slides the stack aside
// as one piece with the panel beside it. A native modal is presented above that
// entire arrangement, so a modal screen's hamburger — and the hamburger on
// anything pushed onward from it, the Writer opened from the Library or from a
// task run — would open the drawer BEHIND the sheet.
const FROM_CHAT = { animation: "none" } as const;

export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: "none", gestureEnabled: false }}>
    <Stack.Screen name="settings" />
    <Stack.Screen name="delete-account" />
    <Stack.Screen name="terms-of-service" />
    <Stack.Screen name="privacy-policy" />
    <Stack.Screen name="edit-profile" />
    <Stack.Screen name="subscription" />
    {/* No in-app checkout screen: card details are collected by Chargily's own
        hosted page, opened from `subscription`. The app never touches a PAN. */}
    <Stack.Screen name="payment-success" />
    <Stack.Screen name="payment-failed" />
    <Stack.Screen name="start-thesis" />
    <Stack.Screen name="browse-templates" />
    <Stack.Screen name="university-templates" />
    <Stack.Screen name="thesis-title" />
    <Stack.Screen name="template-preview" />
    <Stack.Screen name="thesis-plan" />
    <Stack.Screen name="thesis-detail" />
    <Stack.Screen name="thesis-workspace"  options={FROM_CHAT} />
    <Stack.Screen name="block-editor" />
    <Stack.Screen name="lexical-lab" />
    <Stack.Screen name="lexical-roundtrip" />
    <Stack.Screen name="lexical-writeback" />
    <Stack.Screen name="voice-lab" />
    <Stack.Screen name="word-trial" />
    <Stack.Screen name="news" />
    <Stack.Screen name="news-detail" />
    <Stack.Screen name="export" />
    <Stack.Screen name="export-success" />
    <Stack.Screen name="network-error" />
    <Stack.Screen name="import-analysis" />
    <Stack.Screen name="combine-arrange" />
    {/* Former tab screens — every page is a push from the drawer now. */}
    <Stack.Screen name="chat" />
    <Stack.Screen name="chat-guide" />
    {/* Support Center — hub, the two guides, FAQ and the ticket screens. */}
    <Stack.Screen name="support" />
    <Stack.Screen name="support-guide" />
    <Stack.Screen name="support-faq" />
    <Stack.Screen name="support-contact" />
    <Stack.Screen name="support-thread" />
    <Stack.Screen name="notifications" />
    <Stack.Screen name="account" />
    <Stack.Screen name="library" options={FROM_CHAT} />
    <Stack.Screen name="tasks" options={FROM_CHAT} />
    <Stack.Screen name="ai-key" />
    {/* Rescue v2: one living screen. Its own Stack (app/(app)/rescue/_layout.tsx) turns off the gestures and the drawer swipe. */}
    <Stack.Screen name="rescue" />
  </Stack>;
}
