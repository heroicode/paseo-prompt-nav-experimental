import type { ChatList } from "./fiber";

export type Direction = "older" | "newer";

export type NavigationResult =
  | "jumped"
  | "oldest-loaded"
  | "latest"
  | "no-prompts"
  | "no-metrics"
  | "unsettled"
  | "superseded";

interface CellMetrics {
  length: number;
  offset: number;
}

interface ListInternals {
  props: unknown;
  _scrollMetrics: { offset: number; visibleLength: number };
  _listMetrics: {
    getCellMetrics(index: number, props: unknown): CellMetrics | null | undefined;
    getCellMetricsApprox(index: number, props: unknown): CellMetrics;
    getContentLength(): number;
  };
}

export interface NavigatorOptions {
  wait(ms: number): Promise<void>;
}

/** Used only if the list stops exposing its clearance. */
const FALLBACK_TOP_CLEARANCE = 72;
/** Room between the header and the text box, to lift the text out of the header's fade. */
const GAP_BELOW_HEADER = 16;
/** `containerFirstInGroup` in Paseo's message.tsx: the gap between a row's top and its text box. */
const USER_MESSAGE_GROUP_TOP_MARGIN = 16;
const POSITION_TOLERANCE = 8;
const SETTLED_TOLERANCE = 2;
const MAX_ATTEMPTS = 12;
const SETTLE_DELAY_MS = 120;

function internalsOf(list: ChatList): ListInternals | null {
  const internals = list._listRef as Partial<ListInternals> | null | undefined;
  if (
    typeof internals?._scrollMetrics?.offset !== "number" ||
    typeof internals._scrollMetrics.visibleLength !== "number" ||
    typeof internals._listMetrics?.getCellMetrics !== "function" ||
    typeof internals._listMetrics.getCellMetricsApprox !== "function" ||
    typeof internals._listMetrics.getContentLength !== "function"
  ) {
    return null;
  }
  return internals as ListInternals;
}

function rowsOf(list: ChatList): readonly { kind?: unknown; id?: unknown }[] {
  const { data } = list.props;
  return Array.isArray(data) ? data : [];
}

function lastPaddingBottom(style: unknown): number | null {
  if (Array.isArray(style)) {
    for (let index = style.length - 1; index >= 0; index -= 1) {
      const padding = lastPaddingBottom(style[index]);
      if (padding !== null) return padding;
    }
    return null;
  }
  if (style === null || typeof style !== "object") return null;
  const padding = Reflect.get(style, "paddingBottom");
  return typeof padding === "number" ? padding : null;
}

/**
 * How far below the list's visual top the header overlay ends. An inverted list's bottom padding is
 * its visual top, and Paseo puts the measured header height there, plus the keyboard shift. iOS
 * carries that shift in contentInset instead.
 */
function topClearanceOf(list: ChatList): number {
  const padding = lastPaddingBottom(list.props.contentContainerStyle);
  if (padding === null) return FALLBACK_TOP_CLEARANCE + GAP_BELOW_HEADER;
  const { contentInset } = list.props;
  const inset =
    contentInset !== null && typeof contentInset === "object"
      ? Reflect.get(contentInset, "bottom")
      : 0;
  return padding + (typeof inset === "number" ? inset : 0) + GAP_BELOW_HEADER;
}

function promptIndexes(rows: readonly { kind?: unknown }[]): number[] {
  const indexes: number[] = [];
  rows.forEach((row, index) => {
    if (row?.kind === "user_message") indexes.push(index);
  });
  return indexes;
}

/**
 * The list is inverted: index 0 and offset 0 are the newest content at the bottom of the screen, so
 * a higher offset is further up. A prompt's visual top is therefore the far end of its cell.
 */
export function createNavigator({ wait }: NavigatorOptions) {
  let generation = 0;
  let pendingId: unknown = null;

  /** The text box's top, in list coordinates. Only the first of adjacent prompts has the margin. */
  function boxTopOf(internals: ListInternals, rows: readonly { kind?: unknown }[], index: number) {
    const cell = internals._listMetrics.getCellMetricsApprox(index, internals.props);
    const margin = rows[index + 1]?.kind === "user_message" ? 0 : USER_MESSAGE_GROUP_TOP_MARGIN;
    return cell.offset + cell.length - margin;
  }

  function pinOffset(list: ChatList, internals: ListInternals, index: number): number {
    const { visibleLength } = internals._scrollMetrics;
    const boxTop = boxTopOf(internals, rowsOf(list), index);
    return Math.max(0, boxTop - visibleLength + topClearanceOf(list));
  }

  function chooseIndex(
    list: ChatList,
    internals: ListInternals,
    rows: readonly { kind?: unknown; id?: unknown }[],
    prompts: readonly number[],
    direction: Direction,
  ): number | null {
    // Taps during a running jump step from where it's heading, since the viewport hasn't got there.
    const pendingIndex = pendingId === null ? -1 : rows.findIndex((row) => row?.id === pendingId);
    const position = prompts.indexOf(pendingIndex);
    if (position !== -1) {
      return prompts[position + (direction === "older" ? 1 : -1)] ?? null;
    }

    const { offset, visibleLength } = internals._scrollMetrics;
    const readingLine = offset + visibleLength - topClearanceOf(list);
    const topOf = (index: number) => boxTopOf(internals, rows, index);
    if (direction === "older") {
      return prompts.find((index) => topOf(index) > readingLine + POSITION_TOLERANCE) ?? null;
    }
    return (
      [...prompts].reverse().find((index) => topOf(index) < readingLine - POSITION_TOLERANCE) ??
      null
    );
  }

  async function navigate(list: ChatList, direction: Direction): Promise<NavigationResult> {
    generation += 1;
    const current = generation;
    const internals = internalsOf(list);
    if (!internals) return "no-metrics";

    const rows = rowsOf(list);
    const prompts = promptIndexes(rows);
    const chosen = chooseIndex(list, internals, rows, prompts, direction);
    // Near the bottom a newer prompt's pin clamps to where the list already is, so there's nothing
    // left to step to except the latest output.
    const target =
      chosen !== null &&
      direction === "newer" &&
      Math.abs(pinOffset(list, internals, chosen) - internals._scrollMetrics.offset) <= SETTLED_TOLERANCE
        ? null
        : chosen;

    if (target === null) {
      pendingId = null;
      if (direction === "newer") {
        list.scrollToOffset({ offset: 0, animated: true });
        return "latest";
      }
      // Reaching the top is what makes Paseo load the next page of older history.
      list.scrollToOffset({ offset: internals._listMetrics.getContentLength(), animated: true });
      return prompts.length === 0 ? "no-prompts" : "oldest-loaded";
    }

    const targetId = rows[target]?.id;
    pendingId = targetId;
    // Rows far from the viewport have estimated positions, which firm up as the list renders them,
    // so keep re-aiming until a measured row is where it should be.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (current !== generation) return "superseded";
      const latestRows = rowsOf(list);
      const index = latestRows.findIndex((row) => row?.id === targetId);
      if (index === -1) break;
      const destination = pinOffset(list, internals, index);
      const measured = internals._listMetrics.getCellMetrics(index, internals.props) != null;
      if (
        measured &&
        Math.abs(internals._scrollMetrics.offset - destination) <= SETTLED_TOLERANCE
      ) {
        pendingId = null;
        return "jumped";
      }
      list.scrollToOffset({ offset: destination, animated: false });
      await wait(SETTLE_DELAY_MS);
    }
    if (current !== generation) return "superseded";
    pendingId = null;
    return "unsettled";
  }

  return { navigate };
}
