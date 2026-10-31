import type { ComponentProps } from 'react'
import type { NodeGeneratorPanel } from './NodeGeneratorPanel'
import type { ImageEditorWorkspace } from './ImageEditorModal'
import { createDeferredPanel } from './deferredPanel'
const generator = createDeferredPanel<ComponentProps<typeof NodeGeneratorPanel>>('生成工具', () => import('./NodeGeneratorPanel').then(module => ({ default: module.NodeGeneratorPanel })))
const editor = createDeferredPanel<ComponentProps<typeof ImageEditorWorkspace>>('图片编辑器', () => import('./ImageEditorModal').then(module => ({ default: module.ImageEditorWorkspace })))
export const LazyNodeGeneratorPanel = generator.Component
export const LazyImageEditorWorkspace = editor.Component
export const preloadNodeGeneratorPanel = generator.preload
export const preloadImageEditorWorkspace = editor.preload
