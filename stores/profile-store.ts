import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getProfile, updateProfile } from "@/lib/api";
import type { Profile, ProfileUpdate } from "@/types/profile";
import i18n from "@/lib/i18n";
import { profileLanguageToWrite } from "@/lib/profile-language";

// One write at a time per language: a launch fetch and a Settings switch landing
// together must not PUT the same value twice.
let languageInFlight: string | null = null;

interface ProfileState {
  profile: Profile | null;
  isLoading: boolean;
  isSaving: boolean;
  /**
   * Why the last fetch failed, or null if it succeeded. A failed read used to be
   * indistinguishable from "this account has no details yet": the screen showed
   * an empty, editable form, and saving it would PUT those blanks over a profile
   * that was fine on the server. Screens MUST refuse to edit while this is set.
   */
  loadError: string | null;

  fetchProfile: () => Promise<void>;
  saveProfile: (patch: ProfileUpdate) => Promise<{ error: string | null }>;
  /**
   * Line `profiles.language` up with the UI language (defaults to i18next's). The
   * server writes Support threads and pushes in it. Writes ONLY when they differ,
   * and only once the profile has been read — never over an unknown value.
   * Silent: a failure is retried by the next fetch (every launch, every sign-in).
   */
  syncLanguage: (uiLanguage?: string) => Promise<void>;
  reset: () => void; // on logout
}

export const useProfileStore = create<ProfileState>()(
  persist(
    (set, get) => ({
      profile: null,
      isLoading: false,
      isSaving: false,
      loadError: null,

      fetchProfile: async () => {
        set({ isLoading: true, loadError: null });
        try {
          const profile = await getProfile();
          set({ profile, loadError: null });
          // Sign-in and every launch land here: the place the profile catches up
          // with a language chosen before sign-in or while offline.
          void get().syncLanguage();
        } catch (err) {
          // Offline-safe: keep the persisted profile, never throw — but RECORD
          // the failure, so a screen can tell "couldn't reach the server" apart
          // from "this profile is genuinely empty".
          const message = err instanceof Error ? err.message : "Failed to load profile";
          console.warn("[profile] fetch failed", err);
          set({ loadError: message });
        } finally {
          set({ isLoading: false });
        }
      },

      saveProfile: async (patch) => {
        // Optimistic merge so the UI reflects the edit immediately.
        const current = get().profile;
        if (current) set({ profile: { ...current, ...patch } });
        set({ isSaving: true });
        try {
          const updated = await updateProfile(patch);
          set({ profile: updated });
          return { error: null };
        } catch (err) {
          // Roll back the optimistic merge and surface the error to the screen.
          if (current) set({ profile: current });
          const message =
            err instanceof Error ? err.message : "Failed to save profile";
          console.warn("[profile] save failed", err);
          return { error: message };
        } finally {
          set({ isSaving: false });
        }
      },

      syncLanguage: async (uiLanguage) => {
        const current = get().profile;
        if (!current || get().loadError) return;
        const lang = profileLanguageToWrite(uiLanguage ?? i18n.language, current.language);
        if (!lang || languageInFlight === lang) return;
        languageInFlight = lang;
        try {
          const updated = await updateProfile({ language: lang });
          // Only the language: an Edit Profile save may have landed meanwhile.
          const now = get().profile;
          if (now && updated && typeof updated === "object") set({ profile: { ...now, language: (updated as Profile).language ?? lang } });
        } catch (err) {
          console.warn("[profile] language sync failed", err);
        } finally {
          if (languageInFlight === lang) languageInFlight = null;
        }
      },

      reset: () => set({ profile: null, isLoading: false, isSaving: false, loadError: null }),
    }),
    {
      name: "kwill-profile",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ profile: state.profile }),
    }
  )
);
