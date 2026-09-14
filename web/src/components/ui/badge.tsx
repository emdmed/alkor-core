import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/*
 * THE PILL: a mono tag, square, and never filled.
 *
 * This is `.alk-pill` from the alkor ledger world, expressed as the component the dashboard
 * already had. Two things changed and both are the system rather than taste.
 *
 * IT LOST ITS FILLS. Every variant used to be a solid block — accent, grey or red — which put
 * three filled objects in a rail that is allowed one per view, and did it in a column where a
 * dozen of them stack. A pill is a tag, not an action: it says what something IS. So the hue
 * moves to the border and the text, and the shape carries no fill at all.
 *
 * ITS VARIANTS NAME RUN STATES. `default` / `secondary` / `destructive` are shadcn's generic
 * tones, and mapping "active" onto "default" is how the accent — which means identity and
 * interaction, and nothing else — ended up meaning "this is running". The reserved hues mean
 * run state and the variants now say so out loud, which also makes a wrong one obvious at the
 * call site instead of three files away.
 *
 * `active` is `--warn`, because that is what "running, pending, unverified" is in this world.
 * Nothing here is the accent: a pill is never the current item.
 *
 * State is still never carried by colour alone — every one of these ships around a glyph or a
 * word, and the hue is the second signal.
 */
const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 font-mono text-xs font-medium tracking-wide tabular-nums w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none transition-colors overflow-hidden",
  {
    variants: {
      variant: {
        // The plain tag: no state, just a label. This is the default because most pills are.
        outline: 'border-border text-muted-foreground',
        active: 'border-warn text-warn',
        done: 'border-ok text-ok',
        failed: 'border-danger text-danger',
        // Nothing has happened to it yet, or nothing is left to happen. The dimmest rung.
        idle: 'border-border text-faint',
      },
    },
    defaultVariants: {
      variant: 'outline',
    },
  },
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }