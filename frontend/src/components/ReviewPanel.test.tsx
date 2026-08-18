import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LayoutLine, LineReview } from '../types'
import { ReviewPanel } from './ReviewPanel'

vi.mock('../api/client', () => ({
  putReviews: vi.fn(),
}))

import { putReviews } from '../api/client'

const line = (over: Partial<LayoutLine> = {}): LayoutLine => ({
  line_id: 'TL000323',
  hpos: 0,
  vpos: 0,
  width: 100,
  height: 20,
  ocr_text: '1,500 ETANTS : LE NOMBRE DES MORTS',
  corrected_text: '1,500 ETANTS : LE NOMBRE DES MORTS',
  modified: false,
  hyphen_role: 'none',
  verdict: 'absorbs_previous_line',
  verdict_detail: null,
  proposed_text: "AU COURS D'UNE MATINÉE 1,500 ÉTANTS : LE NOMBRE DES MORTS",
  proposal_declined: true,
  ...over,
})

function mount(over: Partial<LayoutLine> = {}, existing: LineReview | null = null) {
  const onSaved = vi.fn()
  render(
    <ReviewPanel
      jobId="job-1"
      pageId="PAG_1"
      line={line(over)}
      existing={existing}
      onSaved={onSaved}
      onClose={vi.fn()}
    />,
  )
  return { onSaved }
}

describe('ReviewPanel', () => {
  beforeEach(() => {
    vi.mocked(putReviews).mockReset()
  })

  it('shows what was proposed and that it was declined', () => {
    // The reviewer's most valuable case: something WAS on the table and a
    // guard refused it. Hiding the proposal would hide whether the refusal
    // saved a hallucination or threw away a good correction.
    mount()
    expect(screen.getByText(/proposé — et refusé/i)).toBeInTheDocument()
    expect(screen.getByText(/AU COURS D'UNE MATINÉE/)).toBeInTheDocument()
  })

  it('refuses an empty transcription before it reaches the server', () => {
    // The text IS the review. An empty one would land in the ground-truth set
    // asserting nothing, indistinguishable later from a real reading.
    mount()
    fireEvent.click(screen.getByRole('button', { name: /ce que je lis/i }))

    expect(screen.getByRole('alert')).toHaveTextContent(/n'affirme rien/i)
    expect(putReviews).not.toHaveBeenCalled()
  })

  it('sends the transcription the reader typed', async () => {
    vi.mocked(putReviews).mockResolvedValue([
      {
        page_id: 'PAG_1',
        line_id: 'TL000323',
        verdict: 'transcribed',
        transcription: '1,500 ENFANTS : LE NOMBRE DES MORTS',
        note: null,
        reviewed_at: '2026-08-18T10:00:00+00:00',
      },
    ])
    const { onSaved } = mount()

    fireEvent.change(screen.getByRole('textbox', { name: /ce que je lis sur le scan/i }), {
      target: { value: '1,500 ENFANTS : LE NOMBRE DES MORTS' },
    })
    fireEvent.click(screen.getByRole('button', { name: /ce que je lis/i }))

    await waitFor(() => expect(putReviews).toHaveBeenCalledTimes(1))
    const [jobId, reviews] = vi.mocked(putReviews).mock.calls[0]
    expect(jobId).toBe('job-1')
    expect(reviews[0]).toMatchObject({
      page_id: 'PAG_1',
      line_id: 'TL000323',
      verdict: 'transcribed',
      transcription: '1,500 ENFANTS : LE NOMBRE DES MORTS',
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it('grades the engine without needing a transcription', async () => {
    vi.mocked(putReviews).mockResolvedValue([
      {
        page_id: 'PAG_1',
        line_id: 'TL000323',
        verdict: 'accepted',
        transcription: null,
        note: null,
        reviewed_at: '2026-08-18T10:00:00+00:00',
      },
    ])
    mount()
    fireEvent.click(screen.getByRole('button', { name: /le moteur a eu raison/i }))
    await waitFor(() => expect(putReviews).toHaveBeenCalledTimes(1))
    expect(vi.mocked(putReviews).mock.calls[0][1][0].verdict).toBe('accepted')
  })

  it("surfaces the server's own words when it rejects a review", async () => {
    // A status code the reader cannot act on is worse than no feedback: the
    // server explains an empty transcription by name, so show that.
    vi.mocked(putReviews).mockRejectedValue(new Error('a transcribed review must carry the text'))
    mount()
    fireEvent.click(screen.getByRole('button', { name: /le moteur a eu tort/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/must carry the text/i))
  })

  it('shows an existing judgement as the pressed one', () => {
    mount(
      {},
      {
        page_id: 'PAG_1',
        line_id: 'TL000323',
        verdict: 'refused',
        transcription: null,
        note: 'le scan dit ENFANTS',
        reviewed_at: '2026-08-18T09:00:00+00:00',
      },
    )
    expect(screen.getByRole('button', { name: /le moteur a eu tort/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByDisplayValue('le scan dit ENFANTS')).toBeInTheDocument()
  })
})
