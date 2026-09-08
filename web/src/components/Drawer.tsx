/**
 * Drawer — right-hand slide-over that carries the activity feed and the inspector
 * without stealing space from the graph. The graph is the primary view; everything
 * else lives here or in the collapsible event log at the bottom.
 */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from './ui/button'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title: string
  children?: ReactNode
}

export const Drawer = ({ open, onClose, title, children }: DrawerProps) => (
  <aside className={`drawer${open ? ' is-open' : ''}`} aria-hidden={!open}>
    <div className="drawer-head">
      <span className="drawer-title">{title}</span>
      <Button variant="ghost" size="sm" onClick={onClose} aria-label={`close ${title}`}>
        <X size={14} />
      </Button>
    </div>
    <div className="drawer-body">{children}</div>
    {!open && (
      <button className="drawer-tab" onClick={onClose} aria-label={`open ${title}`}>
        {title}
      </button>
    )}
  </aside>
)