/**
 * The chat's content column: the transcript's rows and the composer's band are
 * drawn inside it, so a row and the composer start and end on the same two
 * lines.
 *
 * Only the content is capped, never the scroller: the transcript scrolls the
 * whole region, so its scrollbar stays on the region's edge where a scrollbar
 * belongs, with the column centred under it.
 */
export const CONTENT_COLUMN = "mx-auto w-full max-w-5xl px-2 min-[840px]:px-4";
