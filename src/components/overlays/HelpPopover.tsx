import { BookOpen, Headphones, MessagesSquare, Store } from 'lucide-react'

import { ActionMenu } from './primitives'
import type { ControlledOverlayProps, MenuItemSpec, OverlayPosition } from './primitives'

export type HelpAction = 'guide' | 'customer-service' | 'sales' | 'social'

export interface HelpPopoverProps extends ControlledOverlayProps {
  onAction?: (action: HelpAction) => void
  position?: OverlayPosition
}

const helpItems: ReadonlyArray<MenuItemSpec<HelpAction>> = [
  { action: 'guide', icon: BookOpen, label: '新手教程' },
  { action: 'customer-service', disabled: true, icon: Headphones, label: '联系客服' },
  { action: 'sales', disabled: true, icon: Store, label: '商务合作' },
  { action: 'social', disabled: true, icon: MessagesSquare, label: '创作者社群' },
]

export function HelpPopover({ onAction, onClose, open, position }: HelpPopoverProps) {
  return <ActionMenu className="help-popover" items={helpItems} label="帮助与支持" onAction={(action) => onAction?.(action)} onClose={onClose} open={open} position={position} />
}
