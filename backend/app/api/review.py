"""Human review — where a reader's judgement on a line is recorded.

The corpora this demo runs on have **no ground truth**. Gallica's `text.txt`
is the same OCR layer as its ALTO, so nothing on disk can say whether a
correction was right or a refusal was justified; the only source of truth is
a person reading the scan. This module is where that reading is kept.

**Why it is worth keeping rather than just displaying.** A reviewer who can
only look produces an impression. A reviewer who can adjudicate produces the
dataset that is missing: `(line, what the OCR read, what the model proposed,
what a human says the scan actually shows)`. That is exactly the input a
bench needs to answer "was the correction right", which no amount of
measurement inside the engine can answer on its own.

**Three verdicts, and the third is the useful one.** `accepted` and
`refused` grade what the engine did. `transcribed` carries what the reviewer
read on the image, which stands on its own whatever the engine decided — and
accumulates into ground truth line by line.

Reviews are keyed by ``(page_id, line_id)`` because a line id repeats across
files (`ADR-001`); keying on the bare id would silently merge two documents'
judgements the first time a job carries more than one ALTO.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.api.deps import get_job_store
from app.api.jobs import require_job_access
from app.protocols import JobStore
from app.schemas import JobManifest

router = APIRouter(prefix="/api/jobs", tags=["review"])


class ReviewVerdict(StrEnum):
    """What the reader concluded about the engine's decision on this line."""

    #: The engine's outcome is right — whether it corrected or refused.
    ACCEPTED = "accepted"
    #: The engine's outcome is wrong. `note` should say how.
    REFUSED = "refused"
    #: Neither: the reader is recording what the scan actually shows.
    TRANSCRIBED = "transcribed"


class LineReview(BaseModel):
    """One reader's judgement on one line."""

    page_id: str = Field(min_length=1, max_length=256)
    line_id: str = Field(min_length=1, max_length=256)
    verdict: ReviewVerdict
    #: What the reader read on the image. Required for ``transcribed``; free
    #: to accompany the other two when the reader wants to be precise about
    #: what the engine got wrong.
    transcription: str | None = Field(default=None, max_length=4000)
    note: str | None = Field(default=None, max_length=2000)
    reviewed_at: str | None = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.page_id, self.line_id)


class ReviewBatch(BaseModel):
    """Reviews arrive in batches: a reader works through a page, not a line."""

    reviews: list[LineReview] = Field(max_length=2000)


class ReviewsResponse(BaseModel):
    job_id: str
    reviews: list[LineReview]


def _key(review: LineReview) -> str:
    """``(page_id, line_id)`` flattened for storage, NUL-separated.

    A NUL cannot occur in an XML id, so the pair round-trips unambiguously; a
    space could, and would merge two lines the day a producer emits one.
    """
    return f"{review.page_id}\x00{review.line_id}"


def _existing(job: JobManifest) -> dict[str, LineReview]:
    """Reviews already on the job, back as models.

    The manifest stores plain dicts so the schema layer never imports the API
    layer's models; re-validating here is what keeps that separation from
    costing type safety at the edge.
    """
    return {key: LineReview.model_validate(raw) for key, raw in (job.reviews or {}).items()}


@router.put("/{job_id}/reviews", response_model=ReviewsResponse)
async def put_reviews(
    job_id: str,
    batch: ReviewBatch,
    job: JobManifest = Depends(require_job_access),
    store: JobStore = Depends(get_job_store),
) -> ReviewsResponse:
    """Record or replace judgements on lines of this job.

    Idempotent per line: sending the same line twice replaces its review
    rather than appending, so a reader who changes their mind is not fighting
    an append-only log. The timestamp is stamped here rather than trusted
    from the client — a review's date is a fact about the server.
    """
    for review in batch.reviews:
        if review.verdict is ReviewVerdict.TRANSCRIBED and not review.transcription:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"line {review.line_id!r}: a 'transcribed' review must carry the "
                "text the reader read on the image — that text IS the review.",
            )

    merged = _existing(job)
    stamped = datetime.now(UTC).isoformat(timespec="seconds")
    for review in batch.reviews:
        merged[f"{_key(review)}"] = review.model_copy(update={"reviewed_at": stamped})
    store.update_job(job_id, reviews={k: v.model_dump() for k, v in merged.items()})
    return ReviewsResponse(
        job_id=job_id, reviews=sorted(merged.values(), key=lambda r: (r.page_id, r.line_id))
    )


@router.get("/{job_id}/reviews", response_model=ReviewsResponse)
async def get_reviews(
    job_id: str,
    job: JobManifest = Depends(require_job_access),
) -> ReviewsResponse:
    return ReviewsResponse(
        job_id=job_id,
        reviews=sorted(_existing(job).values(), key=lambda r: (r.page_id, r.line_id)),
    )


__all__ = ["LineReview", "ReviewBatch", "ReviewVerdict", "router"]
