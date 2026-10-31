// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMediaResource } from './useMediaResource'
import { clearIdleMediaResources } from '../../services/mediaResource'
afterEach(() => { cleanup(); clearIdleMediaResources(); vi.unstubAllGlobals() })
it('rebinds a failed native image on explicit retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('CORS')))
  function Image() {
    const media = useMediaResource({ url: 'https://retry.test/image.png' }, 360, 'visible')
    return <><img key={media.bindingKey} alt="preview" src={media.displayUrl} onLoad={media.onLoad} onError={media.onError} />
      {media.failed && <button onClick={media.retry}>retry</button>}</>
  }
  render(<Image />)
  const original = screen.getByAltText('preview')
  await waitFor(() => expect(original.getAttribute('src')).toBe('https://retry.test/image.png'))
  fireEvent.error(original)
  fireEvent.click(await screen.findByText('retry'))
  await waitFor(() => expect(screen.getByAltText('preview')).not.toBe(original))
  fireEvent.load(screen.getByAltText('preview'))
  expect(screen.queryByText('retry')).toBeNull()
})
