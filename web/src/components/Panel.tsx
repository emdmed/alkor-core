import type { ReactNode } from 'react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './ui/card'

export interface PanelProps {
  title: string
  subtitle?: string
  children?: ReactNode
}

export const Panel = ({ title, subtitle, children }: PanelProps) => (
  <Card className="h-full min-h-0">
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      {subtitle && <CardDescription>{subtitle}</CardDescription>}
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
)