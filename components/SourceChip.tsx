"use client";

/**
 * The web citation, mirroring PostChip.
 *
 * An option isn't true or false, so this isn't proving anything the way a post
 * chip proves a claim. It answers a different question — where the price and
 * the specs on this card were read from — which is what makes an attribute
 * something other than a number the model liked the look of.
 *
 * Shows the SITE, not the headline: on an options board the useful signal is
 * whether this came from Car and Driver or from a content farm, and the page
 * title is usually a listicle headline that says nothing.
 */
export function SourceChip({
  url,
  title,
  siteName,
}: {
  url: string;
  title: string;
  siteName?: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`${title}\n\n${url}`}
      className="group flex shrink-0 items-center gap-1 border px-[5px] py-[3px] transition-colors"
      style={{ borderColor: "var(--gb-line)", borderRadius: 2 }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--gb-line-max)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--gb-line)";
      }}
    >
      <span
        className="gb-label whitespace-nowrap transition-colors group-hover:!text-[var(--gb-text)]"
        style={{
          color: "var(--gb-dim)",
          letterSpacing: "0.02em",
          fontSize: "11.5px",
          textTransform: "none",
        }}
      >
        {siteName ?? new URL(url).hostname.replace(/^www\./, "")}
      </span>
    </a>
  );
}
