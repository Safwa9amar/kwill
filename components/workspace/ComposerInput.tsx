import { useState, useEffect, useRef } from "react";
import { View, Pressable, StyleSheet, Alert, type TextInput as RNTextInput, type TextInputProps } from "react-native";
import { useTranslation } from "react-i18next";
// Deliberately NOT BottomSheetTextInput: registering the input activates gorhom's
// own keyboard repositioning, which fights the sheet's manual keyboard docking
// (see WorkspaceComposerSheet). A plain gesture-handler TextInput keeps gorhom's
// keyboard machinery inert while still cooperating with the sheet's pan gesture.
import { TextInput } from "react-native-gesture-handler";
import Animated, {
  FadeIn,
  FadeOut,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  cancelAnimation,
} from "react-native-reanimated";
import { Send, Square, Mic } from "lucide-react-native";
import { useThemeColors } from "@/hooks/useThemeColors";
import { useVoiceDictation } from "@/lib/voice";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// gesture-handler types its TextInput's ref as `Ref<ComponentType<any>>`, which is
// simply wrong: the wrapper forwards to the real React Native TextInput instance,
// which is what `.focus()` lives on. Corrected once, here, so the ref is honest
// everywhere else. The props are React Native's TextInput props unchanged.
const GHTextInput = TextInput as unknown as React.ForwardRefExoticComponent<
  TextInputProps & React.RefAttributes<RNTextInput>
>;

// Composer auto-grow bounds (one line … ~6 lines, then it scrolls internally).
// Belt-and-suspenders so it grows whichever mechanism the New Architecture honors:
// minHeight/maxHeight bound the intrinsic auto-sizing, and onContentSizeChange drives
// an explicit height when that event fires. Height stays unset until measured, so if
// the event never fires the intrinsic path still governs (never pinned to one line).
const INPUT_MIN_HEIGHT = 28;
const INPUT_MAX_HEIGHT = 120;

/** The underlying TextInput, so a caller can focus the composer from elsewhere
 *  in the sheet (the plan card's "Ask for changes" does exactly that).
 *  Declared against React Native's instance type on purpose: gesture-handler's
 *  TextInput is a thin native wrapper around it, but its exported TYPE is loose
 *  (`ComponentClass<any> | FunctionComponent<any>`), so inferring the ref off
 *  the component yields the component itself and `.focus()` is not on it. */
export type ComposerInputHandle = RNTextInput;

interface Props {
  value: string;
  onChangeText: (t: string) => void;
  onSend: () => void;
  onStop: () => void;
  onMicPress: () => void;
  onFocus: () => void;
  onBlur: () => void;
  isGenerating: boolean;
  placeholder: string;
  sendLabel: string;
  stopLabel: string;
  micLabel: string;
  /** Optional handle on the text field — lets the sheet focus it programmatically. */
  inputRef?: React.Ref<ComposerInputHandle>;
}

/**
 * The composer's input row: a sheet-aware text input with an inline mic and a
 * send button that becomes a Stop button while the AI is generating.
 */
export function ComposerInput({
  value,
  onChangeText,
  onSend,
  onStop,
  onMicPress,
  onFocus,
  onBlur,
  isGenerating,
  placeholder,
  sendLabel,
  stopLabel,
  micLabel,
  inputRef,
}: Props) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const hasText = value.trim().length > 0;
  const [inputHeight, setInputHeight] = useState<number | undefined>(undefined);
  // Collapse back to one line when the parent clears the text (e.g. after sending).
  useEffect(() => {
    if (!value) setInputHeight(undefined);
  }, [value]);

  // ——— Voice dictation ———
  // Live transcript appends to whatever was in the input when dictation began.
  const { supported, listening, start, stop } = useVoiceDictation();
  const baseTextRef = useRef("");

  const handleMic = async () => {
    if (listening) {
      stop();
      return;
    }
    // Not linked yet (needs a native rebuild) → keep the existing "coming soon".
    if (!supported) {
      onMicPress();
      return;
    }
    baseTextRef.current = value;
    const ok = await start((transcript) => {
      const base = baseTextRef.current;
      onChangeText(base ? `${base} ${transcript}` : transcript);
    });
    if (!ok) {
      Alert.alert(
        t("composer.micDenied", {
          defaultValue: "Microphone/speech permission is needed to dictate.",
        }),
      );
    }
  };

  // Pulse the mic while listening so it reads as a live recording indicator.
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (listening) {
      pulse.value = withRepeat(withTiming(0.4, { duration: 700 }), -1, true);
    } else {
      cancelAnimation(pulse);
      pulse.value = 1;
    }
  }, [listening, pulse]);
  const micAnimStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View style={[styles.wrapper, { backgroundColor: colors.bgInput }]}>
      <GHTextInput
        ref={inputRef}
        style={[styles.input, { color: colors.textPrimary }, inputHeight != null && { height: inputHeight }]}
        placeholder={listening ? t("composer.listening", { defaultValue: "Listening…" }) : placeholder}
        placeholderTextColor={colors.textPlaceholder}
        value={value}
        onChangeText={onChangeText}
        onContentSizeChange={(e) =>
          setInputHeight(
            Math.min(INPUT_MAX_HEIGHT, Math.max(INPUT_MIN_HEIGHT, e.nativeEvent.contentSize.height))
          )
        }
        onFocus={onFocus}
        onBlur={onBlur}
        editable={!isGenerating}
        multiline
        maxLength={2000}
      />
      {!isGenerating && (
        <AnimatedPressable
          onPress={handleMic}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={listening ? t("composer.listening", { defaultValue: "Listening…" }) : micLabel}
          accessibilityState={{ selected: listening }}
          style={[
            styles.micBtn,
            { backgroundColor: listening ? colors.brandPrimary : colors.bgSurface },
            listening && micAnimStyle,
          ]}
        >
          <Mic size={16} color={listening ? "#FFFFFF" : colors.textSecondary} strokeWidth={2} />
        </AnimatedPressable>
      )}
      {isGenerating ? (
        <AnimatedPressable
          entering={FadeIn.duration(150)}
          onPress={onStop}
          accessibilityRole="button"
          accessibilityLabel={stopLabel}
          style={[styles.actionBtn, { backgroundColor: colors.semanticError }]}
        >
          <Square size={13} color="#FFFFFF" fill="#FFFFFF" />
        </AnimatedPressable>
      ) : hasText ? (
        <AnimatedPressable
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(100)}
          onPress={onSend}
          accessibilityRole="button"
          accessibilityLabel={sendLabel}
          style={[styles.actionBtn, { backgroundColor: colors.brandPrimary }]}
        >
          <Send size={16} color={colors.brandOnPrimary} strokeWidth={2} />
        </AnimatedPressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 22,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 6,
  },
  input: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", paddingVertical: 4, minHeight: INPUT_MIN_HEIGHT, maxHeight: INPUT_MAX_HEIGHT },
  micBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  actionBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
