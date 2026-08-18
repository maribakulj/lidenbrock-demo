/**
 * IIIF Image API region URLs — a line's own pixels, without storing a thing.
 *
 * ALTO coordinates and the IIIF region parameter live in the SAME space: a
 * service serving the full scan declares exactly the page's own dimensions
 * (measured on Gallica: `info.json` says 6802×9121 for an ALTO page of
 * 6802×9121). So the coordinates go through verbatim — no scale, no
 * transform, and no local derivative to crop.
 *
 * That matters beyond convenience. Cropping a DOWNSCALED derivative locally
 * is how a line ends up cut from the wrong place: Gallica's `!1600,1600`
 * preview is 17.5% of the ALTO space, so a line at hpos=4798 falls off an
 * image 1193 pixels wide, and the crop comes back blank with nothing
 * downstream any the wiser.
 */

export interface Region {
  hpos: number
  vpos: number
  width: number
  height: number
}

/**
 * `size` is `max`, deliberately.
 *
 * Asking for a fixed width is refused with HTTP 400 the moment it would
 * UPSCALE the region — measured against Gallica, whose lines are ~70px tall:
 * `/1200,/` returns 400, `/max/` returns 200. IIIF 3.0 requires an explicit
 * `^` prefix to allow upscaling, and a line does not need it: its native
 * pixels are exactly what a reader wants to see.
 */
export function lineRegionUrl(service: string, region: Region, marginRatio = 0.2): string {
  const marginX = Math.round(region.width * 0.01)
  const marginY = Math.round(region.height * marginRatio)
  const x = Math.max(region.hpos - marginX, 0)
  const y = Math.max(region.vpos - marginY, 0)
  const w = region.width + 2 * marginX
  const h = region.height + 2 * marginY
  return `${service.replace(/\/+$/, '')}/${x},${y},${w},${h}/max/0/default.jpg`
}

/** Whether a pasted string looks like an Image API service base, not a full image URL. */
export function looksLikeService(value: string): boolean {
  const trimmed = value.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  // A full image URL already carries region/size/rotation/quality; using it as
  // a base would produce nonsense like `.../full/max/0/default.jpg/12,3,4,5/max/...`.
  return !/\/(full|square|\d+,\d+,\d+,\d+)\/[^/]+\/\d+\/[^/]+\.\w+$/i.test(trimmed)
}
