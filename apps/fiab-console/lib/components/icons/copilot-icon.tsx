import * as React from 'react';

/**
 * Copilot brand mark — the colorful 4-point "blossom/sparkle" with the Copilot
 * gradient (teal → purple → pink). @fluentui/react-icons ships no Copilot glyph,
 * so this is a self-contained SVG. Sized at 1em like the Fluent icons, so it
 * drops into the same icon slots (nav rows, the top-bar action cluster) and
 * scales with the surrounding font-size. The gradient is fixed-color (it ignores
 * currentColor) so the mark stays on-brand in light/dark and selected states.
 */
export function CopilotIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <defs>
        <linearGradient id="loom-copilot-grad" x1="2.5" y1="3" x2="21.5" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#18B5C9" />
          <stop offset="0.5" stopColor="#6E5BD8" />
          <stop offset="1" stopColor="#F2509E" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.5c.78 5.7 4.78 9.7 10.5 10.5-5.72.8-9.72 4.8-10.5 10.5-.78-5.7-4.78-9.7-10.5-10.5C7.22 11.2 11.22 7.2 12 1.5Z"
        fill="url(#loom-copilot-grad)"
      />
    </svg>
  );
}

export default CopilotIcon;
