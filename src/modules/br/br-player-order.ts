/** Player indices by live score, highest first; equal scores keep entry order, so tied rows never swap. */
export function brPlayerOrder(scores: readonly number[]) {
  return scores
    .map((_, index) => index)
    .sort((left, right) => (scores[right] ?? 0) - (scores[left] ?? 0) || left - right);
}
