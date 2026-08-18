"""Mistral multimodal provider — the half of the library the demo could not run.

``saknussemm`` ships a complete vision chain: ``VisionEditProducer`` crops each
line from the page scan, ``VISION_SYSTEM_PROMPT`` tells the model the image is
authoritative, ``GuardConfig.vision()`` loosens the similarity guard because a
correct reading of a garbled line necessarily diverges from the OCR text, and
``core/batching.py`` splits a chunk to respect ``ModelCapabilities.max_images``.

None of it could run from here. Every bundled provider implements
``complete_structured`` only, so the backend accepted page images, stored them,
served them to the UI — and never sent one to a model.

**This is not a regression.** ``complete_structured_multimodal`` has never
appeared in this repository's history. The capability lived for 23 days as a CLI
tool at the root of the *library* repo (``scripts/run_vision.py`` +
``scripts/providers_multimodal.py``, 2026-07-24 to 2026-08-16), a sibling of the
demo rather than a part of it, and left with the bench archive — swept along by a
defect proven in its *neighbour*: ``vision_benchmark.py`` built its manifest from
the reference ALTO and then overwrote the text with the OCR's, a state no real
run reaches. The client itself carries no such defect. Nothing re-homed the
capability in a consumer. This does.

**Credit where it is due.** Two facts below come from that archived client
(``cinoc/campaigns/tooling/providers_multimodal.py``), which measured them
against the live API rather than reading them off a doc page. Both are
load-bearing and both were rediscovered the hard way before the archive was
read:

* **A ninth image is refused**, HTTP 400 ``"Total number of images exceeds the
  maximum allowed of 8."`` (code 3051). So :data:`MAX_IMAGES_PER_CALL` is 8 and
  is declared through ``ModelCapabilities.max_images``, which is what makes the
  engine split a chunk instead of issuing a request that cannot succeed.
* **The whole-page scan is the wrong image.** Attaching one page to a chunk and
  asking for OCR corrections makes the model *describe* the photograph: a
  caption came back rewritten from `PHOTOGRAPHIE DE L'ÉBOULEMENT D'UNE FALAISE A
  BOULOGNE-SUR-MER` to `DEUX ASPECTS DE LA FALAISE ÉBOULÉE, MONTRANT LE
  GLISSEMENT DES TERRES`. Per-line crops are not an optimisation; they are what
  makes the task legible to the model.

The transport is this backend's ``base.call_llm`` rather than the archived
client's own httpx block, and that is an upgrade rather than a shortcut: it
strips a rejected sampling parameter by reading the vendor's own message,
instead of consulting a hardcoded list of models that refuse ``temperature``,
and the archived list had already gone stale once.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from app.providers.base import call_llm, extract_chat_text, extract_usage, get_json
from app.schemas import ModelInfo, Usage

_BASE = "https://api.mistral.ai"


class MistralMultimodalProvider:
    """A ``MultimodalStructuredClient`` for Mistral's chat-completions API.

    Deliberately a sibling of :class:`~app.providers.mistral_provider.MistralProvider`
    rather than a widening of it: the library keeps the text seam image-free on
    purpose, and mixing the two would make every text provider carry a vision
    signature it cannot honour.
    """

    #: Measured, not documented: a ninth image is refused with 400/3051.
    #: Declared to the engine through ``ModelCapabilities.max_images`` so the
    #: chunk is split upstream of the request.
    MAX_IMAGES_PER_CALL = 8

    def _headers(self, api_key: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    async def list_models(self, api_key: str) -> list[ModelInfo]:
        """Only the models whose live capabilities include vision.

        A text-only id here would 400 on the first image, and the catalogue
        moves — so the filter reads the account's own answer instead of a
        hardcoded list.
        """
        data = await get_json(url=f"{_BASE}/v1/models", headers=self._headers(api_key))
        models = []
        for entry in data.get("data", []):
            caps = entry.get("capabilities", {})
            if not caps.get("completion_chat", False) or not caps.get("vision", False):
                continue
            model_id = entry.get("id", "")
            models.append(ModelInfo(id=model_id, label=entry.get("name") or model_id))
        models.sort(key=lambda m: m.id)
        return models

    def _content_blocks(
        self, user_payload: dict[str, Any], images: list[Any]
    ) -> list[dict[str, Any]]:
        """Each crop announced with the line it depicts, then the JSON payload.

        The reply is keyed by ``line_id`` and the model has no other way to
        pair a picture with a line, so the label is part of the contract rather
        than decoration.
        """
        blocks: list[dict[str, Any]] = []
        for part in images:
            blocks.append({"type": "text", "text": f"Image de la ligne {part.line_id} :"})
            blocks.append(
                {
                    "type": "image_url",
                    "image_url": (
                        f"data:{part.media_type};base64,"
                        f"{base64.standard_b64encode(part.data).decode('ascii')}"
                    ),
                }
            )
        blocks.append({"type": "text", "text": json.dumps(user_payload, ensure_ascii=False)})
        return blocks

    async def complete_structured_multimodal(
        self,
        *,
        api_key: str,
        model: str,
        system_prompt: str,
        user_payload: dict[str, Any],
        images: list[Any],
        json_schema: dict[str, Any],
        temperature: float = 0.0,
    ) -> tuple[dict[str, Any], Usage | None]:
        if len(images) > self.MAX_IMAGES_PER_CALL:
            # Reaching this means the engine was not told the limit: the
            # capability descriptor is what splits the chunk, and a request
            # issued anyway would 400 after the crops were already encoded.
            raise ValueError(
                f"{len(images)} crops in one call but Mistral accepts at most "
                f"{self.MAX_IMAGES_PER_CALL}. Declare "
                f"ModelCapabilities(max_images={self.MAX_IMAGES_PER_CALL}) on the "
                "producer so the engine splits the chunk upstream."
            )

        body: dict[str, Any] = {
            "model": model,
            "temperature": temperature,
            "messages": [
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": self._content_blocks(user_payload, images),
                },
            ],
            "response_format": {"type": "json_schema", "json_schema": json_schema},
        }
        # Same two-step the text provider relies on: some models reject the
        # strict schema form and accept plain json_object.
        fallback_body = {**body, "response_format": {"type": "json_object"}}

        data = await call_llm(
            url=f"{_BASE}/v1/chat/completions",
            headers=self._headers(api_key),
            body=body,
            fallback_body=fallback_body,
        )
        return extract_chat_text(data, "Mistral (vision)"), extract_usage(data)
