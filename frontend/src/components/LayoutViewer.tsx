import { useCallback, useRef, useState } from 'react'
import type { LayoutData, LayoutPage } from '../types'

// ---------------------------------------------------------------------------
// SVG colour constants (inline — Tailwind classes don't apply to SVG attrs)
// ---------------------------------------------------------------------------

const C = {
  pageBg: '#ffffff',
  blockBorder: '#475569', // slate-600
  textUnchanged: '#94a3b8', // slate-400
  textChanged: '#d97706', // amber-600 (readable on white)
  rectChanged: 'rgba(253,230,138,0.25)',
  hyphenBar: '#f59e0b', // amber-500
} as const

// ---------------------------------------------------------------------------
// Verdict palette — what the engine decided, and why
// ---------------------------------------------------------------------------
//
// Three families, because a reviewer scans for three different things and
// should not have to read a legend to tell them apart:
//
//   kept      the correction survived every guard
//   refused   something was proposed and a guard declined it — the cases
//             worth a human eye, since each is either a caught hallucination
//             or a good correction thrown away
//   silent    nothing was proposed, or nothing changed; no judgement to make
//
// Colours are the proof-reader's two pencils: blue marks what stands, red
// marks what was struck out. Amber sits between them for a line the engine
// never got an answer for.

export type VerdictFamily = 'kept' | 'refused' | 'silent'

const REFUSAL_CODES = new Set([
  'too_different_from_source',
  'closer_to_previous_line',
  'closer_to_next_line',
  'absorbs_previous_line',
  'absorbs_next_line',
  'hyphen_pair_fallback',
  'boundary_migration_forward',
  'boundary_migration_backward',
  'adjacent_duplicate_detected',
  'adjacent_duplicate_pair_atomicity',
  'orphan_hyphen_completed',
  'hyphen_unit_fallback',
])

export function verdictFamily(line: {
  verdict: string | null
  modified: boolean
}): VerdictFamily {
  if (line.verdict && REFUSAL_CODES.has(line.verdict)) return 'refused'
  if (line.verdict === 'all_attempts_exhausted') return 'silent'
  return line.modified ? 'kept' : 'silent'
}

const FAMILY = {
  kept: { stroke: '#1d4ed8', fill: 'rgba(29,78,216,0.18)', label: 'Retenue' },
  refused: { stroke: '#b91c1c', fill: 'rgba(185,28,28,0.20)', label: 'Refusée' },
  silent: { stroke: '#a1a1aa', fill: 'rgba(161,161,170,0.10)', label: 'Sans objet' },
} as const

// ---------------------------------------------------------------------------
// SVGOverlay — the annotation layer (blocks + lines + text)
// Rendered either on a white background (no image) or as a transparent
// overlay on top of a scan image.
// ---------------------------------------------------------------------------

interface SVGOverlayProps {
  page: LayoutPage
  side: 'ocr' | 'corrected'
  /** 0 = invisible, 1 = fully opaque. Applied to the whole SVG group. */
  opacity: number
  /** When true, a white page rect is drawn first (standalone mode). */
  withBackground: boolean
  /**
   * Verdict families to keep at full strength. The others are DIMMED, not
   * hidden: a line that copied its neighbour only reads as wrong next to
   * that neighbour, so removing the context removes the evidence.
   */
  active: ReadonlySet<VerdictFamily>
  selectedId: string | null
  onSelect: (lineId: string) => void
}

