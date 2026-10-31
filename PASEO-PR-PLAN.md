# Plan: prompt navigation on mobile in Paseo

Goal: jump up and down between your own messages on iOS and Android, and give plugins a supported way to do the same. Line references are to tag `v0.14.0`.

## How this has to go upstream

`CONTRIBUTING.md` says pull requests are closed by default and may be reimplemented by the maintainer, with credit. A core feature needs a linked discussion showing demand, and feature requests opened as issues get closed. So a discussion comes first, and the PRs are small enough that losing one costs little.

Demand already on record:
- [#5029](https://github.com/getpaseo/paseo/discussions/5029) asks for a mobile Chat Outline (2 upvotes, no comments).
- [#6634](https://github.com/getpaseo/paseo/discussions/6634) describes the same problem and also wants plugins to see list scrolling (1 upvote, no comments).

## Steps

1. **Run the experiment on a phone.** Fill in the results table below. It tells us which problems in the native code are real.
2. **Comment on #5029.** Describe the workflow, link the experiment, include a recording, and ask whether a stepper is acceptable as the first version. Don't open a new discussion.
3. **PR 1: core mobile navigation.** Only after step 2, whether or not anyone replies, and accepting it may be closed.
4. **PR 2: plugin API.** Raise it on #6634 first, and send it only if PR 1 lands or the maintainer shows interest. It depends on PR 1.

## PR 1: mobile prompt navigation

Reuse the existing outline's data flow and add the missing native pieces. Rough size is 300 to 500 production lines, against the 3,000 limit.

| Change | Where | Notes |
| --- | --- | --- |
| Add `scrollToMessage` to the native viewport handle | `agent-stream/strategy-native.tsx:353` | The field is already optional in `strategy.ts:61`, and only web sets it. Find the row in `historyRows` and call `flatListRef.scrollToOffset`. Don't use `scrollToIndex`: the list has no `onScrollToIndexFailed`, so React Native throws on unmeasured rows. |
| Release the bottom anchor before jumping | same file | Call `bottomAnchorController.detachByUser()`, the same call `holdReadingPosition` makes. A plugin can't reach this, so core should be more reliable than the experiment during a running turn. |
| Settle on estimated positions | `agent-stream/prompt-jump-settle.ts` | Try the existing settle controller with a native viewport adapter. Fall back to a small native loop only if the adapter doesn't fit. |
| Report the reading position | `strategy-native.tsx` | Call the existing `handleReadingPositionChange` in `view.tsx:1098`, so the active prompt works on native. |
| Remove the web gate | `chat-outline/use-chat-outline.ts:103` | Replace `isWeb` with a check that the viewport supports jumping. Keep the `agentTimelinePromptIndex` feature check. |
| Add the mobile control | `chat-outline/rail.tsx` | This is `null` today. Render Prev and Next beside the scroll-to-bottom button, using `activePrompt` and `jumpToPrompt`. Follow the existing Chat outline setting. |
| Translate strings | app i18n | All shipped locales. |

**Decision: a stepper first, not the bottom sheet #5029 suggests.** It's the workflow we want, it's smaller, and it needs no new surface. A sheet can reuse the same `jumpToPrompt` later.

**Non-goals:** a sheet, the sticky prompt bar from #6634, hiding agent content, and any change to the desktop rail.

**Check while building:**
- Prompts outside the loaded window, which `planTimelinePromptJump` fetches. This has never run on the native paged history.
- Android's `maintainVisibleContentPosition`, which `strategy-native.tsx` already turns off in sticky-bottom mode.
- Collapsed turns, using `hostIdByFoldedMessageId`.
- User messages in the live head, which are in the list header and not in `data`.

**Evidence the PR must include** (`docs/qa.md`, `CONTRIBUTING.md`):
- Unit tests for target selection and for settling, plus a mobile e2e flow under `packages/app/e2e/mobile`.
- Recordings on an iOS simulator and an Android emulator: idle chat, running turn, long history, collapsed turns.
- Commands and output, plus the completed platform table. This Mac has `xcodebuild` but not `simctl`, and no `adb`, so it needs full Xcode and Android tooling first.

## PR 2: plugin API

Docs say plugins get no navigation store access, but `PluginNavigableHostProps.navigation` already holds client-owned actions such as `openAgent`. Extend that pattern instead of exposing the scroll view.

```ts
// Client-owned navigation: the app decides how to scroll, load history and release the anchor.
navigation.jumpToPrompt?: (input: { agentId: string; seq: number }) => void;

// Read the prompt index, wrapping the existing daemon call listAgentTimelinePrompts.
paseo.agents.ref(agentId).timeline.prompts(): Promise<{ epoch: number; prompts: { seq: number; preview: string }[] }>;
```

Also needed:
- A hook or subscription for the active prompt, so a plugin can step from where the reader is.
- Check whether `navigation` reaches action callbacks. Today it's on host props, and a pill's `onPress` doesn't receive them.
- `docs/plugins.md`, a `plugin-examples` entry, and the SDK's compatibility rules. Make the action optional so plugins can hide it on older hosts.

This doesn't expose offsets or a list ref, so Paseo stays free to change its list. It doesn't solve the card header request in #6634.

Once this ships, `paseo-prompt-nav` drops `client/fiber.ts` and most of `client/navigator.ts`, or gets retired if PR 1's control is enough.

## Experiment results to collect

Test on the phone with a chat holding at least 10 prompts.

| Check | iOS | Android |
| --- | --- | --- |
| Prev and Next pills appear in the composer | | |
| Prev pins your previous message near the top | | |
| Next steps back down, then shows Latest | | |
| Far-away prompt lands correctly | | |
| Rapid taps | | |
| While an agent is running (does it snap back?) | | |
| Collapse turns on | | |
| Top, then Prev again after older history loads | | |
| Keyboard open | | |
| Any status shown: No fiber, No root, No list, No metrics, Missed | | |
