import { useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import {
  Sparkles,
  Download,
  CreditCard,
  Bell,
  BellOff,
  SpellCheck,
  LayoutTemplate,
  Crown,
  PartyPopper,
  CheckCheck,
  Trash2,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { BackButton } from "@/components/BackButton";
import { Card } from "@/components/ui/Card";
import { NotificationsSkeleton } from "@/components/skeletons/NotificationsSkeleton";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNotificationStore } from "@/stores/notification-store";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";
import { isPublishHeld, notifyRoute } from "@/lib/rescue-v2-notify";
import type {
  AppNotification,
  NotificationType,
} from "@/types/notification";
import type { ThemeColors } from "@/constants/colors";

// ── Type → icon + theme color ────────────────────────────────────────────────
function iconFor(
  type: NotificationType | null,
  colors: ThemeColors
): { Icon: LucideIcon; color: string } {
  switch (type) {
    case "ai_complete":
      return { Icon: Sparkles, color: colors.brandPrimary };
    case "export":
      return { Icon: Download, color: colors.semanticSuccess };
    case "payment":
      return { Icon: CreditCard, color: colors.brandAccent };
    case "grammar":
      return { Icon: SpellCheck, color: colors.semanticWarning };
    case "template":
      return { Icon: LayoutTemplate, color: colors.brandPrimary };
    case "subscription":
      return { Icon: Crown, color: colors.semanticWarning };
    case "welcome":
      return { Icon: PartyPopper, color: colors.brandPrimary };
    case "system":
    default:
      return { Icon: Bell, color: colors.textSecondary };
  }
}

// ── Time grouping ────────────────────────────────────────────────────────────
type Bucket = "today" | "yesterday" | "earlier";

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function bucketFor(iso: string): Bucket {
  const created = startOfDay(new Date(iso));
  const today = startOfDay(new Date());
  const dayMs = 24 * 60 * 60 * 1000;
  if (created >= today) return "today";
  if (created >= today - dayMs) return "yesterday";
  return "earlier";
}

const BUCKET_ORDER: Bucket[] = ["today", "yesterday", "earlier"];

function groupByTime(
  notifications: AppNotification[]
): { bucket: Bucket; items: AppNotification[] }[] {
  const groups: Record<Bucket, AppNotification[]> = {
    today: [],
    yesterday: [],
    earlier: [],
  };
  for (const n of notifications) {
    groups[bucketFor(n.createdAt)].push(n);
  }
  return BUCKET_ORDER.filter((b) => groups[b].length > 0).map((bucket) => ({
    bucket,
    items: groups[bucket],
  }));
}

export default function NotificationsScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const router = useRouter();
  // The floating tab bar is gone, so scroll content only has to clear the home
  // indicator now — not a bar hovering over it.
  const bottomPad = useSafeAreaInsets().bottom + 24;

  // Select slices individually — never build new objects/arrays in a selector.
  const notifications = useNotificationStore((s) => s.notifications);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const isLoading = useNotificationStore((s) => s.isLoading);
  const isRefreshing = useNotificationStore((s) => s.isRefreshing);
  const isLoadingMore = useNotificationStore((s) => s.isLoadingMore);
  const fetchNotifications = useNotificationStore((s) => s.fetchNotifications);
  const loadMore = useNotificationStore((s) => s.loadMore);
  const markAsRead = useNotificationStore((s) => s.markAsRead);
  const markAllAsRead = useNotificationStore((s) => s.markAllAsRead);
  const remove = useNotificationStore((s) => s.remove);

  useFocusEffect(
    useCallback(() => {
      fetchNotifications();
    }, [fetchNotifications])
  );

  // Relative time, translated.
  const relativeTime = useCallback(
    (iso: string): string => {
      const diffMs = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return t("notifications.justNow");
      if (mins < 60) return t("notifications.minutesAgo", { count: mins });
      const hours = Math.floor(mins / 60);
      if (hours < 24) return t("notifications.hoursAgo", { count: hours });
      const days = Math.floor(hours / 24);
      return t("notifications.daysAgo", { count: days });
    },
    [t]
  );

  const handlePress = useCallback(
    (item: AppNotification) => {
      if (!item.isRead) markAsRead(item.id);
      const route = item.data?.route;
      if (typeof route === "string") {
        router.push(notifyRoute(route, item.data, RESCUE_V2_ENABLED) as never);
      }
    },
    [markAsRead, router]
  );

  const renderRightActions = useCallback(
    (id: string) => (
      <Pressable
        onPress={() => remove(id)}
        style={[styles.deleteAction, { backgroundColor: colors.semanticError }]}>
        <Trash2 size={20} color="#FFFFFF" />
      </Pressable>
    ),
    [remove, colors.semanticError]
  );

  const renderItem = useCallback(
    ({ item }: { item: AppNotification }) => {
      const { Icon, color } = iconFor(item.type, colors);
      const unread = !item.isRead;
      // A held publish carries the app's own words (plan P-45 and §1.8): the server's copy is the fallback for every other event.
      const held = isPublishHeld(item.data);
      const title = held ? t("rescueV2.notify.publishHeldTitle") : item.title;
      const description = held ? t("rescueV2.notify.publishHeldBody") : item.description;
      return (
        <ReanimatedSwipeable
          friction={2}
          rightThreshold={40}
          renderRightActions={() => renderRightActions(item.id)}
          containerStyle={styles.swipeContainer}>
          <Pressable onPress={() => handlePress(item)}>
            <Card
              borderColor={unread ? color : undefined}
              style={[
                styles.notifCard,
                {
                  backgroundColor: unread ? colors.bgCard : "transparent",
                  borderWidth: unread ? 1 : 0,
                },
              ]}>
              <View style={styles.notifRow}>
                <View style={[styles.iconBox, { backgroundColor: color + "26" }]}>
                  <Icon size={18} color={color} />
                </View>
                <View style={styles.notifContent}>
                  <View style={styles.notifTitleRow}>
                    <Text
                      style={[
                        styles.notifTitle,
                        { color: colors.textPrimary },
                        unread && { fontFamily: "Inter_600SemiBold" },
                      ]}
                      numberOfLines={1}>
                      {title}
                    </Text>
                    {unread && (
                      <View style={[styles.dot, { backgroundColor: color }]} />
                    )}
                  </View>
                  {description ? (
                    <Text
                      style={[styles.notifDesc, { color: colors.textSecondary }]}
                      numberOfLines={2}>
                      {description}
                    </Text>
                  ) : null}
                  <Text
                    style={[styles.notifTime, { color: colors.textPlaceholder }]}>
                    {relativeTime(item.createdAt)}
                  </Text>
                </View>
              </View>
            </Card>
          </Pressable>
        </ReanimatedSwipeable>
      );
    },
    [colors, handlePress, relativeTime, renderRightActions, t]
  );

  const sections = groupByTime(notifications).map((g) => ({
    bucket: g.bucket,
    data: g.items,
  }));
  const showLoading = isLoading && notifications.length === 0;
  const showEmpty = !isLoading && notifications.length === 0;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      edges={["top"]}>
      <View style={styles.header}>
        <BackButton />
        <View style={styles.headerCenter}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>
            {t("notifications.title")}
          </Text>
          {unreadCount > 0 && (
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
              {unreadCount} {t("notifications.unread")}
            </Text>
          )}
        </View>
        {unreadCount > 0 ? (
          <Pressable
            onPress={() => markAllAsRead()}
            hitSlop={8}
            style={styles.headerAction}>
            <CheckCheck size={22} color={colors.brandPrimary} strokeWidth={2} />
          </Pressable>
        ) : (
          <View style={styles.headerAction} />
        )}
      </View>

      {showLoading ? (
        <NotificationsSkeleton />
      ) : showEmpty ? (
        <View style={styles.center}>
          <View style={[styles.emptyIconBox, { backgroundColor: colors.textSecondary + "26" }]}>
            <BellOff size={32} color={colors.textSecondary} />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
            {t("notifications.empty")}
          </Text>
          <Text style={[styles.emptyDesc, { color: colors.textSecondary }]}>
            {t("notifications.emptyDesc")}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionLabel, { color: colors.textSecondary }]}>
              {t(`notifications.${section.bucket}`)}
            </Text>
          )}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}
          showsVerticalScrollIndicator={false}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            isLoadingMore ? (
              <View style={styles.footer}>
                <ActivityIndicator color={colors.brandPrimary} />
              </View>
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => fetchNotifications({ refresh: true })}
              tintColor={colors.brandPrimary}
              colors={[colors.brandPrimary]}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerCenter: { flex: 1, alignItems: "center" },
  title: { fontSize: 18, fontFamily: "Inter_600SemiBold" },
  subtitle: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  headerAction: { width: 30, alignItems: "flex-end", justifyContent: "center" },

  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 40 },
  emptyIconBox: {
    width: 72,
    height: 72,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  emptyTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", marginBottom: 6 },
  emptyDesc: { fontSize: 13, fontFamily: "Inter_400Regular", textAlign: "center", lineHeight: 19 },

  content: { paddingHorizontal: 20, paddingBottom: 40 },
  sectionLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    marginTop: 10,
    marginBottom: 10,
  },
  footer: { paddingVertical: 16, alignItems: "center" },

  swipeContainer: { borderRadius: 14, marginBottom: 10 },
  notifCard: { padding: 14 },
  notifRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  iconBox: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  notifContent: { flex: 1 },
  notifTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  notifTitle: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", marginBottom: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, marginBottom: 4 },
  notifDesc: { fontSize: 13, fontFamily: "Inter_400Regular", marginBottom: 6 },
  notifTime: { fontSize: 11, fontFamily: "Inter_400Regular" },

  deleteAction: {
    width: 72,
    marginBottom: 10,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
});
