import { describe, expect, it } from 'vitest'

import {
  DEFAULT_UI_PREFERENCES,
  loadUiPreferences,
  saveUiPreferences,
  updateUiPreferences,
} from './uiPreferences'
import type { StorageLike } from './uiPreferences'

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('UI preferences persistence', () => {
  it('returns defaults when no preference has been saved', () => {
    expect(loadUiPreferences(new MemoryStorage())).toEqual(
      DEFAULT_UI_PREFERENCES,
    )
    expect(DEFAULT_UI_PREFERENCES.snapToGrid).toBe(false)
    expect(DEFAULT_UI_PREFERENCES.showMiniMap).toBe(false)
    expect(DEFAULT_UI_PREFERENCES.layersWidth).toBe(240)
  })

  it('round-trips hidden connections, snapping, panel and zoom display', () => {
    const storage = new MemoryStorage()
    const preferences = {
      hideConnections: true,
      snapToGrid: false,
      showMiniMap: false,
      lastOpenPanel: 'history',
      showZoom: false,
      layersOpen: true,
      layersWidth: 384,
      smartSnap: true,
    }

    saveUiPreferences(preferences, storage)

    expect(loadUiPreferences(storage)).toEqual(preferences)
  })

  it('normalizes the persisted layers width to the supported range', () => {
    const storage = new MemoryStorage()

    storage.values.set(
      'libtv.ui-preferences.v1',
      JSON.stringify({ layersWidth: 100 }),
    )
    expect(loadUiPreferences(storage).layersWidth).toBe(220)

    storage.values.set(
      'libtv.ui-preferences.v1',
      JSON.stringify({ layersWidth: 900 }),
    )
    expect(loadUiPreferences(storage).layersWidth).toBe(900)

    storage.values.set(
      'libtv.ui-preferences.v1',
      JSON.stringify({ layersWidth: 'wide' }),
    )
    expect(loadUiPreferences(storage).layersWidth).toBe(240)
  })

  it('persists the layers width globally with the other preferences', () => {
    const storage = new MemoryStorage()
    saveUiPreferences(
      { ...DEFAULT_UI_PREFERENCES, layersOpen: true, layersWidth: 512 },
      storage,
    )

    expect(loadUiPreferences(storage).layersWidth).toBe(512)
  })

  it('recovers defaults from malformed JSON and invalid individual fields', () => {
    const storage = new MemoryStorage()
    storage.values.set('libtv.ui-preferences.v1', '{broken-json')
    expect(loadUiPreferences(storage)).toEqual(DEFAULT_UI_PREFERENCES)

    storage.values.set(
      'libtv.ui-preferences.v1',
      JSON.stringify({
        hideConnections: true,
        snapToGrid: 'yes',
        lastOpenPanel: 42,
        showZoom: false,
      }),
    )

    expect(loadUiPreferences(storage)).toEqual({
      ...DEFAULT_UI_PREFERENCES,
      hideConnections: true,
      showZoom: false,
    })
  })

  it('merges updates onto the last valid preferences', () => {
    const storage = new MemoryStorage()
    saveUiPreferences(DEFAULT_UI_PREFERENCES, storage)

    const updated = updateUiPreferences(
      { hideConnections: true, lastOpenPanel: 'assets' },
      storage,
    )

    expect(updated).toEqual({
      ...DEFAULT_UI_PREFERENCES,
      hideConnections: true,
      lastOpenPanel: 'assets',
    })
    expect(loadUiPreferences(storage)).toEqual(updated)
  })

  it('uses defaults when browser storage cannot be read', () => {
    const inaccessibleStorage: StorageLike = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => undefined,
    }

    expect(loadUiPreferences(inaccessibleStorage)).toEqual(
      DEFAULT_UI_PREFERENCES,
    )
  })
})
