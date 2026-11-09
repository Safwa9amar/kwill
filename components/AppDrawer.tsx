import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Image,
  StyleSheet,
  Pressable,
  ScrollView,
  TextInput,
  Alert,
  ActivityIndicator,
  Keyboard,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, usePathname } from "expo-router";
import { useDrawerStatus, type DrawerContentComponentProps } from "expo-router/drawer";
import { useTranslation } from "react-i18next";
import {
  Search,
  X,
  PenLine,
  Sparkles,
  LayoutGrid,
  FolderUp,
  Combine,
  LifeBuoy,
  Newspaper,
  List,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  type LucideIcon,
} from "lucide-react-native";

import { useThemeColors } from "@/hooks/useThemeColors";
import { useRTL } from "@/hooks/useRTL";
import { registerDrawerControls, useNavDrawerStore } from "@/stores/nav-drawer-store";
import { useThesisStore } from "@/stores/thesis-store";
import { useChatThreadsStore } from "@/stores/chat-threads-store";
import { useProfileStore } from "@/stores/profile-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useChatHead } from "@/stores/chat-head-store";
import { useCombineStore } from "@/stores/combine-store";
import { useImportStore } from "@/stores/import-store";
import { AvatarPicker } from "@/components/AvatarPicker";
import { ThesisOutlinePanel } from "@/components/workspace/ThesisOutlinePanel";
import { listTheses } from "@/lib/api";
import { guardThesisLimit } from "@/lib/thesis-limit";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";

// Two cuts of the same art. The original's "will" is white — it disappears on
// the light theme, which is why the drawer used to fall back to plain type there
// and the logo looked broken on any phone not in dark mode. The light cut is the
// same file with the white glyphs recoloured to the light theme's ink; the K
// keeps its orange in both, so the brand is one mark under either theme.
const WORDMARK = require("../assets/wordmark.png");
const WORDMARK_LIGHT = require("../assets/wordmark-light.png");

// -----------------------------------------------------------------------------
// The app's single index. Every page in Kwill is a row in here — there is no
// tab bar and no second front door. Bands are ordered by how often a hand reaches
// for them, not by category: act, then tools, then the open thesis, then the rest
// of your work. The whole body scrolls — see the note on it for why nothing
// between the brand and the account foot can be pinned.
//
// It is the "app" view of the root drawer; the "outline" view is the thesis
// structure, which used to own the drawer outright. Both stay mounted (state is
// preserved across the switch) and the hidden one is display:none — see the note
// on `open` in ThesisOutlinePanel for why that matters.
//
// This component is the `drawerContent` of Expo Router's `Drawer` navigator (see
// app/_layout.tsx), which is why it is handed a navigation object: it is the one
// place in the app that is BOTH always mounted with the drawer and inside it, so
// it is where the navigator's imperative handle is published to the store for
// every ☰ button and fling elsewhere in the app to use.
// -----------------------------------------------------------------------------

type Row = {
  key: string;
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  accent?: boolean;
};

export function AppDrawer({ navigation }: DrawerContentComponentProps) {
  const view = useNavDrawerStore((s) => s.view);
  const setView = useNavDrawerStore((s) => s.setView);
  // 'open' the moment the action is dispatched, not when the slide finishes —
  // it is derived from navigation state. That is what `AppIndex` wants: its
  // lists start refreshing as the panel begins to move, so they are current by
  // the time it has arrived.
  const status = useDrawerStatus();

  // Hand the navigator's own open/close to the store, so the rest of the app can
  // ask for the drawer from places that have no navigation prop.
  useEffect(() => {
    registerDrawerControls({
      open: () => navigation.openDrawer(),
      close: () => navigation.closeDrawer(),
      toggle: () => navigation.toggleDrawer(),
    });
    return () => registerDrawerControls(null);
  }, [navigation]);

  useEffect(() => {
    const open = status === "open";
    useNavDrawerStore.getState().syncOpen(open);
    // `keyboardDismissMode: "on-drag"` covers the swipe; this covers the ☰, the
    // writer's fling and the dock. The writer's keyboard is up more often than
    // not, and an app dragged aside with it still standing is the wrong picture.
    if (open) Keyboard.dismiss();
  }, [status]);

  return (
    <View style={styles.host}>
      <View style={[styles.layer, view !== "app" && styles.hidden]} pointerEvents={view === "app" ? "auto" : "none"}>
        <AppIndex />
      </View>
      <View
        style={[styles.layer, view !== "outline" && styles.hidden]}
        pointerEvents={view === "outline" ? "auto" : "none"}
      >
        <ThesisOutlinePanel onBack={() => setView("app")} />
      </View>
    </View>
  );
}

