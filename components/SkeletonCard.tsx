"use client";

import type { SkeletonBox } from "@/lib/layout";

/**
 * A card at zero level of detail.
 *
 * This is deliberately NOT a spinner. The board already has a language for
 * "text you can't read yet" — the gray texture body copy turns into when you
 * zoom out. A loading card is the same idea one step further: structure
 * present, words not yet resolved. When Grok answers, the real card replaces it
 * in space that was already reserved, so the column doesn't jump.
 */
export function SkeletonCard({ box, index }: { box: SkeletonBox; index: number }) {
  return (
    <div
      className="gb-skel absolute left-0 top-0 px-4 py-4"
      style={{
        transform: `translate3d(${box.x}px, ${box.y}px, 0)`,
        width: box.w,
        height: box.h,
        // stagger so the column resolves left-to-right like it's being written
        animationDelay: `${index * 110}ms`,
      }}
    >
      {/* title: two heavier bars, matching the real card's type hierarchy */}
      <div className="gb-skel-bar h-[13px] w-[86%] rounded-[3px]" />
      <div className="gb-skel-bar mt-[9px] h-[13px] w-[54%] rounded-[3px]" />

      <div className="mt-4 flex flex-col gap-[7px]">
        {Array.from({ length: box.lines }).map((_, i) => (
          <div
            key={i}
            className="gb-skel-line h-[7px] rounded-[2px]"
            style={{
              // ragged right edge, like real prose
              width: `${[97, 92, 99, 88, 95, 71][i % 6]}%`,
              animationDelay: `${index * 110 + i * 45}ms`,
            }}
          />
        ))}
      </div>

      {/* where the citation chips will land */}
      <div className="mt-4 flex items-center gap-1.5">
        <div className="gb-skel-line h-[15px] w-[52px] rounded-[2px]" />
        <div className="gb-skel-line h-[15px] w-[74px] rounded-[2px]" />
      </div>
    </div>
  );
}
