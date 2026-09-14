import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/*
 * TWO BUTTONS, AND THERE IS ONE FILLED ONE IN A VIEW.
 *
 * The alkor ledger world allows exactly one filled object per view — the primary action — and
 * it carries the one accent. Everything else is ruled or bare. That is why `secondary` is no
 * longer a filled grey block and `link` no longer letters itself in the accent: a second and
 * third fill is precisely how this surface stops reading as a ledger and starts reading as
 * generic app chrome.
 *
 * `shadow-xs` is gone from every variant. Nothing here floats, so a shadow on a control that
 * sits flat on the page was drawing an elevation the system does not have — and the tokens
 * behind it now resolve to `none` anyway, so leaving it would have been a dead declaration
 * that still read as intent.
 *
 * `rounded-md` stays and needs no change: `--radius-md` points at the ledger's 2px square
 * through the token block in styles.css, so every one of these is already square.
 */
const buttonVariants = cva(
  // A DISABLED BUTTON LOSES ITS FILL RATHER THAN FADING IT. `disabled:opacity-50` used to do
  // this job, and against an accent fill it produced a washed-out orange block — a colour that
  // is in the palette nowhere, still reading as the loudest object in the view while being the
  // one thing you cannot press. It also dropped the label under the 4.5:1 floor. So disabled
  // drops to the ruled shape: no fill, the dimmest ink the system allows, a hairline. That is
  // also what keeps "one filled object per view" true while the primary action is unavailable.
  // `border border-transparent` in the base, so every variant reserves the 1px the ruled ones
  // draw. Without it `disabled:border-border` sets a colour on a zero-width border and the
  // disabled primary action renders as bare floating text; with it, the fill is replaced by a
  // hairline of the same size and nothing shifts by a pixel when a button becomes available.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-xs font-semibold transition-all disabled:pointer-events-none disabled:bg-transparent disabled:text-faint disabled:border-border [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // The one filled object. Accent fill, 4.97:1 dark / 4.61:1 light under its own ink.
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        // A destructive primary action is still the view's one action, so it keeps the fill —
        // it simply spends the danger hue instead of the accent to say what it will do.
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border bg-background hover:bg-accent hover:text-accent-foreground',
        // Ruled, not filled. It reads as secondary by having no fill, not by having a quieter
        // one — there is no quieter fill in a world with a single surface.
        secondary: 'border border-border text-secondary-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        // Ink with a rule under it. The accent does not do words, and a 12px link is a word.
        link: 'text-foreground underline underline-offset-4 decoration-border hover:decoration-current',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }