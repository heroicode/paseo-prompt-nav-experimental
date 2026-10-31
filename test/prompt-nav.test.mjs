import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_LIST_NATIVE_ID, findChatList } from "../client/fiber.ts";
import { createNavigator } from "../client/navigator.ts";

function fiber(props = {}, stateNode = null) {
  return { return: null, child: null, sibling: null, alternate: null, stateNode, memoizedProps: props };
}

function link(parent, ...children) {
  parent.child = children[0] ?? null;
  children.forEach((child, index) => {
    child.return = parent;
    child.sibling = children[index + 1] ?? null;
  });
  return parent;
}

function chatList(name) {
  return fiber({ nativeID: CHAT_LIST_NATIVE_ID }, { name, props: {}, scrollToOffset() {} });
}

function renderedTree() {
  const backgroundList = chatList("background");
  const activeList = chatList("active");
  const pillHost = fiber();
  const composer = link(fiber(), pillHost);
  const activePane = link(fiber(), activeList, composer);
  const backgroundPane = link(fiber(), backgroundList);
  const hostRoot = link(fiber(), backgroundPane, activePane);
  hostRoot.stateNode = { current: hostRoot };
  return { pillHost, hostRoot };
}

test("picks the chat beside the composer, not a background pane mounted earlier", () => {
  const { pillHost } = renderedTree();
  const result = findChatList({ __internalInstanceHandle: pillHost });
  assert.equal(result.ok, true);
  assert.equal(result.list.name, "active");
});

test("finds the list when the anchor holds the alternate fiber", () => {
  const { pillHost } = renderedTree();
  const stale = fiber();
  stale.return = pillHost.return.alternate ?? pillHost.return;
  stale.alternate = pillHost;
  const result = findChatList({ __internalInstanceHandle: stale });
  assert.equal(result.list.name, "active");
});

test("reports which internal was missing", () => {
  assert.deepEqual(findChatList(undefined), { ok: false, reason: "no-fiber" });
  assert.deepEqual(findChatList({}), { ok: false, reason: "no-fiber" });
  const lonely = fiber();
  lonely.stateNode = { current: lonely };
  assert.deepEqual(findChatList({ __internalInstanceHandle: lonely }), {
    ok: false,
    reason: "no-list",
  });
});

/** An inverted list: index 0 is at offset 0, the bottom of the screen. */
function fakeList({
  rows,
  cellLength = 100,
  visibleLength = 400,
  measuredUpTo = rows.length,
  approx,
  clearance = 0,
  contentInset,
}) {
  const offsets = [];
  const list = {
    props: {
      data: rows,
      contentContainerStyle: [{ paddingBottom: 999 }, { paddingBottom: clearance }],
      contentInset,
    },
    scrollToOffset({ offset }) {
      offsets.push(offset);
      list._listRef._scrollMetrics.offset = offset;
    },
    _listRef: {
      props: {},
      _scrollMetrics: { offset: 0, visibleLength },
      _listMetrics: {
        getCellMetrics: (index) =>
          index < list.measuredUpTo ? { offset: index * cellLength, length: cellLength } : null,
        getCellMetricsApprox: (index) =>
          index < list.measuredUpTo || !approx
            ? { offset: index * cellLength, length: cellLength }
            : approx(index),
        getContentLength: () => rows.length * cellLength,
      },
    },
    measuredUpTo,
    offsets,
  };
  return list;
}

const rowsOf = (...kinds) => kinds.map((kind, index) => ({ kind, id: `row-${index}` }));
const navigatorWith = (wait = async () => {}) => createNavigator({ wait });
const MARGIN = 16;
const GAP = 16;

test("older pins the next prompt above the viewport to the top", async () => {
  const rows = rowsOf("a", "user_message", "a", "a", "a", "a", "user_message", "a");
  const list = fakeList({ rows });
  // Viewport shows offsets 0-400, so row 1 is already visible and row 6 is the next one up.
  assert.equal(await navigatorWith().navigate(list, "older"), "jumped");
  assert.equal(list._listRef._scrollMetrics.offset, 7 * 100 - 400 - MARGIN + GAP);
});

test("newer steps back down one prompt, then reports the latest", async () => {
  const rows = rowsOf("user_message", "a", "a", "a", "a", "a", "user_message", "a");
  const list = fakeList({ rows });
  list._listRef._scrollMetrics.offset = 300 - MARGIN + GAP; // pinned on row 6
  const navigator = navigatorWith();
  assert.equal(await navigator.navigate(list, "newer"), "jumped");
  assert.equal(list._listRef._scrollMetrics.offset, 0);
  assert.equal(await navigator.navigate(list, "newer"), "latest");
});

