"""Run a corpus through the demo's own JobRunner, one arm at a time.

    python tools/run_corpus_arms.py <corpus-root> <arm> [concurrency]

Arms:

    small-text        mistral-small-latest, no image
    small-vision      mistral-small-latest, per-line crops
    ministral-text    ministral-8b-latest, no image
    ministral-vision  ministral-8b-latest, per-line crops

`<corpus-root>` is scanned for ``alto.xml`` files, each with an optional
``image.jpg`` beside it — the layout a digital library's page-by-page export
produces, and the shape ``gallica_multicolumn`` writes.

This drives ``JobRunner`` rather than the HTTP API: same producer assembly,
same guards, same output writer, no server to stand up. The key is read from
the macOS keychain and never appears in a flag, an environment dump, or an
artefact — a flag would land in shell history and in the process list.

One JSON per page under ``<corpus-root>/../arm-results/<arm>/``, so an
interrupted run resumes and nothing measured is lost.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from saknussemm.formats.loader import build_document_manifest

from app.jobs.runner import JobRunner, page_image_assets
from app.jobs.store import JobStore
from app.providers.mistral_multimodal import MistralMultimodalProvider
from app.providers.mistral_provider import MistralProvider
from app.storage.output_writer import FilesystemOutputWriter

ARMS: dict[str, tuple[str, bool]] = {
    "small-text": ("mistral-small-latest", False),
    "small-vision": ("mistral-small-latest", True),
    "ministral-text": ("ministral-8b-latest", False),
    "ministral-vision": ("ministral-8b-latest", True),
}


def keychain_key() -> str:
    return subprocess.run(
        ["security", "find-generic-password", "-a", "marcel", "-s", "mistral-api-key", "-w"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def find_pages(root: Path) -> list[tuple[str, Path, Path | None]]:
    """``(label, alto path, image path or None)`` for every page under *root*."""
    pages = []
    for alto in sorted(root.rglob("alto.xml")):
        label = f"{alto.parent.parent.name}_{alto.parent.name.split('_')[-1]}"
        image = alto.parent / "image.jpg"
        pages.append((label, alto, image if image.exists() else None))
    return pages


async def run_one(
    arm: str,
    label: str,
    alto: Path,
    image: Path | None,
    api_key: str,
    results: Path,
    sem: asyncio.Semaphore,
) -> dict | None:
    target = results / f"{label}.json"
    if target.exists():
        return json.loads(target.read_text())

    model, wants_image = ARMS[arm]
    if wants_image and image is None:
        return None

    async with sem:
        from app.schemas import Provider

        store = JobStore()
        job_id = store.create_job(provider=Provider.MISTRAL, model=model)
        manifest = build_document_manifest([(alto, alto.name)])

        images = None
        if wants_image:
            images = page_image_assets(manifest, {alto.parent.name.lower(): image})
            if not images:
                # The demo keys images by source-file stem; this corpus names
                # every file `alto.xml`, so map it explicitly by page instead of
                # letting the helper's stem lookup miss silently.
                import hashlib

                from saknussemm.core.schemas import ImageAsset

                digest = hashlib.sha256(image.read_bytes()).hexdigest()
                images = {
                    page.page_id: ImageAsset(
                        page_id=page.page_id,
                        uri=str(image),
                        sha256=digest,
                        media_type="image/jpeg",
                    )
                    for page in manifest.pages
                }

        out_dir = results / "outputs" / label
        out_dir.mkdir(parents=True, exist_ok=True)
        writer = FilesystemOutputWriter(out_dir)
        runner = JobRunner(store)

        started = time.perf_counter()
        await runner.run(
            job_id=job_id,
            document_manifest=manifest,
            provider_name="mistral",
            api_key=api_key,
            model=model,
            output_writer=writer,
            source_files={alto.name: alto},
            provider=(MistralMultimodalProvider() if wants_image else MistralProvider()),
            page_images=images,
            timeout_seconds=0,
        )
        elapsed = time.perf_counter() - started

        job = store.get_job(job_id)
        report = job.report if job else None
        record: dict = {
            "arm": arm,
            "page": label,
            "model": model,
            "wants_image": wants_image,
            "seconds": round(elapsed, 1),
            "status": job.status.value if job else "unknown",
            "error": job.error if job else None,
            "lines": job.total_lines if job else 0,
            "fallbacks": job.fallbacks if job else 0,
            "retries": job.retries if job else 0,
        }
        if report is not None:
            reasons = Counter(
                line.decision.reason.code
                for line in report.lines
                if line.decision.reason is not None
            )
            usage = report.usage
            record.update(
                input_tokens=getattr(usage, "input_tokens", 0) if usage else 0,
                output_tokens=getattr(usage, "output_tokens", 0) if usage else 0,
                reasons=dict(reasons),
                statuses=dict(Counter(ln.decision.status for ln in report.lines)),
                changed=sum(1 for ln in report.lines if ln.decision.final_text != ln.source_text),
                blocked=sum(
                    1
                    for ln in report.lines
                    if ln.decision.reason is not None
                    and ln.proposal is not None
                    and ln.proposal.output_text != ln.source_text
                ),
                format_losses=dict(report.format_losses or {}),
                samples=[
                    {"src": ln.source_text, "out": ln.decision.final_text}
                    for ln in report.lines
                    if ln.decision.final_text != ln.source_text
                ][:5],
                refused=[
                    {
                        "reason": ln.decision.reason.code,
                        "src": ln.source_text,
                        "llm": ln.proposal.output_text,
                    }
                    for ln in report.lines
                    if ln.decision.reason is not None
                    and ln.proposal is not None
                    and ln.proposal.output_text != ln.source_text
                ][:5],
            )

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(record, ensure_ascii=False, indent=1))
    print(
        f"[{arm}] {label:26s} {record['status']:10s} {record.get('lines', 0):5d}L "
        f"{elapsed:6.1f}s {record.get('input_tokens', 0):8d}in/"
        f"{record.get('output_tokens', 0):7d}out",
        flush=True,
    )
    return record


async def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    root = Path(sys.argv[1]).resolve()
    arm = sys.argv[2]
    concurrency = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    if arm not in ARMS:
        raise SystemExit(f"unknown arm {arm!r}; pick from {list(ARMS)}")

    results = root.parent / "arm-results" / arm
    results.mkdir(parents=True, exist_ok=True)
    pages = find_pages(root)
    print(f"arm {arm} — {len(pages)} pages, concurrency {concurrency}", flush=True)

    api_key = keychain_key()
    sem = asyncio.Semaphore(concurrency)
    records = await asyncio.gather(
        *(run_one(arm, label, alto, image, api_key, results, sem) for label, alto, image in pages),
        return_exceptions=True,
    )

    good = [r for r in records if isinstance(r, dict)]
    failed = [r for r in records if isinstance(r, BaseException)]
    totals: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    for record in good:
        for field in (
            "lines",
            "input_tokens",
            "output_tokens",
            "changed",
            "blocked",
            "fallbacks",
            "retries",
        ):
            totals[field] += record.get(field, 0)
        reasons.update(record.get("reasons", {}))
    print(f"\n=== {arm} ===")
    print(f"pages ok {len(good)}, raised {len(failed)}")
    print(f"totals {dict(totals)}")
    print(f"reasons {dict(reasons)}")
    for exc in failed[:3]:
        print(f"  raised: {type(exc).__name__}: {exc}")
    (results.parent / f"{arm}-summary.json").write_text(
        json.dumps(
            {
                "arm": arm,
                "pages": len(good),
                "raised": len(failed),
                "totals": dict(totals),
                "reasons": dict(reasons),
            },
            ensure_ascii=False,
            indent=1,
        )
    )


asyncio.run(main())
