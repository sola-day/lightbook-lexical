/**
 * `MarkNode` (from `@lexical/mark`) is reused for BOTH comment threads and
 * suggestion-mode spans instead of two custom node subclasses (Lexical
 * 0.51's node-config API makes subclassing `MarkNode` considerably more
 * involved than earlier versions — see the `$config()`/`nodeSchema()`
 * machinery in `@lexical/mark`'s source — while `MarkNode` itself already
 * supports arbitrary opaque string ids and overlapping ranges, which is all
 * either feature needs). The two are told apart purely by an id-prefix
 * convention, read by the mutation-listener-driven styling in
 * `src/comments/styling.ts`.
 */
export const COMMENT_ID_PREFIX = "c:";
export const SUGGESTION_INSERT_PREFIX = "si:";
export const SUGGESTION_DELETE_PREFIX = "sd:";

export function commentMarkId(threadId: string): string {
  return `${COMMENT_ID_PREFIX}${threadId}`;
}

export function isCommentMarkId(id: string): boolean {
  return id.startsWith(COMMENT_ID_PREFIX);
}

export function threadIdFromMarkId(id: string): string | null {
  return isCommentMarkId(id) ? id.slice(COMMENT_ID_PREFIX.length) : null;
}

export function suggestionInsertMarkId(suggestionId: string): string {
  return `${SUGGESTION_INSERT_PREFIX}${suggestionId}`;
}

export function suggestionDeleteMarkId(suggestionId: string): string {
  return `${SUGGESTION_DELETE_PREFIX}${suggestionId}`;
}

export function isSuggestionInsertMarkId(id: string): boolean {
  return id.startsWith(SUGGESTION_INSERT_PREFIX);
}

export function isSuggestionDeleteMarkId(id: string): boolean {
  return id.startsWith(SUGGESTION_DELETE_PREFIX);
}

export function suggestionIdFromMarkId(id: string): string | null {
  if (isSuggestionInsertMarkId(id)) return id.slice(SUGGESTION_INSERT_PREFIX.length);
  if (isSuggestionDeleteMarkId(id)) return id.slice(SUGGESTION_DELETE_PREFIX.length);
  return null;
}
