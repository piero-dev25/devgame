/**
 * Sanitiser for provider-failure `detail` strings before they become a
 * client-visible, PERSISTED thread activity.
 *
 * Why this exists (task #76, reproduced against the real reactor): the
 * provider input cap is enforced, but the REJECTION was not. A 130,000-char
 * message rejected at the `ProviderSendTurnInput` boundary produced a
 * 131,752-char activity detail, because `SchemaIssue.makeFormatterDefault()`
 * embeds the entire offending value verbatim (`... got "AAAA…"`) and
 * `Cause.pretty` then appends a stack trace. That detail is written to the
 * event store, broadcast over the websocket, and rendered. One rejected
 * message produced ~394KB of thread state.
 *
 * TRUNCATION IS SAFE HERE, and this is the reason it is truncation rather
 * than a log sink: the rejected payload is ALREADY stored in full as the
 * user's own message on the same thread (verified: `messages[0].text` holds
 * the complete 130,000 chars). Echoing it into the error detail duplicates
 * something the thread already has, so bounding it loses nothing
 * recoverable. The marker below says where the full text lives, so the
 * debugging path stays discoverable instead of silently disappearing —
 * silent truncation is the failure mode this codebase has already been bitten
 * by twice (see the diff-truncation task #66).
 *
 * HEAD AND TAIL, not just head: for a decode failure the head carries the
 * error class ("Expected a value with a length of at most 120000") and the
 * tail carries the stack frame that threw. Keeping only one end throws away
 * half of what makes the error actionable.
 */

/** Total budget for a sanitised detail. Generous enough for a normal stack
 *  trace to pass through untouched, small enough that a rejected payload
 *  cannot dominate thread state. */
export const FAILURE_DETAIL_MAX_CHARS = 2_000;

/** Reserved for the omission marker so the returned string stays within
 *  `maxChars` no matter how large the omitted count renders. */
const MARKER_BUDGET_CHARS = 200;

/** Absolute prefixes are stripped back to these workspace-relative roots, so
 *  a stack frame stays useful (`apps/server/src/...:1264:37`) without
 *  publishing the server's filesystem layout to every connected client. */
const WORKSPACE_ROOT_SEGMENTS = ["apps", "packages", "node_modules"] as const;

// `/` is excluded from the segment class deliberately: with it included,
// `(?:/[^...]+)*` can match the same text more than one way and backtracks
// catastrophically. This function runs over strings that embed a rejected
// user payload, so a quadratic regex here would be a denial of service on the
// main event loop. One segment per repetition keeps it linear.
const WORKSPACE_PATH_PREFIX = new RegExp(
  String.raw`(?:/[^\s()'"<>:/]+)*/(?=(?:${WORKSPACE_ROOT_SEGMENTS.join("|")})/)`,
  "g",
);

// Any remaining absolute home-directory path (a worktree outside the repo, a
// temp dir, a config file) keeps its shape but loses the account name.
const HOME_DIRECTORY_PREFIX = /(?:\/Users|\/home)\/[^\s()'"/<>:]+/g;

/**
 * Rewrite absolute filesystem paths to workspace-relative or `~`-relative
 * form. Deliberately NOT a blanket path redaction: approval and file-change
 * details legitimately name paths the user needs to read, so this narrows
 * what is disclosed rather than destroying meaning.
 */
export function stripAbsolutePaths(detail: string): string {
  return detail.replace(WORKSPACE_PATH_PREFIX, "").replace(HOME_DIRECTORY_PREFIX, "~");
}

/**
 * Bound `detail` to `maxChars`, keeping both ends and stating plainly what
 * was dropped. Returns the input unchanged when it already fits.
 */
export function boundFailureDetail(detail: string, maxChars = FAILURE_DETAIL_MAX_CHARS): string {
  if (detail.length <= maxChars) {
    return detail;
  }
  const contentBudget = Math.max(0, maxChars - MARKER_BUDGET_CHARS);
  const headChars = Math.floor(contentBudget * 0.7);
  const tailChars = contentBudget - headChars;
  const omitted = detail.length - headChars - tailChars;
  const marker =
    `\n\n[… ${omitted} of ${detail.length} characters omitted. ` +
    `If this was a rejected message, its full text is preserved on the user ` +
    `message in this thread. …]\n\n`;
  return `${detail.slice(0, headChars)}${marker}${detail.slice(detail.length - tailChars)}`;
}

/**
 * The single guard applied to every provider-failure activity detail.
 * Paths are rewritten BEFORE bounding so a truncation boundary can never
 * leave a half-scrubbed absolute path behind.
 */
export function sanitizeFailureDetail(detail: string, maxChars = FAILURE_DETAIL_MAX_CHARS): string {
  return boundFailureDetail(stripAbsolutePaths(detail), maxChars);
}
