/**
 * The alkor wordmark, as outlines.
 *
 * These are the five glyphs of InterDisplay-SemiBold with two character variants applied:
 * cv05 (lowercase l with a tail) and cv11 (single-story a). They are the only two alternates
 * this family offers for the letters a-l-k-o-r, and cv05 is the one variant Adwaita Sans --
 * which is Inter -- freezes on, so the mark carries the glyph the project's own desktop font
 * already chose. Tracking is -0.03em, baked into the advances below.
 *
 * It ships as paths rather than text for a reason that is not aesthetic: the web-delivered
 * Inter (Google Fonts / Fontsource) carries NO cv features at all, so `font-feature-settings:
 * "cv05" 1` against it silently does nothing. Outlines render the intended mark everywhere,
 * cannot flash unstyled, and cost ~1.5 kB against the 352 kB of the only Inter build that
 * would reproduce them as live text.
 *
 * `fill="currentColor"` so the mark inherits `color` and follows the theme. Height is set in
 * CSS; the aspect ratio (2.894) is fixed by the viewBox.
 */
export const Logotype = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="63 -1490 4382 1514"
    role="img"
    aria-label="alkor"
    focusable="false"
  >
    <path
      fill="currentColor"
      d="M520 21Q382 21 279 -48Q176 -117 120 -240Q63 -364 63 -529Q63 -691 120 -814Q177 -938 280 -1008Q383 -1077 518 -1077Q621 -1077 705 -1035Q789 -993 838 -909L842 -909L842 -1056L1089 -1056L1089 0L842 0L842 -159L839 -159Q789 -69 706 -24Q623 21 520 21ZM579 -190Q703 -190 778 -282Q852 -375 852 -529Q852 -683 778 -776Q703 -868 579 -868Q462 -868 390 -780Q318 -692 318 -529Q318 -365 390 -278Q462 -190 579 -190ZM1569 0Q1400 0 1326 -62Q1252 -125 1252 -270L1252 -1490L1504 -1490L1504 -295Q1504 -239 1524 -219Q1545 -199 1600 -199L1642 -199L1642 0L1569 0ZM1719 0L1719 -1490L1971 -1490L1971 -628L1974 -628L2385 -1056L2688 -1056L2259 -600L2714 0L2413 0L2067 -452L1971 -353L1971 0L1719 0ZM3228 24Q3072 24 2955 -46Q2838 -115 2772 -239Q2707 -363 2707 -527Q2707 -691 2772 -816Q2838 -940 2955 -1010Q3072 -1080 3228 -1080Q3383 -1080 3500 -1010Q3618 -940 3683 -816Q3749 -691 3749 -527Q3749 -363 3683 -239Q3618 -115 3500 -46Q3383 24 3228 24ZM3228 -187Q3349 -187 3421 -278Q3493 -369 3493 -527Q3493 -685 3421 -777Q3349 -869 3228 -869Q3106 -869 3034 -778Q2962 -686 2962 -527Q2962 -369 3034 -278Q3106 -187 3228 -187ZM3861 0L3861 -1056L4104 -1056L4104 -881L4107 -881Q4136 -971 4199 -1018Q4261 -1066 4363 -1066Q4389 -1066 4410 -1064Q4430 -1063 4445 -1062L4445 -838Q4431 -840 4397 -843Q4363 -846 4326 -846Q4236 -846 4175 -784Q4113 -722 4113 -598L4113 0L3861 0Z"
    />
  </svg>
)
