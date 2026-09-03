// When Supabase will not send the mail, our own server does.
//
// Supabase caps a project at 2 auth emails an hour and the limit is not
// raisable without custom SMTP on the Supabase side. A student mid-reset does
// not care whose quota ran out — they just never receive anything.
//
// The server route (POST /auth/recovery-link in ~/kwill-server) mints the
// SAME link through Supabase's admin API, which generates without sending and so
// costs nothing from that allowance, and mails it from our own domain. Supabase's
// configuration is untouched, which is the point: this is a fallback, not a
// replacement.
import i18n from "./i18n";
import { authCallbackUrl } from "./auth-link";
import type { PendingAuthFlow } from "./auth-link";

/**
 * Ask our server to send the link instead.
 *
 * Returns true only when a message actually went out. `false` means the student
 * must still be told the truth — the server may have no SMTP configured, in
 * which case this whole path is inert and the Supabase error stands.
 */
export async function sendAuthLinkViaServer(
  email: string,
  flow: PendingAuthFlow,
): Promise<boolean> {
  const base = process.env.EXPO_PUBLIC_API_URL;
  if (!base) return false;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/auth/recovery-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No auth header, and none is possible: whoever is asking has no session.
      // The route is rate-limited server-side for exactly that reason.
      // The UI language rides along so the mail arrives in ONE language. The
      // trilingual version Gmail received was filed as spam and rendered its
      // Arabic as .notdef boxes; the server cannot guess, but the app knows.
      body: JSON.stringify({
        email: email.trim(),
        flow,
        lang: i18n.language,
        redirectTo: authCallbackUrl(),
      }),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    // Offline, or the server is down. The caller keeps Supabase's message.
    return false;
  }
}

/**
 * Is this the failure the fallback exists for?
 *
 * Narrow on purpose. A refused address or a malformed request must NOT trigger a
 * second attempt down another road — only the case where Supabase was willing
 * but rationed.
 */
export function isMailQuotaFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return /rate limit|too many requests|for security purposes|only request this after|over_email_send/i.test(
    message,
  );
}
