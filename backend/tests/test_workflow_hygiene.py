"""Every workflow declares its permissions and its concurrency.

These two guards travelled here from the library's repository when the
demo split off. They are not the same files as before — they scan *this*
repository's workflows — but they are the same rule, and leaving them
behind would have retired them by accident, which is how a guard usually
dies.

The failure they prevent is silent in both cases: a workflow with no
top-level ``permissions:`` inherits the repository default, which can be
``contents: write``; a workflow with no ``concurrency:`` lets two runs
race, and here the loser is the Hugging Face mirror, which gets
force-pushed twice with whichever commit finishes second winning.
"""

from __future__ import annotations

from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOWS_DIR = _REPO_ROOT / ".github" / "workflows"


def _workflow_files() -> list[Path]:
    return sorted(_WORKFLOWS_DIR.glob("*.yml")) + sorted(_WORKFLOWS_DIR.glob("*.yaml"))


def test_there_are_workflows_to_check():
    """A scan that finds nothing must not pass by finding nothing.

    Both tests below are parametrised over a glob. An empty glob makes
    them vacuously green — the exact shape of a guard that stopped
    guarding when the files moved.
    """
    assert _workflow_files(), f"no workflow found under {_WORKFLOWS_DIR}"


@pytest.mark.parametrize("path", _workflow_files(), ids=lambda p: p.name)
def test_workflow_declares_explicit_permissions_block(path: Path):
    yaml = pytest.importorskip("yaml")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict) and data.get("permissions"), (
        f"{path.name} is missing a top-level `permissions:` block. "
        f"Add at minimum `permissions: {{ contents: read }}`."
    )


@pytest.mark.parametrize("path", _workflow_files(), ids=lambda p: p.name)
def test_workflow_declares_concurrency_block(path: Path):
    yaml = pytest.importorskip("yaml")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict) and data.get("concurrency"), (
        f"{path.name} is missing a top-level `concurrency:` block. "
        f"Add at minimum `concurrency: {{ group: <workflow>-${{{{ github.ref }}}}, "
        f"cancel-in-progress: <true|false> }}`."
    )
