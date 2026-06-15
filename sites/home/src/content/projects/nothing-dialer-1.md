---
title: "Nothing Dialer 1"
banner: "/images/projects/nothing-dialer-1/banner-4.png"
description: "A custom dialer app for Nothing OS with unique Glyph Interface animations for outgoing, ongoing, and incoming calls."
tags: ["Mobile", "Communication"]
branch: "release/beta"
commit: "1f125a2"
---

## Repository
[Nothing-Dialer-1 on GitHub](https://github.com/rkvishwa/Nothing-Dialer-1)

## Overview

Nothing Dialer 1 is a custom dialer application designed exclusively for **Nothing OS** — the minimalist, glyph-accented Android skin powering the Nothing Phone series. Where the stock dialer treats the Glyph Interface as a notification-only feature, Nothing Dialer 1 extends it to active, in-progress call states.

When you place or receive a call, the phone's signature LED glyphs light up in choreographed patterns that convey call state — ringing, picked up, on hold, ended — making the back of your Nothing Phone a live, ambient call indicator.

## Glyph Patterns

The app integrates with the `nothing_glyph_interface` to expose individual LED segments that can be addressed programmatically. It allows customizable animation styles right from the settings (e.g. "Breath & Progress", C1-C4 Intervals, and Custom Channels). Nothing Dialer 1 maps call lifecycle events to these animation sequences:

| Call State | Glyph Behavior |
|---|---|
| Outgoing — Ringing | Configurable breath animations, custom interval progress |
| Call Connected | In-call breath progress and custom interval behaviors |
| Incoming Call | Fast strobe, outer ring |
| Call Ended | LEDs turn off |

## Features

- **Glyph-aware dialer** — Custom glyph animations for outgoing AND ongoing calls (the stock app only supports incoming).
- **Minimal UI** — Built in Flutter but heavily adheres to the Nothing OS design language: pure, minimal, and typography-focused.
- **Customizable Glyphs** — Fine-tune parameters like Breath Progress duration, interval speed, and active LED channels directly in the dialer settings.
- **Cross-Sim Support** — Picks appropriate SIM and native controls seamlessly.
- **Deep Android Integration** — Uses Android's `TelecomManager` and `InCallService` to completely replace the system dialer workflow.

## Technical Details

Nothing Dialer 1 is built as a **cross-platform Flutter application**, heavily relying on **Kotlin Platform Channels** for the deep Android integration required by `TelecomManager` and `InCallService`. The backend uses the `nothing_glyph_interface` Dart package (communicating over a MethodChannel) to manage LED sessions and bind animation sequences to call state callbacks broadcasted from the native `GlyphInCallService`.

```dart
// Example: Triggering Glyph lights from Flutter during an active call
void _triggerGlyphLights(String callState) async {
  if (callState == "DIALING") {
    // Start Outgoing call animation (e.g., Breath & Progress)
    await _glyphMethodChannel.invokeMethod('startGlyphAnimation', {
      'style': _glyphAnimationStyle,
      'duration': _glyphBreathProgressDuration,
    });
  } else if (callState == "ACTIVE") {
    // Switch to On-call Custom Channels
    await _glyphMethodChannel.invokeMethod('setCustomChannels', {
      'channels': _inCallCustomChannels,
    });
  }
}
```

## Stack

| Layer | Technology |
|---|---|
| Language | Dart, Kotlin |
| Platform | Android (Flutter) |
| Glyph API | `nothing_glyph_interface` flutter plugin |
| Telephony | Android TelecomManager & InCallService |
| UI | Flutter Framework |
| Build | Gradle, Flutter Build |

## Status

Active development on `feature/mobile`. Essential dialing, SIM selection, native `InCallService` integration, and Flutter MethodChannels are implemented. Refining ongoing call glyph synchronizations and the history log interface.
