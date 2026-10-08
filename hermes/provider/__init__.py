"""Hermes MemoryProvider adapter for shared-memory-runtime v2.

The JavaScript runtime remains the sole implementation of store discovery,
index traversal, ranking, and health checks. This adapter only maps Hermes's
lifecycle onto that core.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

try:
    from agent.memory_provider import RecallStatus
except ImportError:  # Older Hermes releases simply omit the visible recall indicator.
    RecallStatus = None  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

_RUNTIME_CONFIG = Path(__file__).with_name("runtime.json")
_RECALL_POINTER = re.compile(r"^- \[(?:global|project)\] ", re.MULTILINE)


class SharedMemoryProvider(MemoryProvider):
    """Expose the shared global/project file stores to Hermes Agent."""

    def __init__(self) -> None:
        self._cwd = os.getcwd()
        self._session_id = ""
        self._last_recall_count = 0
        self._runtime_error = ""
        self._node = ""
        self._bridge = ""
        self._load_runtime_config()

    @property
    def name(self) -> str:
        return "shared-memory"

    def _load_runtime_config(self) -> None:
        try:
            config = json.loads(_RUNTIME_CONFIG.read_text(encoding="utf-8"))
            self._node = str(config.get("node") or "")
            self._bridge = str(config.get("bridge") or "")
        except Exception as exc:
            self._runtime_error = f"cannot read {_RUNTIME_CONFIG}: {exc}"
            return
        if not self._node or not Path(self._node).is_file():
            self._runtime_error = f"configured Node executable is missing: {self._node or '(empty)'}"
        elif not self._bridge or not Path(self._bridge).is_file():
            self._runtime_error = f"configured shared-memory bridge is missing: {self._bridge or '(empty)'}"

    def is_available(self) -> bool:
        return not self._runtime_error

    def unavailable_reason(self) -> str:
        return self._runtime_error or "shared-memory runtime is unavailable"

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_id = session_id
        self._cwd = str(kwargs.get("cwd") or os.getcwd())

    def _context(self, action: str, prompt: str = "") -> str:
        if self._runtime_error:
            return ""
        request = {"action": action, "cwd": self._cwd}
        if action == "prompt":
            request["prompt"] = prompt
        try:
            completed = subprocess.run(
                [self._node, self._bridge],
                input=json.dumps(request),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=8,
                check=False,
            )
            payload = json.loads(completed.stdout or "{}")
            if completed.returncode != 0 or not payload.get("ok"):
                detail = payload.get("error") or completed.stderr.strip() or f"exit {completed.returncode}"
                raise RuntimeError(detail)
            return str(payload.get("context") or "")
        except Exception as exc:
            logger.warning("shared-memory %s context failed: %s", action, exc)
            return ""

    def system_prompt_block(self) -> str:
        # Hermes rebuilds its cached system prompt at an admitted compression
        # boundary, so this naturally reloads the current root indexes there.
        return self._context("session-start")

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        context = self._context("prompt", query)
        self._last_recall_count = len(_RECALL_POINTER.findall(context))
        return context

    def recall_status(self) -> Optional[Any]:
        if RecallStatus is None or self._last_recall_count <= 0:
            return None
        return RecallStatus(provider_label="Shared memory", count=self._last_recall_count)

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        # Local index traversal is fast and runs synchronously at turn start.
        return None

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
        turn_author: Optional[Dict[str, Any]] = None,
    ) -> None:
        # Deliberately do not archive transcripts. The injected protocol asks
        # the agent to curate durable facts directly into the shared store.
        return None

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        return (
            "Shared-memory continuity: preserve in the compression summary any durable facts, "
            "decisions, current authorities, and unfinished shared-memory maintenance that are "
            "not yet recorded. Do not claim a fact was saved unless the transcript shows the "
            "shared store was actually updated. The shared-memory system prompt and root indexes "
            "will be reloaded after compression."
        )

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs: Any,
    ) -> None:
        self._session_id = new_session_id
        self._last_recall_count = 0

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        # Hermes's normal filesystem tools perform protocol-aware fact edits.
        # A second generic memory tool would create a competing storage model.
        return []

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return []

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        return None


def register(ctx: Any) -> None:
    ctx.register_memory_provider(SharedMemoryProvider())
