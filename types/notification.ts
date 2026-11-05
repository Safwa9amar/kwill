export type NotificationType =
  | "ai_complete" | "export" | "payment" | "system"
  | "grammar" | "template" | "subscription" | "welcome" | "rescue" | "tasks_complete";

export interface NotificationData {
  route?: string;        // expo-router path to navigate to on tap
  thesisId?: string;
  [key: string]: unknown;
}

export interface AppNotification {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  type: NotificationType | null;
  isRead: boolean;
  data: NotificationData | null;
  createdAt: string;     // ISO timestamp
}

export interface NotificationPreferences {
  pushEnabled: boolean;
  aiSuggestions: boolean;
  exportReminders: boolean;
  marketing: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  pushEnabled: true,
  // Disabled by default — the user opts in to AI suggestions (in-app chips +
  // title autocomplete + AI push notifications).
  aiSuggestions: false,
  exportReminders: false,
  marketing: false,
};