test("puts the top of the text box just below the header", async () => {
  const rows = rowsOf("a", "a", "a", "a", "a", "user_message");
  const list = fakeList({ rows, clearance: 110 });
  await navigatorWith().navigate(list, "older");
  assert.equal(list._listRef._scrollMetrics.offset, 6 * 100 - 400 + 110 - MARGIN + GAP);
});

test("adds the iOS keyboard inset to the header clearance", async () => {
  const rows = rowsOf("a", "a", "a", "a", "a", "user_message");
  const list = fakeList({ rows, clearance: 110, contentInset: { bottom: 300 } });
  await navigatorWith().navigate(list, "older");
  assert.equal(list._listRef._scrollMetrics.offset, 6 * 100 - 400 + 110 + 300 - MARGIN + GAP);
});

test("only the first of adjacent prompts has the margin above its text box", async () => {
  const rows = rowsOf("a", "a", "a", "a", "a", "user_message", "user_message", "a");
  const list = fakeList({ rows });
  list._listRef._scrollMetrics.offset = 100;
  await navigatorWith().navigate(list, "older");
  assert.equal(list._listRef._scrollMetrics.offset, 6 * 100 - 400 + GAP);
});

test("a pinned prompt steps to its neighbours, not back to itself", async () => {
  const rows = rowsOf("user_message", "a", "a", "a", "a", "user_message", "a", "a", "a", "user_message");
  const list = fakeList({ rows, clearance: 110 });
  const navigator = navigatorWith();
  await navigator.navigate(list, "older");
  const onFive = list._listRef._scrollMetrics.offset;
  assert.equal(onFive, 6 * 100 - 400 + 110 - MARGIN + GAP);
  await navigator.navigate(list, "older");
  assert.equal(list._listRef._scrollMetrics.offset, 10 * 100 - 400 + 110 - MARGIN + GAP);
  await navigator.navigate(list, "newer");
  assert.equal(list._listRef._scrollMetrics.offset, onFive);
});

test("older past the last loaded prompt scrolls to the top to page in history", async () => {
  const list = fakeList({ rows: rowsOf("user_message", "a") });
  assert.equal(await navigatorWith().navigate(list, "older"), "oldest-loaded");
  assert.deepEqual(list.offsets, [200]);
});

test("re-aims as an unmeasured row's estimated position firms up", async () => {
  const rows = rowsOf("a", "a", "a", "a", "a", "a", "a", "a", "a", "user_message");
  const list = fakeList({ rows, measuredUpTo: 5, approx: (index) => ({ offset: index * 60, length: 60 }) });
  const navigator = navigatorWith(async () => {
    list.measuredUpTo = rows.length;
  });
  assert.equal(await navigator.navigate(list, "older"), "jumped");
  assert.deepEqual(list.offsets, [10 * 60 - 400 - MARGIN + GAP, 10 * 100 - 400 - MARGIN + GAP]);
});

test("reports a jump that never settles, such as the anchor pulling back to the bottom", async () => {
  const rows = rowsOf("a", "a", "a", "a", "a", "a", "user_message");
  const list = fakeList({ rows });
  const navigator = navigatorWith(async () => {
    list._listRef._scrollMetrics.offset = 0;
  });
  assert.equal(await navigator.navigate(list, "older"), "unsettled");
});

test("a second tap during a jump moves one prompt on from where it was heading", async () => {
  const rows = rowsOf("user_message", "a", "a", "a", "a", "a", "user_message", "a", "a", "a", "user_message");
  const list = fakeList({ rows });
  const waiting = [];
  const navigator = createNavigator({
    wait: () => new Promise((resolve) => waiting.push(resolve)),
  });
  const first = navigator.navigate(list, "older");
  const second = navigator.navigate(list, "older");
  waiting.splice(0).forEach((resolve) => resolve());
  assert.equal(await first, "superseded");
  assert.equal(await second, "jumped");
  assert.equal(list._listRef._scrollMetrics.offset, 11 * 100 - 400 - MARGIN + GAP);
});

test("reports missing list internals instead of throwing", async () => {
  const list = { props: { data: [] }, scrollToOffset() {}, _listRef: {} };
  assert.equal(await navigatorWith().navigate(list, "older"), "no-metrics");
});
