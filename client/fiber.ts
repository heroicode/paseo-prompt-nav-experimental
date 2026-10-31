/**
 * Finds the chat's FlatList by walking React's private fiber tree. Nothing here is a Paseo or React
 * Native API: `__internalInstanceHandle`, fibers and the list's nativeID can all change in any
 * update, so every step reports failure instead of assuming the shape it found.
 */
export const CHAT_LIST_NATIVE_ID = "agent-chat-scroll-native-virtualized";

export interface Fiber {
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  stateNode: unknown;
  memoizedProps: unknown;
}

export interface ChatList {
  props: { data?: unknown; contentContainerStyle?: unknown; contentInset?: unknown };
  scrollToOffset(params: { offset: number; animated?: boolean }): void;
  _listRef?: unknown;
}

export type FindListResult =
  | { ok: true; list: ChatList }
  | { ok: false; reason: "no-fiber" | "no-root" | "no-list" };

export function fiberFromHost(host: unknown): Fiber | null {
  if (host === null || typeof host !== "object") return null;
  const handle = Reflect.get(host, "__internalInstanceHandle");
  if (handle === null || typeof handle !== "object" || !("return" in handle)) return null;
  return handle as Fiber;
}

function isChatList(fiber: Fiber): boolean {
  const props = fiber.memoizedProps;
  if (props === null || typeof props !== "object") return false;
  if (Reflect.get(props, "nativeID") !== CHAT_LIST_NATIVE_ID) return false;
  const instance = fiber.stateNode;
  return (
    instance !== null &&
    typeof instance === "object" &&
    typeof Reflect.get(instance, "scrollToOffset") === "function"
  );
}

function collectChatLists(root: Fiber): Fiber[] {
  const found: Fiber[] = [];
  const pending: Fiber[] = [root];
  while (pending.length > 0) {
    const fiber = pending.pop()!;
    if (fiber.sibling) pending.push(fiber.sibling);
    if (isChatList(fiber)) found.push(fiber);
    else if (fiber.child) pending.push(fiber.child);
  }
  return found;
}

function currentRootOf(fiber: Fiber): Fiber | null {
  let top = fiber;
  while (top.return) top = top.return;
  const container = top.stateNode;
  if (container === null || typeof container !== "object") return null;
  const current = Reflect.get(container, "current");
  return current !== null && typeof current === "object" ? (current as Fiber) : null;
}

/**
 * Paseo keeps other agents' chats mounted in the background, so the right list is the one closest
 * to the composer holding the anchor, not the first one in the tree.
 */
export function findChatList(host: unknown): FindListResult {
  const anchor = fiberFromHost(host);
  if (!anchor) return { ok: false, reason: "no-fiber" };
  const root = currentRootOf(anchor);
  if (!root) return { ok: false, reason: "no-root" };

  const anchorDepths = new Map<Fiber, number>();
  let depth = 0;
  for (let fiber: Fiber | null = anchor; fiber; fiber = fiber.return, depth += 1) {
    anchorDepths.set(fiber, depth);
    if (fiber.alternate) anchorDepths.set(fiber.alternate, depth);
  }

  let closest: { fiber: Fiber; distance: number } | null = null;
  for (const candidate of collectChatLists(root)) {
    let steps = 0;
    let fiber: Fiber | null = candidate;
    while (fiber && !anchorDepths.has(fiber)) {
      fiber = fiber.return;
      steps += 1;
    }
    if (!fiber) continue;
    const distance = steps + anchorDepths.get(fiber)!;
    if (!closest || distance < closest.distance) closest = { fiber: candidate, distance };
  }
  return closest
    ? { ok: true, list: closest.fiber.stateNode as ChatList }
    : { ok: false, reason: "no-list" };
}
