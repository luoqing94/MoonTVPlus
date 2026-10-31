/**
 * Parallel slot default: no play overlay when the URL is not a soft /play.
 * Required so sibling routes (/, /search, …) can render without the slot.
 */
export default function PlayModalDefault() {
  return null;
}
