import { create } from "zustand";
import { supabase } from "@/lib/supabase";
import { signInWithGoogle as runGoogleSignIn } from "@/lib/google-auth";
import { signInWithApple as runAppleSignIn } from "@/lib/apple-auth";
import { useProfileStore } from "@/stores/profile-store";
import type { GoogleSignInResult } from "@/lib/google-auth";
import type { AppleSignInResult } from "@/lib/apple-auth";
import type { Session, User } from "@supabase/supabase-js";

import { authCallbackUrl, markPendingAuthLink } from "@/lib/auth-link";
import { retryingOnLostConnection } from "@/lib/auth-retry";
import { sendAuthLinkViaServer, isMailQuotaFailure } from "@/lib/auth-fallback";
import type { PendingAuthFlow } from "@/lib/auth-link";

export interface SignUpResult {
  error: string | null;
  /** Supabase returned a user but no session — the address must be confirmed first. */
  needsVerification: boolean;
  /**
   * The address already has an account. Supabase does NOT error on this (it
   * would let anyone enumerate registered emails); it returns a user with an
   * empty `identities` array instead. That is the only signal there is.
   */
  alreadyRegistered: boolean;
}

interface AuthState {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /**
   * A password reset is in flight. Spending the emailed link SIGNS THE STUDENT
   * IN — that session is how Supabase authorises the password change that
   * follows — so without this flag `useProtectedRoute` would see
   * `isAuthenticated` flip and throw them into the app one screen BEFORE they
   * set the new password, with the old one still on the account. It is read by
   * the route guard in app/_layout.tsx and by nothing else.
   */
  recoveryMode: boolean;
  /**
   * A link is being spent right now — the network round trip between tapping the
   * email and landing on a screen. Non-null drives the full-screen overlay in
   * app/_layout.tsx: without it the app sits on whatever screen it cold-started
   * to, for a second or more, looking like the link did nothing.
   */
  linkSignIn: PendingAuthFlow | null;
  setLinkSignIn: (flow: PendingAuthFlow | null) => void;
  setSession: (session: Session | null) => void;
  signInWithEmail: (email: string, password: string) => Promise<{ error: string | null }>;
  signUpWithEmail: (
    email: string,
    password: string,
    fullName: string,
    university?: { id: string; name: string } | null
  ) => Promise<SignUpResult>;
  signInWithGoogle: () => Promise<GoogleSignInResult>;
  signInWithApple: () => Promise<AppleSignInResult>;
  signOut: () => Promise<void>;
  initialize: () => Promise<void>;
  /** Step 1 of recovery: mail a link back into the app. */
  requestPasswordReset: (email: string) => Promise<{ error: string | null }>;
  /** Mail another one. Supabase rate-limits this to roughly one a minute. */
  resendAuthEmail: (email: string, flow: PendingAuthFlow) => Promise<{ error: string | null }>;
  /**
   * Step 2 happens outside this store: the link re-enters the app and
   * lib/auth-deeplink.ts trades its code for a session, raising the guard first.
   */
  beginRecovery: () => void;
  /** Step 3: write the new password onto the session the link opened. */
  updatePassword: (password: string) => Promise<{ error: string | null }>;
  /** Step 4: the password is changed — release the guard and let them into the app. */
  finishRecovery: () => void;
  /** Backing out mid-flow: drop the half-authorised session instead of stranding it. */
  abandonRecovery: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  user: null,
  isLoading: true,
  isAuthenticated: false,
  recoveryMode: false,
  linkSignIn: null,
  setLinkSignIn: (flow) => set({ linkSignIn: flow }),
  setSession: (session) => set({ session, user: session?.user ?? null, isAuthenticated: !!session, isLoading: false }),
  signInWithEmail: async (email, password) => {
    // Retried: a dropped connection here used to read as a refused password.
    const { error } = await retryingOnLostConnection(() =>
      supabase.auth.signInWithPassword({ email, password }),
    );
    return { error: error?.message ?? null };
  },
  // The university rides along in user_metadata because at signup there is no
  // session yet to PATCH a profile with — the DB trigger that creates the
  // profile row reads it from there (see supabase/migrations/003_profile_university.sql).
  // If that migration has not been applied the extra keys are simply ignored and
  // start-thesis asks for the institution inline instead; nothing breaks.
  signUpWithEmail: async (email, password, fullName, university) => {
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        // Same link mechanism as recovery, for the same reason — so a confirmed
        // address lands back INSIDE the app rather than on a web page.
        emailRedirectTo: authCallbackUrl(),
        data: {
          full_name: fullName,
          ...(university ? { university: university.name, university_id: university.id } : {}),
        },
      },
    });
    if (error) {
      // Supabase was willing but rationed — 2 messages an hour, project-wide.
      // GoTrue inserts the user BEFORE it tries to send, so the account exists
      // and is merely unconfirmed; our server can mail it a magic link, which
      // stamps email_confirmed_at on the way in. Same outcome, our own mailbox.
      if (isMailQuotaFailure(error.message) && (await sendAuthLinkViaServer(email, "signup"))) {
        await markPendingAuthLink("signup");
        return { error: null, needsVerification: true, alreadyRegistered: false };
      }
      return { error: error.message, needsVerification: false, alreadyRegistered: false };
    }
    // Three outcomes, and the caller has to tell them apart because each sends
    // the student somewhere different. Confirmations OFF → a session comes back
    // and they are already in. Confirmations ON → a user with no session, so the
    // check-email screen is next. Address already taken → a decoy user whose
    // `identities` list is empty and whose email never receives anything.
    const alreadyRegistered = !data.session && (data.user?.identities?.length ?? 0) === 0;
    const needsVerification = !alreadyRegistered && !data.session && !!data.user;
    // Only when a confirmation mail actually went out. Marking it otherwise
    // would leave a flag that makes the next Google callback look like ours.
    if (needsVerification) await markPendingAuthLink("signup");
    return { error: null, needsVerification, alreadyRegistered };
  },
  // No `set` here on the way out: the session is written by
  // exchangeCodeForSession inside the browser flow, and onAuthStateChange (wired
  // up in initialize) is what lands it on this store. Setting it twice would
  // race the listener for the same value.
  signInWithGoogle: async () => runGoogleSignIn(),
  signInWithApple: async () => runAppleSignIn(),
  signOut: async () => {
    // Detach this device's push token from the account first, while the session still authorises the call: left in place, the
    // signed-out account's pushes kept arriving here. Lazy import (push-notifications pulls in stores that read this one), and
    // bounded, so a slow network never holds the logout.
    if (get().session) {
      await Promise.race([
        import("@/lib/push-notifications").then((m) => m.unregisterCurrentPushToken()).catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 4000)),
      ]);
    }
    await supabase.auth.signOut();
    useProfileStore.getState().reset();
    set({ session: null, user: null, isAuthenticated: false, recoveryMode: false });
  },
  initialize: async () => {
    const { data: { session } } = await supabase.auth.getSession();
    get().setSession(session);
    supabase.auth.onAuthStateChange((_event, session) => { get().setSession(session); });
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Password recovery: mail a link → the link re-opens the app → set the new
  // password in the app → done.
  //
  // Link-based rather than a typed code, because a code has to be written into
  // the email template and Supabase locks template editing behind custom SMTP.
  // The stock template already sends a link, so this works on the free built-in
  // mailer with no project configuration at all — the redirect target
  // (`kwill://`) is already allow-listed, or Google sign-in would not work.
  //
  // The password itself is changed IN THE APP, never in a browser: the link
  // carries a one-shot PKCE code, and the app is what spends it.
  // ───────────────────────────────────────────────────────────────────────────
  requestPasswordReset: async (email) => {
    // Recorded before the mail is sent, and durably: the student will leave for
    // a mail app and may not come back for an hour, long after this process is
    // gone. Without it the returning link cannot be told apart from a Google
    // callback — under PKCE both arrive as a bare `?code=`.
    await markPendingAuthLink("recovery");
    set({ recoveryMode: true });
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: authCallbackUrl(),
    });
    if (!error) return { error: null };
    // Supabase was willing but rationed — 2 messages an hour, project-wide, and
    // not raisable from here. Our own server can mint the same link without
    // spending that allowance and mail it itself. Only for the quota failure: a
    // malformed address must not be retried down a second road.
    if (isMailQuotaFailure(error.message) && (await sendAuthLinkViaServer(email, "recovery"))) {
      return { error: null };
    }
    return { error: error.message };
  },
  resendAuthEmail: async (email, flow) => {
    const address = email.trim();
    await markPendingAuthLink(flow);
    const { error } =
      flow === "signup"
        ? await supabase.auth.resend({
            type: "signup",
            email: address,
            options: { emailRedirectTo: authCallbackUrl() },
          })
        : await supabase.auth.resetPasswordForEmail(address, {
            redirectTo: authCallbackUrl(),
          });
    if (!error) return { error: null };
    // Same fallback on the resend button, which is where a rationed student
    // lands most often — they are already staring at "check your email".
    if (isMailQuotaFailure(error.message) && (await sendAuthLinkViaServer(address, flow))) {
      return { error: null };
    }
    return { error: error.message };
  },
  beginRecovery: () => set({ recoveryMode: true }),
  updatePassword: async (password) => {
    // Retried: setting the same password twice is the same outcome, and losing
    // this call strands the student on a spent link with the old password.
    const { error } = await retryingOnLostConnection(() =>
      supabase.auth.updateUser({ password }),
    );
    return { error: error?.message ?? null };
  },
  finishRecovery: () => set({ recoveryMode: false }),
  abandonRecovery: async () => {
    // ⚠️ NOT WHILE A LINK IS STILL BEING SPENT. The login screen calls this on
    // mount, and on a cold start the route guard puts the student ON login for a
    // beat before the exchange finishes — so this fired mid-flow, signed them
    // out, and left them staring at the login form with the reset never applied.
    // `linkSignIn` is raised before recoveryMode is, so it closes that window
    // completely; the deep-link handler owns the outcome until it clears.
    if (get().linkSignIn) return;
    if (!get().recoveryMode) return;
    set({ recoveryMode: false });
    // If the code was already verified there is a live session on an account
    // whose password never changed. Leaving it signed in would turn "I gave up
    // halfway" into a silent login, so it goes.
    if (get().session) await get().signOut();
  },
}));
