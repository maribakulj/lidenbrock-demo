"""Every relative link in this repository's markdown points at something.

A link is the one part of documentation that can be checked mechanically,
and it is also the part that rots first — silently, because nobody clicks
every link in a file they are only editing one paragraph of.

This repository proved it the day it was created. Splitting the demo out
of the library left five references behind, one of them a real markdown
link in `docs/API.md` pointing at `../packages/saknussemm/docs/` — a path
that had never existed here. It rendered as a link, it read as a promise,
and it went nowhere.

Absolute links (``http``, ``https``, ``mailto``) are out of scope: checking
them needs the network, and a test that needs the network is a test that
fails for reasons that are nobody's fault. In-page anchors (``#section``)
are out of scope too — resolving them means parsing headings, and the
failure mode is milder.
"""

from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]

#: ``[label](target)``. The target stops at whitespace so a link carrying a
#: title — ``[x](path "title")`` — yields the path alone.
_MD_LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)")

_SKIP_PREFIXES = ("http://", "https://", "mailto:", "#", "data:")

#: Directories whose markdown is not ours to police.
_IGNORED_DIRS = {"node_modules", ".git", "dist", "build", ".venv"}


def _markdown_files() -> list[Path]:
    return sorted(
        p
        for p in _REPO_ROOT.rglob("*.md")
        if not _IGNORED_DIRS & set(p.relative_to(_REPO_ROOT).parts)
    )


def test_there_is_markdown_to_check() -> None:
    """A scan that finds nothing must not pass by finding nothing."""
    assert len(_markdown_files()) >= 3, (
        f"only {len(_markdown_files())} markdown files found under "
        f"{_REPO_ROOT} — the scan is probably looking in the wrong place"
    )


def test_every_relative_markdown_link_resolves() -> None:
    broken: list[str] = []
    for md in _markdown_files():
        for target in _MD_LINK.findall(md.read_text(encoding="utf-8")):
            if target.startswith(_SKIP_PREFIXES):
                continue
            # A link may carry its own anchor: docs/API.md#jobs
            path_part = target.split("#", 1)[0]
            if not path_part:
                continue
            resolved = (md.parent / path_part).resolve()
            if not resolved.exists():
                broken.append(f"{md.relative_to(_REPO_ROOT)} -> {target}")
    assert not broken, (
        "markdown link(s) pointing at nothing: "
        + "; ".join(broken)
        + ". A relative link that leaves this repository is not a link, it "
        "is a claim — use the full URL of the repository that owns the file."
    )
