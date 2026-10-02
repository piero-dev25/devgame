/**
 * The app mark: the `>` of a shell prompt and the play triangle of a game in
 * one glyph. Unlike the wordmark it replaced, this carries no letterforms, so
 * the product name beside it comes from branding rather than being drawn in.
 *
 * The viewBox is cropped to the chevron's stroked bounds (half the 118 stroke
 * width bleeds past the path on every side) so the glyph optically matches the
 * cap height of the name next to it instead of floating in its own padding.
 *
 * Shared by the sidebar brand and the work log's own-MCP tool icon, which
 * upstream draws with the T3 wordmark.
 */
export function DevGameMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="313 227 400 570"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M 372 286 L 654 512 L 372 738"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="118"
      />
    </svg>
  );
}
