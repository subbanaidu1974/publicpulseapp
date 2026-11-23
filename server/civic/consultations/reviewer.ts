/**
 * Pluggable comment reviewer (S-36 b). The platform does NOT call any external AI service. The default is a no-op that summarises
 * nothing, so the closing report says "0 comments machine-summarised" unless a real implementation was installed AND ran.
 * A reviewer only ever returns what it actually processed; the coverage numbers in the closing report are counted from the
 * rows we store, never taken from a reviewer's claim about itself.
 */
export interface ReviewItem { id: string; clause: number; text: string }
export interface ReviewTheme { clause: number | null; label_en: string; label_te?: string | null }
export interface ReviewOutput {
  /** Ids of the comments the reviewer actually summarised (a subset of the input). */
  summarised_ids: string[];
  themes: ReviewTheme[];
}
export interface CommentReviewer {
  /** Short public name of the method, shown in the closing report ("none" for the no-op). */
  readonly name: string;
  /** "none" never counts as machine summarisation. */
  readonly kind: "none" | "machine";
  review(items: ReviewItem[]): Promise<ReviewOutput> | ReviewOutput;
}

export const noopReviewer: CommentReviewer = { name: "none", kind: "none", review: () => ({ summarised_ids: [], themes: [] }) };

let current: CommentReviewer = noopReviewer;
export const getCommentReviewer = (): CommentReviewer => current;
/** Install a reviewer (a deployment adapter or a test double); null restores the no-op. */
export function setCommentReviewer(r: CommentReviewer | null): void { current = r ?? noopReviewer; }
