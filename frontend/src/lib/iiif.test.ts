import { describe, expect, it } from 'vitest'

import { lineRegionUrl, looksLikeService } from './iiif'

describe('lineRegionUrl', () => {
  it('passes ALTO coordinates through as the IIIF region', () => {
    // The two spaces are the same one — a service serving the full scan
    // declares the page's own dimensions — so no scaling belongs here.
    const url = lineRegionUrl(
      'https://example.org/iiif/f1',
      {
        hpos: 1000,
        vpos: 2000,
        width: 500,
        height: 100,
      },
      0,
    )
    expect(url).toBe('https://example.org/iiif/f1/995,2000,510,100/max/0/default.jpg')
  })

  it('asks for max rather than a fixed width', () => {
    // Measured against Gallica: a fixed width 400s the moment it would
    // upscale, and lines are ~70px tall so it almost always would.
    const url = lineRegionUrl('https://example.org/iiif/f1', {
      hpos: 0,
      vpos: 0,
      width: 100,
      height: 20,
    })
    expect(url).toContain('/max/0/default.jpg')
    expect(url).not.toMatch(/\/\d+,\/0\//)
  })

  it('tolerates a trailing slash on the service', () => {
    const url = lineRegionUrl(
      'https://example.org/iiif/f1/',
      {
        hpos: 0,
        vpos: 0,
        width: 10,
        height: 10,
      },
      0,
    )
    expect(url).not.toContain('f1//')
  })
})

describe('looksLikeService', () => {
  it('accepts a service base', () => {
    expect(looksLikeService('https://openapi.bnf.fr/iiif/image/v3/ark:/12148/x/f1')).toBe(true)
  })

  it('rejects a full image URL, which would nest two region paths', () => {
    expect(
      looksLikeService(
        'https://openapi.bnf.fr/iiif/image/v3/ark:/12148/x/f1/full/max/0/default.jpg',
      ),
    ).toBe(false)
  })

  it('rejects anything that is not a URL', () => {
    expect(looksLikeService('bpt6k4607951t')).toBe(false)
  })
})