function SVGOverlay({
  page,
  side,
  opacity,
  withBackground,
  active,
  selectedId,
  onSelect,
}: SVGOverlayProps) {
  const { blocks } = page
  const W = page.page_width || blocks.reduce((m, b) => Math.max(m, b.hpos + b.width), 0)
  const H = page.page_height || blocks.reduce((m, b) => Math.max(m, b.vpos + b.height), 0)

  if (!W || !H) {
    return (
      <div className="p-6 font-mono text-xs text-slate-500 text-center">
        Coordonnées de ligne absentes — impossible d'afficher la mise en page.
      </div>
    )
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      preserveAspectRatio="xMinYMin meet"
      style={{ display: 'block', position: 'relative', zIndex: 1 }}
    >
      {withBackground && <rect x={0} y={0} width={W} height={H} fill={C.pageBg} />}

      <g opacity={opacity}>
        {blocks.map((block) => (
          <g key={block.block_id}>
            <rect
              x={block.hpos}
              y={block.vpos}
              width={block.width}
              height={block.height}
              fill="none"
              stroke={C.blockBorder}
              strokeWidth={6}
              opacity={withBackground ? 1 : 0.6}
            />

            {block.lines.map((line) => {
              const displayText = side === 'ocr' ? line.ocr_text : line.corrected_text
              const hasHyphen = line.hyphen_role !== 'none'
              const family = verdictFamily(line)
              const isSelected = selectedId === line.line_id
              // Dimmed, not removed — see the `active` prop.
              const dim = active.has(family) ? 1 : 0.16

              if (withBackground) {
                // SVG-only mode: coloured text on white page
                const fontSize = Math.max(line.height * 0.7, 1)
                const textY = line.vpos + line.height * 0.75
                return (
                  <g
                    key={line.line_id}
                    opacity={dim}
                    onClick={() => onSelect(line.line_id)}
                    style={{ cursor: 'pointer' }}
                  >
                    {line.modified && (
                      <rect
                        x={line.hpos}
                        y={line.vpos}
                        width={line.width}
                        height={line.height}
                        fill={C.rectChanged}
                      />
                    )}
                    {hasHyphen && (
                      <rect
                        x={line.hpos}
                        y={line.vpos}
                        width={8}
                        height={line.height}
                        fill={C.hyphenBar}
                      />
                    )}
                    <text
                      x={line.hpos + 4}
                      y={textY}
                      fontSize={fontSize}
                      fill={line.modified ? C.textChanged : C.textUnchanged}
                      textLength={line.width - 8 > 0 ? line.width - 8 : undefined}
                      lengthAdjust="spacingAndGlyphs"
                      style={{ fontFamily: 'serif' }}
                    >
                      {displayText}
                    </text>
                  </g>
                )
              } else {
                // Image overlay mode: semi-opaque bg behind text for readability
                const fontSize = Math.max(line.height * 0.72, 1)
                const textY = line.vpos + line.height * 0.78
                return (
                  <g
                    key={line.line_id}
                    opacity={dim}
                    onClick={() => onSelect(line.line_id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <rect
                      x={line.hpos}
                      y={line.vpos}
                      width={line.width}
                      height={line.height}
                      fill={FAMILY[family].fill}
                      stroke={FAMILY[family].stroke}
                      strokeWidth={isSelected ? 6 : 2}
                    />
                    {hasHyphen && (
                      <rect
                        x={line.hpos}
                        y={line.vpos}
                        width={8}
                        height={line.height}
                        fill={C.hyphenBar}
                        opacity={0.9}
                      />
                    )}
                    <text
                      x={line.hpos + 4}
                      y={textY}
                      fontSize={fontSize}
                      fill="#0f172a"
                      textLength={line.width - 8 > 0 ? line.width - 8 : undefined}
                      lengthAdjust="spacingAndGlyphs"
                      style={{ fontFamily: 'serif' }}
                    >
                      {displayText}
                    </text>
                  </g>
                )
              }
            })}
          </g>
        ))}
      </g>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// PagePanel — one side (ocr | corrected): image background + SVG overlay
// ---------------------------------------------------------------------------

interface PagePanelProps {
  page: LayoutPage
  side: 'ocr' | 'corrected'
  overlayOpacity: number
  active: ReadonlySet<VerdictFamily>
  selectedId: string | null
  onSelect: (lineId: string) => void
}

function PagePanel({
  page,
  side,
  overlayOpacity,
  active,
  selectedId,
  onSelect,
}: PagePanelProps) {
  const { blocks } = page
  const W = page.page_width || blocks.reduce((m, b) => Math.max(m, b.hpos + b.width), 0)
  const H = page.page_height || blocks.reduce((m, b) => Math.max(m, b.vpos + b.height), 0)

  if (page.image_url) {
    // The SVG is the in-flow element that establishes the container height
    // via its viewBox aspect ratio. The image sits behind it (position: absolute).
    // This avoids the CSS issue where `height: 100%` on an absolutely-positioned
    // child of a height:auto container resolves to `auto`, not the parent's height.
    return (
      <div style={{ position: 'relative' }}>
        {W && H && (
          <img
            src={page.image_url}
            alt="source scan"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'fill',
            }}
          />
        )}
        <SVGOverlay
          page={page}
          side={side}
          opacity={overlayOpacity}
          withBackground={!W || !H}
          active={active}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      </div>
    )
  }

  // No image: SVG on white background — opacity still controlled by slider
  return (
    <SVGOverlay
      page={page}
      side={side}
      opacity={overlayOpacity}
      withBackground={true}
      active={active}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  )
}

// ---------------------------------------------------------------------------
// LayoutViewer
// ---------------------------------------------------------------------------

interface LayoutViewerProps {
  data: LayoutData
}

export function LayoutViewer({ data }: LayoutViewerProps) {
  const [pageIdx, setPageIdx] = useState(0)
  const [overlayOpacity, setOverlayOpacity] = useState(0.85)
  // All three families on by default: a reviewer opening the page should see
  // what the run did before deciding what to hunt for.
  const [active, setActive] = useState<ReadonlySet<VerdictFamily>>(
    new Set<VerdictFamily>(['kept', 'refused', 'silent'])
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const toggleFamily = useCallback((family: VerdictFamily) => {
    setActive((current) => {
      const next = new Set(current)
      if (next.has(family)) next.delete(family)
      else next.add(family)
      // Turning the last one off would blank the page and read as a bug.
      return next.size ? next : current
    })
  }, [])
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const syncing = useRef(false)

  // All hooks (useCallback) must come BEFORE any conditional return,
  // otherwise the hook count varies between renders. See PR 2 / B-002.
  const onScrollLeft = useCallback(() => {
    if (syncing.current || !leftRef.current || !rightRef.current) return
    syncing.current = true
    rightRef.current.scrollTop = leftRef.current.scrollTop
    syncing.current = false
  }, [])

  const onScrollRight = useCallback(() => {
    if (syncing.current || !leftRef.current || !rightRef.current) return
    syncing.current = true
    leftRef.current.scrollTop = rightRef.current.scrollTop
    syncing.current = false
  }, [])

  // Guard against empty result sets — without this, currentPage.image_url crashes.
  if (data.pages.length === 0) {
    return (
      <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-6 text-center">
        <p className="font-mono text-xs text-slate-500">Aucune mise en page à afficher.</p>
      </div>
    )
  }

  const currentPage = data.pages[pageIdx] ?? data.pages[0]
  const hasImage = !!currentPage.image_url

  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-700/60 flex items-center justify-between gap-4 flex-wrap">
        <h3 className="font-serif text-sm font-semibold text-slate-200">
          Visionneuse structurelle
        </h3>

        <div className="flex items-center gap-4 flex-wrap">
          {/* Opacity slider — always visible */}
          <label className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-slate-500 uppercase tracking-wider whitespace-nowrap">
              Texte
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(overlayOpacity * 100)}
              onChange={(e) => setOverlayOpacity(Number(e.target.value) / 100)}
              className="w-24 accent-amber-500 cursor-pointer"
            />
            <span className="font-mono text-[10px] text-amber-400 w-7 text-right">
              {Math.round(overlayOpacity * 100)}%
            </span>
          </label>

          {/* Verdict filter — dims, never hides. A line that copied its
              neighbour only reads as wrong NEXT TO that neighbour, so the
              context has to stay on the page. */}
          <div className="flex items-center gap-1.5">
            {(['kept', 'refused', 'silent'] as const).map((family) => {
              const on = active.has(family)
              return (
                <button
                  key={family}
                  type="button"
                  onClick={() => toggleFamily(family)}
                  aria-pressed={on}
                  title={`${FAMILY[family].label} — cliquer pour estomper`}
                  className="font-mono text-[10px] uppercase tracking-wider rounded px-2 py-1
                             border transition-opacity focus:outline-none focus:ring-1
                             focus:ring-amber-400"
                  style={{
                    borderColor: FAMILY[family].stroke,
                    color: on ? '#e2e8f0' : '#64748b',
                    background: on ? FAMILY[family].fill : 'transparent',
                    opacity: on ? 1 : 0.55,
                  }}
                >
                  {FAMILY[family].label}
                </button>
              )
            })}
          </div>

          {/* Page selector */}
          {data.pages.length > 1 && (
            <select
              value={pageIdx}
              onChange={(e) => setPageIdx(Number(e.target.value))}
              className="font-mono text-xs bg-slate-700 border border-slate-600 text-slate-200
                         rounded px-2 py-1 focus:outline-none focus:border-amber-500"
            >
              {data.pages.map((p, i) => (
                <option key={p.page_id} value={i}>
                  Page {i + 1} — {p.page_id}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Column labels */}
      <div className="grid grid-cols-2 border-b border-slate-700/40 bg-slate-800/60">
        <div
          className="px-3 py-1.5 font-mono text-[10px] text-slate-500 uppercase tracking-wider
                        border-r border-slate-700/40"
        >
          OCR source{hasImage ? ' (scan)' : ''}
        </div>
        <div className="px-3 py-1.5 font-mono text-[10px] text-slate-500 uppercase tracking-wider">
          Corrigé{hasImage ? ' (scan)' : ''}
        </div>
      </div>

      {/* Dual panels with synchronised scroll */}
      <div className="grid grid-cols-2 divide-x divide-slate-700/40">
        <div ref={leftRef} onScroll={onScrollLeft} className="overflow-auto max-h-[60vh]">
          <PagePanel
            page={currentPage}
            side="ocr"
            overlayOpacity={overlayOpacity}
            active={active}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
        <div ref={rightRef} onScroll={onScrollRight} className="overflow-auto max-h-[60vh]">
          <PagePanel
            page={currentPage}
            side="corrected"
            overlayOpacity={overlayOpacity}
            active={active}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      </div>

      {/* Legend */}
      <div className="px-4 py-2.5 border-t border-slate-700/40 flex items-center gap-6 flex-wrap">
        <span className="font-mono text-[10px] text-slate-600 uppercase tracking-wider mr-1">
          Légende :
        </span>
        <div className="flex items-center gap-1.5">
          <div
            className="w-4 h-3 rounded-sm border border-amber-400/40"
            style={{ background: 'rgba(253,230,138,0.25)' }}
          />
          <span className="font-mono text-[10px] text-slate-500">ligne modifiée</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-3 rounded-sm" style={{ background: '#f59e0b' }} />
          <span className="font-mono text-[10px] text-slate-500">césure</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-3 rounded-sm border border-slate-600/60" />
          <span className="font-mono text-[10px] text-slate-500">ligne inchangée</span>
        </div>
      </div>
    </div>
  )
}