function AppIndex() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const rtl = useRTL();
  // A primitive, not a derived object — see the Zustand selector trap.
  const theme = useSettingsStore((s) => s.theme);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const onWriter = pathname.includes("thesis-workspace");

  const open = useNavDrawerStore((s) => s.open);
  const setView = useNavDrawerStore((s) => s.setView);
  const closeDrawer = useNavDrawerStore((s) => s.closeDrawer);

  const theses = useThesisStore((s) => s.theses);
  const currentThesisId = useThesisStore((s) => s.currentThesisId);
  const profile = useProfileStore((s) => s.profile);
  // Conversations attached to no thesis at all — the plain-assistant chats. They
  // used to surface only inside the history panel, mixed in with every thesis's
  // threads; they are a list of their own and belong in the app's index next to
  // the documents, not buried in a panel scoped to one of them.
  const threads = useChatThreadsStore((s) => s.threads);

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  // Each list shows a preview until asked for the rest. Reset on close so the
  // next open starts short again — an expanded list left open pushes the account
  // foot off the bottom of a small phone.
  const [allTheses, setAllTheses] = useState(false);
  const [allChats, setAllChats] = useState(false);

  // Refresh both lists each time the drawer is opened — it is now the only place
  // theses are listed, so a stale list here is a stale list everywhere. Painting
  // from the store first means the rows are never blank while this runs.
  useEffect(() => {
    if (!open) {
      setSearching(false);
      setQuery("");
      setAllTheses(false);
      setAllChats(false);
      return;
    }
    let alive = true;
    setLoading(true);
    // The thread list is best-effort and owns its own loading flag; only the
    // theses gate the spinner, because only they can leave the drawer empty.
    void useChatThreadsStore.getState().load();
    listTheses()
      .then((rows) => {
        if (alive) useThesisStore.getState().setTheses(rows);
      })
      .catch(() => {
        // Keep the last-known list rather than blanking on a transient failure.
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // Every row closes the drawer BEFORE navigating: the screen transition and the
  // drawer spring otherwise run against each other on the same frame.
  //
  // Drawer rows REPLACE, never push. The drawer is the app's index, so its rows
  // are lateral moves between destinations, not a trail to walk back up — pushing
  // would stack a new screen every time one is tapped and leave the user peeling
  // back through a pile of them. `BackButton` falls back to the writer when the
  // stack is one deep, so a replaced-into screen is never a dead end.
  const go = useCallback(
    (action: () => void) => {
      closeDrawer();
      action();
    },
    [closeDrawer],
  );

  const handleCombine = useCallback(async () => {
    closeDrawer();
    // A combine also ends in a new thesis, so the plan's ceiling applies.
    if (!(await guardThesisLimit())) return;
    const store = useCombineStore.getState();
    store.reset();
    // Reading a handful of chapter .docx files and classifying them takes tens of
    // seconds. Push the arrange screen the moment the picker closes so that work
    // happens on ITS processing view — waiting on the previous page with nothing
    // moving is what read as a hang.
    let navigated = false;
    const result = await store.pickAndClassify({
      onPicked: () => {
        navigated = true;
        router.push("/(app)/combine-arrange" as any);
      },
    });
    // Failures after the push are the arrange screen's to show (it has a retry);
    // only a failure before it — a dead picker, too few files — needs an alert.
    if (result === "error" && !navigated) {
      Alert.alert(t("combine.action"), useCombineStore.getState().errorMessage || t("thesis.genericError"));
    }
  }, [closeDrawer, router, t]);

  // The PLAIN import: pick a .docx, upload it, land on the analysis screen.
  const handleImport = useCallback(async () => {
    closeDrawer();
    // An import ends in a new thesis, so the plan's ceiling applies.
    if (!(await guardThesisLimit())) return;
    const store = useImportStore.getState();
    store.reset();
    // Same reason as handleCombine: reading and analysing a real thesis takes
    // tens of seconds, so the processing screen goes up the moment the picker
    // closes rather than leaving the drawer sitting there looking dead.
    let navigated = false;
    const result = await store.pickAndImport({
      onPicked: () => {
        navigated = true;
        router.push("/(app)/import-analysis" as any);
      },
    });
    if (result === "error" && !navigated) {
      Alert.alert(t("documents.import"), useImportStore.getState().errorMessage || t("thesis.genericError"));
    }
  }, [closeDrawer, router, t]);

  const currentThesis = useMemo(
    () => theses.find((th) => th.id === currentThesisId) ?? null,
    [theses, currentThesisId],
  );

  const doRows: Row[] = [
    {
      key: "new",
      icon: PenLine,
      label: t("drawer.newThesis"),
      accent: true,
      onPress: () => go(() => router.push("/(app)/start-thesis" as any)),
    },
    // Writer, Library and Tasks used to sit here. They now ride under every
    // assistant answer (components/chat/MessageActions) — the conversation is the
    // app's front door, and putting its three exits a drawer away meant every
    // trip to the document cost a swipe and a tap. They are NOT duplicated here:
    // one home per destination, or the drawer becomes a second front door again.
    {
      key: "ask",
      icon: Sparkles,
      label: t("drawer.ask"),
      // The chat is the app's home now, so Ask goes there rather than opening the
      // thread as an overlay over the writer. Same thread either way — the writer's
      // dock with nothing selected posts into it too, and its reply card still
      // expands over the document without leaving the page.
      //
      // dismissTo, NOT replace: chat is already the bottom of this stack, and
      // replacing the top screen with a second chat left TWO of them mounted —
      // both listening to the same pending question, both presenting a sheet for
      // it. This pops back down to the chat that's already there (and falls back
      // to a replace when there isn't one).
      onPress: () => go(() => router.dismissTo("/(app)/chat" as any)),
    },
  ];

  const toolRows: Row[] = [
    {
      key: "templates",
      icon: LayoutGrid,
      label: t("drawer.templates"),
      onPress: () => go(() => router.push("/(app)/browse-templates" as any)),
    },
    // Rescue v2's door (P-35). The library decides what the student sees: no project yet, the start screen. Off in a release build.
    ...(RESCUE_V2_ENABLED ? [{
      key: "rescue-v2",
      icon: LifeBuoy,
      label: t("rescueV2.drawerRow"),
      onPress: () => go(() => router.push("/(app)/rescue/library" as any)),
    } satisfies Row] : []),
    {
      key: "import",
      icon: FolderUp,
      label: t("documents.import"),
      onPress: handleImport,
    },
    { key: "combine", icon: Combine, label: t("combine.short"), onPress: handleCombine },
    // Export is COMMENTED OUT, not deleted — it is expected back.
    //
    // Exporting now happens in the conversation: ask for it, and the reply
    // carries a download card that saves the file straight to the device. This
    // screen was a second route to the same artifact, one that made the student
    // leave the chat to get what they had just asked for.
    //
    // app/(app)/export.tsx and export-success.tsx are left in place so this is a
    // one-line restore.
    // {
    //   key: "export",
    //   icon: Download,
    //   label: t("drawer.export"),
    //   onPress: () =>
    //     go(() => {
    //       if (!currentThesis) return;
    //       router.replace({
    //         pathname: "/(app)/export",
    //         params: { thesisId: currentThesis.id },
    //       } as any);
    //     }),
    // },
    {
      key: "news",
      icon: Newspaper,
      label: t("drawer.news"),
      onPress: () => go(() => router.push("/(app)/news" as any)),
    },
    {
      key: "support",
      icon: LifeBuoy,
      label: t("drawer.support"),
      onPress: () => go(() => router.push("/(app)/support" as any)),
    },
  ];

  const confirmDelete = useCallback(
    (id: string) => {
      Alert.alert(t("thesis.deleteConfirmTitle"), t("thesis.deleteConfirmMessage"), [
        { text: t("thesis.renameCancel"), style: "cancel" },
        {
          text: t("thesis.delete"),
          style: "destructive",
          onPress: async () => {
            const { deleteThesis: apiDeleteThesis } = await import("@/lib/api");
            useThesisStore.getState().deleteThesis(id);
            try {
              await apiDeleteThesis(id);
            } catch {
              Alert.alert(t("thesis.genericError"));
              listTheses()
                .then((rows) => useThesisStore.getState().setTheses(rows))
                .catch(() => {});
            }
          },
        },
      ]);
    },
    [t],
  );

  // Long-press opens the row's menu. Details has to live here: the thesis-detail
  // screen used to be reached by tapping a card on the home or My Theses tab, and
  // both of those are gone — without this entry it would be unreachable.
  const openThesisMenu = useCallback(
    (id: string, title: string) => {
      Alert.alert(title, undefined, [
        {
          text: t("thesis.thesisDetails"),
          onPress: () =>
            go(() =>
              router.replace({ pathname: "/(app)/thesis-detail", params: { thesisId: id } } as any),
            ),
        },
        { text: t("thesis.delete"), style: "destructive", onPress: () => confirmDelete(id) },
        { text: t("thesis.renameCancel"), style: "cancel" },
      ]);
    },
    [confirmDelete, go, router, t],
  );

  const recent = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q ? theses.filter((th) => th.title.toLowerCase().includes(q)) : theses;
    return [...rows].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [theses, query]);

  // Never re-sorted: the server already returned the threads in display order
  // (pinned first, then most recent), the same contract lib/thread-groups.ts
  // relies on.
  const freeChats = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = threads.filter((th) => !th.thesisId);
    if (!q) return rows;
    return rows.filter((th) => (th.title ?? "").toLowerCase().includes(q));
  }, [threads, query]);

  // Searching shows every match — a hit hidden behind "Show all" reads as the
  // search having missed it.
  const hasQuery = query.trim().length > 0;
  const shownTheses = allTheses || hasQuery ? recent : recent.slice(0, PREVIEW_ROWS);
  const shownChats = allChats || hasQuery ? freeChats : freeChats.slice(0, PREVIEW_ROWS);

  // Open a conversation that has no document behind it. The thesis selection is
  // NOT cleared here — the chat screen does it, from the thread row itself, the
  // same way picking one in the history panel does (see handlePickThread).
  const openFreeChat = useCallback(
    (threadId: string) => {
      go(() => {
        useChatThreadsStore.getState().requestOpenThread(threadId);
        router.dismissTo("/(app)/chat" as any);
      });
    },
    [go, router],
  );

  const displayName =
    profile?.fullName?.trim() || profile?.email?.split("@")[0] || t("profile.notSet");

  const Chevron = rtl.isRTL ? ChevronLeft : ChevronRight;

  return (
    <View style={[styles.panel, { backgroundColor: colors.bgModal, paddingTop: insets.top + 12 }]}>
      {/* Brand + search. Search filters Recent in place rather than opening a screen —
          the drawer is already the list it would have searched. */}
      <View style={[styles.head, { flexDirection: rtl.flexDirection }]}>
        {searching ? (
          <View
            style={[
              styles.searchBox,
              {
                backgroundColor: colors.bgInput,
                borderColor: colors.borderDefault,
                flexDirection: rtl.flexDirection,
              },
            ]}
          >
            <Search size={15} color={colors.textSecondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              autoFocus
              placeholder={t("drawer.searchTheses")}
              placeholderTextColor={colors.textPlaceholder}
              style={[styles.searchInput, { color: colors.textPrimary, textAlign: rtl.textAlign }]}
              returnKeyType="search"
              autoCorrect={false}
            />
            <Pressable
              onPress={() => {
                setSearching(false);
                setQuery("");
              }}
              hitSlop={8}
            >
              <X size={15} color={colors.textSecondary} />
            </Pressable>
          </View>
        ) : (
          <>
            {/* The logo, not the word — in both themes now, each with the cut of
                the art that reads on its ground. The spacer after it does the job
                the old `flex: 1` on the Text did, pushing search to the far end
                without stretching a fixed-size image. */}
            <Image
              source={theme === "dark" ? WORDMARK : WORDMARK_LIGHT}
              style={styles.wordmark}
              resizeMode="contain"
              accessibilityLabel={t("auth.appName")}
            />
            <View style={styles.brandSpacer} />
            <Pressable
              onPress={() => setSearching(true)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t("drawer.searchTheses")}
              style={styles.iconBtn}
            >
              <Search size={19} color={colors.textPrimary} />
            </Pressable>
          </>
        )}
      </View>

      {/* One scroll region for the whole body. The bands used to be pinned above a
          Recent list that was the only thing allowed to scroll, which only held while
          the bands fit: Arabic labels fall back to a font with a taller line box, so
          every row grows and ten of them plus the head and foot outgrow the panel.
          Flexbox then shrinks the flex:1 list to nothing and the overflow has nowhere
          to go — the drawer reads as frozen. Scrolling the body instead costs the
          pinning and survives any language. Only the brand and the account foot,
          which are a fixed height in every language, stay put. */}
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.pinned}>
          {doRows.map((row) => (
            <DrawerRow key={row.key} row={row} rtl={rtl} colors={colors} />
          ))}

          <Text style={[styles.bandLabel, { color: colors.textSecondary, textAlign: rtl.textAlign }]}>
            {t("drawer.tools")}
          </Text>
          {toolRows.map((row) => (
            <DrawerRow key={row.key} row={row} rtl={rtl} colors={colors} />
          ))}

          {currentThesis && (
            <>
              <View style={[styles.rule, { backgroundColor: colors.borderSubtle }]} />
              <Text style={[styles.bandLabel, { color: colors.textSecondary, textAlign: rtl.textAlign }]}>
                {t("drawer.currentThesis")}
              </Text>
              <DrawerRow
                row={{
                  key: "contents",
                  icon: List,
                  label: t("drawer.contents"),
                  onPress: () => setView("outline"),
                }}
                rtl={rtl}
                colors={colors}
                trailing={<Chevron size={15} color={colors.textSecondary} />}
              />
            </>
          )}
        </View>

        <View style={[styles.recentHead, { flexDirection: rtl.flexDirection }]}>
          <Text style={[styles.bandLabel, { color: colors.textSecondary, flex: 1, textAlign: rtl.textAlign }]}>
            {t("drawer.myTheses")}
          </Text>
          {loading && <ActivityIndicator size="small" color={colors.textSecondary} />}
        </View>
        <View style={styles.recentList}>
          {recent.length === 0 ? (
            <Text style={[styles.empty, { color: colors.textSecondary, textAlign: rtl.textAlign }]}>
              {t("drawer.noTheses")}
            </Text>
          ) : (
            shownTheses.map((th) => {
              const isCurrent = th.id === currentThesisId;
              return (
                <Pressable
                  key={th.id}
                  // A thesis opens its CONVERSATION, not the editor. The chat is
                  // the app's front door and the Writer is one chip away from it
                  // (see MessageActions), so landing in the document skipped past
                  // everything the student was more likely to want first.
                  //
                  // The selection is set BEFORE navigating: the chat screen stays
                  // mounted between visits and reads the thesis out of this store,
                  // so writing it after the route change would leave it resolving
                  // the previous thesis's thread. dismissTo, not replace, for the
                  // reason spelled out on the Ask row above.
                  onPress={() =>
                    go(() => {
                      useThesisStore.getState().setCurrentThesis(th.id);
                      router.dismissTo("/(app)/chat" as any);
                    })
                  }
                  onLongPress={() => openThesisMenu(th.id, th.title)}
                  // Plain, like every other row: the brand dot at the end is what
                  // says "this is the one you're in".
                  style={[styles.row, { flexDirection: rtl.flexDirection }]}
                  accessibilityRole="button"
                >
                  <Text
                    style={[
                      styles.rowLabel,
                      {
                        color: isCurrent ? colors.textPrimary : colors.textSecondary,
                        textAlign: rtl.textAlign,
                        fontFamily: isCurrent ? "Inter_600SemiBold" : "Inter_400Regular",
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {th.title}
                  </Text>
                  {isCurrent && <View style={[styles.dot, { backgroundColor: colors.brandPrimary }]} />}
                </Pressable>
              );
            })
          )}
          <MoreRow
            hidden={hasQuery || recent.length <= PREVIEW_ROWS}
            expanded={allTheses}
            total={recent.length}
            onPress={() => setAllTheses((v) => !v)}
            rtl={rtl}
            colors={colors}
            t={t}
          />
        </View>

        {/* Conversations with no document behind them. Rendered only when there
            are some — an empty band would be a heading explaining an absence. */}
        {freeChats.length > 0 && (
          <>
            <View style={[styles.recentHead, { flexDirection: rtl.flexDirection }]}>
              <Text style={[styles.bandLabel, { color: colors.textSecondary, flex: 1, textAlign: rtl.textAlign }]}>
                {t("drawer.freeChats")}
              </Text>
            </View>
            <View style={styles.recentList}>
              {shownChats.map((th) => (
                <Pressable
                  key={th.id}
                  onPress={() => openFreeChat(th.id)}
                  style={[styles.row, { flexDirection: rtl.flexDirection }]}
                  accessibilityRole="button"
                  accessibilityLabel={th.title?.trim() || t("chat.threads.untitled")}
                >
                  <MessageSquare size={16} color={colors.textSecondary} />
                  <Text
                    style={[
                      styles.rowLabel,
                      {
                        color: colors.textSecondary,
                        textAlign: rtl.textAlign,
                        fontFamily: "Inter_400Regular",
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {th.title?.trim() || t("chat.threads.untitled")}
                  </Text>
                </Pressable>
              ))}
              <MoreRow
                hidden={hasQuery || freeChats.length <= PREVIEW_ROWS}
                expanded={allChats}
                total={freeChats.length}
                onPress={() => setAllChats((v) => !v)}
                rtl={rtl}
                colors={colors}
                t={t}
              />
            </View>
          </>
        )}
      </ScrollView>

      {/* Account sits at the foot, never in the list. */}
      <Pressable
        onPress={() => go(() => router.push("/(app)/account" as any))}
        style={[
          styles.foot,
          {
            borderTopColor: colors.borderSubtle,
            paddingBottom: insets.bottom + 10,
            flexDirection: rtl.flexDirection,
          },
        ]}
        accessibilityRole="button"
        accessibilityLabel={t("drawer.account")}
      >
        <AvatarPicker size={30} name={displayName} avatarUrl={profile?.avatarUrl} editable={false} />
        <Text
          style={[styles.footName, { color: colors.textPrimary, textAlign: rtl.textAlign }]}
          numberOfLines={1}
        >
          {displayName}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The "Show all (12) / Show less" toggle at the foot of a preview list.
 *
 * Renders as null rather than being conditionally mounted by the caller so the
 * two lists read the same at their call sites. `hidden` covers both reasons
 * there is nothing to reveal: a list already short enough, and a search — where
 * a match held back behind a button reads as the search having missed it.
 */
function MoreRow({
  hidden,
  expanded,
  total,
  onPress,
  rtl,
  colors,
  t,
}: {
  hidden: boolean;
  expanded: boolean;
  total: number;
  onPress: () => void;
  rtl: ReturnType<typeof useRTL>;
  colors: ReturnType<typeof useThemeColors>;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  if (hidden) return null;
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, { flexDirection: rtl.flexDirection }]}
      accessibilityRole="button"
    >
      {/* Sits in the icon column so its label lines up with the rows above it. */}
      <Chevron size={16} color={colors.textSecondary} />
      <Text
        style={[styles.moreLabel, { color: colors.textSecondary, textAlign: rtl.textAlign }]}
        numberOfLines={1}
      >
        {expanded ? t("drawer.showLess") : t("drawer.showAll", { count: total })}
      </Text>
    </Pressable>
  );
}

function DrawerRow({
  row,
  rtl,
  colors,
  trailing,
}: {
  row: Row;
  rtl: ReturnType<typeof useRTL>;
  colors: ReturnType<typeof useThemeColors>;
  trailing?: React.ReactNode;
}) {
  const Icon = row.icon;
  // No fills anywhere: every row is a row. One thing is coloured — the primary
  // action — and everything else, the current row included, is the same grey glyph
  // with the same label. The dot on the current thesis is the only "you are here"
  // the panel needs.
  const fg = row.accent ? colors.brandPrimary : colors.textPrimary;
  const iconColor = row.accent ? colors.brandPrimary : colors.textSecondary;

  return (
    <Pressable
      onPress={row.onPress}
      style={[styles.row, row.accent && styles.rowAccent, { flexDirection: rtl.flexDirection }]}
      accessibilityRole="button"
      accessibilityLabel={row.label}
    >
      {/* 18 = the icon column's width, so a row with no icon (a Recent thesis)
          still lines its text up with these glyphs rather than with their labels. */}
      <Icon size={18} color={iconColor} />
      <Text
        style={[
          styles.rowLabel,
          {
            color: fg,
            textAlign: rtl.textAlign,
            fontFamily: row.accent ? "Inter_600SemiBold" : "Inter_500Medium",
          },
        ]}
        numberOfLines={1}
      >
        {row.label}
      </Text>
      {trailing}
    </Pressable>
  );
}

// ONE horizontal grid for the whole panel. A row's highlight has to bleed wider
// than its text, so rows live in a container inset by GUTTER and pad themselves by
// ROW_PAD; everything that has no highlight — the brand, the band labels, the
// account foot — uses their SUM, so every glyph in the drawer starts on the same
// column. Before this the head and foot sat at 14 while the rows' icons sat at 16,
// and that half-step showed as a wobble down the whole left edge.
const GUTTER = 8;
const ROW_PAD = 10;
const COLUMN = GUTTER + ROW_PAD;

// How many rows a list shows before "Show all". Four is what fits under both
// bands, plus the tool rows and the account foot, on the shortest phone we
// support — the whole body scrolls, but a drawer that opens already needing a
// scroll to reach anything is a drawer that failed as an index.
const PREVIEW_ROWS = 4;

const styles = StyleSheet.create({
  host: { flex: 1 },
  // Both views stay mounted so switching preserves scroll + collapse state.
  layer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  hidden: { display: "none" },
  panel: { flex: 1 },
  head: { alignItems: "center", gap: 8, paddingHorizontal: COLUMN, paddingBottom: 8, minHeight: 40 },
  // The art's own 1.5 aspect, so `contain` letterboxes nothing, sized so the
  // glyphs (which fill ~73% of the height) land a little larger than the 18pt
  // type they replace. It carries its own glow padding, hence the negative
  // margins — they claw back the empty ground so the optical spacing matches
  // what the text had and the 40pt head row doesn't grow.
  wordmark: { width: 62, height: 41, marginVertical: -5, marginStart: -4 },
  brandSpacer: { flex: 1 },
  iconBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  searchBox: {
    flex: 1,
    alignItems: "center",
    gap: 8,
    height: 36,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular", padding: 0 },
  pinned: { paddingHorizontal: GUTTER },
  // A band label belongs to the group BELOW it, so it takes its space from above:
  // a big gap up, almost none down. Splitting the difference is what made the
  // groups read as one long undifferentiated list with holes in it.
  bandLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingHorizontal: ROW_PAD,
    marginTop: 16,
    marginBottom: 2,
  },
  // The label under it already separates the groups; the rule only marks that the
  // drawer changed subject, so it needs far less air than it had.
  rule: { height: StyleSheet.hairlineWidth, marginTop: 12, marginBottom: 0, marginHorizontal: ROW_PAD },
  row: { alignItems: "center", gap: 12, paddingHorizontal: ROW_PAD, paddingVertical: 9, borderRadius: 10 },
  // Same shape as every other row — it only stands clear of the list below it.
  rowAccent: { marginBottom: 10 },
  rowLabel: { flex: 1, fontSize: 14 },
  // A shade smaller than a real row: it is a control over the list, not an
  // entry in it.
  moreLabel: { flex: 1, fontSize: 12.5, fontFamily: "Inter_600SemiBold" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  body: { flex: 1 },
  // flexGrow, not flex: the body has to fill the panel when the bands are short
  // (so the foot stays at the bottom) and overflow it when they are not.
  bodyContent: { flexGrow: 1, paddingBottom: 8 },
  recentHead: { alignItems: "center", paddingHorizontal: GUTTER, gap: 8 },
  recentList: { paddingHorizontal: GUTTER },
  empty: { fontSize: 12.5, fontFamily: "Inter_400Regular", paddingHorizontal: ROW_PAD, paddingVertical: 12 },
  foot: {
    alignItems: "center",
    gap: 10,
    paddingHorizontal: COLUMN,
    paddingTop: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footName: { flex: 1, fontSize: 13.5, fontFamily: "Inter_600SemiBold" },
});
