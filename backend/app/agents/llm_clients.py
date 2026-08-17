"""
LLM client factory for PaperAI.

Reads model assignments from environment variables at CALL TIME (not import
time) so .env is already loaded. Defaults to Groq meta-llama/llama-4-scout-17b-16e-instruct
which is free and fast — no OpenAI key required by default.

Supported providers:
  groq      — meta-llama/llama-4-scout-17b-16e-instruct, meta-llama/llama-4-maverick-17b-128e-instruct  (GROQ_API_KEY)
  nvidia    — nvidia: prefix  (NVIDIA_API_KEY_FAST / _REASON / _ULTRA)
  anthropic — claude-*        (ANTHROPIC_API_KEY)
  openai    — gpt-*           (OPENAI_API_KEY)
  google    — gemini-*        (GOOGLE_API_KEY)
  mistral   — mistral-*       (MISTRAL_API_KEY)
  ollama    — ollama:*        (no key, local)
"""

from __future__ import annotations

import os
import logging
from typing import Any, Optional, Tuple

logger = logging.getLogger(__name__)


def _defaults() -> dict:
    """Read model defaults from env at call time — not at import time."""
    return {
        "group_a_primary": os.getenv("AGENT_MODEL_GROUP_A_PRIMARY", "openai/gpt-oss-20b"),
        "group_a_critic":  os.getenv("AGENT_MODEL_GROUP_A_CRITIC",  "qwen/qwen3.6-27b"),
        "group_b_primary": os.getenv("AGENT_MODEL_GROUP_B_PRIMARY", "qwen/qwen3.6-27b"),
        "group_b_critic":  os.getenv("AGENT_MODEL_GROUP_B_CRITIC",  "openai/gpt-oss-20b"),
        "synthesizer":     os.getenv("AGENT_MODEL_SYNTHESIZER",     "qwen/qwen3.6-27b"),
    }


# Module-level DEFAULTS dict — lazily populated on first access
# Orchestrator reads DEFAULTS["group_a_primary"] etc.
class _LazyDefaults(dict):
    """Dict that reads from env on every access so .env is always respected."""
    def get(self, key, default=None):
        return _defaults().get(key, default)
    def __getitem__(self, key):
        return _defaults()[key]
    def __contains__(self, key):
        return key in _defaults()


DEFAULTS = _LazyDefaults()
FALLBACK_CHAIN = ["openai/gpt-oss-20b"]  # Groq always available


def _provider_from_model(model: str) -> str:
    """Infer provider from model name string."""
    m = model.lower()
    if m.startswith("nvidia:"):
        return "nvidia"
    if m.startswith("groq:"):
        return "groq"
    if m.startswith("ollama:"):
        return "ollama"
    if m.startswith("freellm:"):
        return "freellm"
    if "claude" in m:
        return "anthropic"
    if "gpt" in m or m.startswith("o1") or m.startswith("o3"):
        return "openai"
    if "gemini" in m:
        return "google"
    if "mistral" in m or "mixtral" in m:
        return "mistral"
    # Groq models by name
    if any(x in m for x in ["llama-3.3-70b", "llama-3.1-8b", "llama-3.1-70b",
                              "llama-3.2", "llama-3-70b", "mixtral-8x7b",
                              "gemma2-9b", "llama3-", "whisper",
                              "llama-4-scout", "llama-4-maverick",
                              "meta-llama/", "openai/gpt-oss",
                              "qwen/qwen", "groq/compound"]):
        return "groq"
    if "llama3" in m or "ollama" in m:
        return "ollama"
    if "glm" in m:
        return "nvidia"  # z-ai/glm-5.2 via NVIDIA
    raise ValueError(f"Cannot infer provider from model name: {model!r}")


def get_model_for_role(role: str, override: Optional[str] = None) -> Tuple[Any, str]:
    """Return (llm_client, model_name) for the given agent role."""
    model_name = override or _defaults().get(role)
    if not model_name:
        raise ValueError(f"Unknown agent role: {role!r}")

    provider = _provider_from_model(model_name)
    logger.info("LLM client: role=%s model=%s provider=%s", role, model_name, provider)

    if provider == "groq":
        from langchain_openai import ChatOpenAI
        key = os.environ.get("GROQ_API_KEY", "")
        if not key:
            raise RuntimeError("GROQ_API_KEY is not set. Add it to backend/.env")
        return ChatOpenAI(
            model=model_name.replace("groq:", ""),
            api_key=key,
            base_url="https://api.groq.com/openai/v1",
            max_tokens=2048,
            timeout=60,
        ), model_name

    if provider == "nvidia":
        from langchain_openai import ChatOpenAI
        actual = model_name.replace("nvidia:", "")
        if "ultra" in actual or "550b" in actual:
            key = os.environ.get("NVIDIA_API_KEY_ULTRA", "")
        elif "glm" in actual or "z-ai" in actual:
            key = os.environ.get("NVIDIA_API_KEY_REASON", "")
        else:
            key = os.environ.get("NVIDIA_API_KEY_FAST", "")
        if not key:
            raise RuntimeError(f"NVIDIA API key not set for model {actual}")
        return ChatOpenAI(
            model=actual,
            api_key=key,
            base_url="https://integrate.api.nvidia.com/v1",
            max_tokens=2048,
            timeout=60,
        ), model_name

    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(
            model=model_name,
            api_key=os.environ["ANTHROPIC_API_KEY"],
            max_tokens=2048,
            timeout=60,
        ), model_name

    if provider == "openai":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model_name,
            api_key=os.environ["OPENAI_API_KEY"],
            max_tokens=2048,
            timeout=60,
        ), model_name

    if provider == "google":
        from langchain_google_genai import ChatGoogleGenerativeAI
        return ChatGoogleGenerativeAI(
            model=model_name,
            google_api_key=os.environ["GOOGLE_API_KEY"],
            max_output_tokens=2048,
            timeout=60,
        ), model_name

    if provider == "mistral":
        from langchain_mistralai import ChatMistralAI
        return ChatMistralAI(
            model=model_name,
            api_key=os.environ["MISTRAL_API_KEY"],
            max_tokens=2048,
            timeout=60,
        ), model_name

    if provider == "ollama":
        return _SimpleOllamaClient(
            model=model_name.replace("ollama:", ""),
            base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
        ), model_name

    if provider == "freellm":
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(
            model=model_name.replace("freellm:", ""),
            api_key=os.environ.get("FREELLM_API_KEY", "not-needed"),
            base_url=os.getenv("FREELLM_BASE_URL", "http://localhost:8000/v1"),
            max_tokens=2048,
            timeout=60,
        ), model_name

    raise ValueError(f"Unsupported provider: {provider!r}")


# ── Ollama fallback client ─────────────────────────────────────────────────────

class _SimpleOllamaResponse:
    def __init__(self, content: str):
        self.content = content


class _SimpleOllamaClient:
    def __init__(self, model: str, base_url: str):
        self.model = model
        self.base_url = base_url

    def invoke(self, messages) -> _SimpleOllamaResponse:
        import ollama
        client = ollama.Client(host=self.base_url)
        ollama_messages = []
        for m in messages:
            role = "system" if m.__class__.__name__ == "SystemMessage" else "user"
            ollama_messages.append({"role": role, "content": m.content})
        response = client.chat(model=self.model, messages=ollama_messages)
        return _SimpleOllamaResponse(response["message"]["content"])


# Public aliases used by orchestrator.py
provider_from_model = _provider_from_model


def get_model_for_role_with_fallback(role: str, override: Optional[str] = None) -> tuple:
    candidates = [override or _defaults().get(role)] + FALLBACK_CHAIN
    last_exc: Optional[Exception] = None
    for candidate in candidates:
        if not candidate:
            continue
        try:
            return get_model_for_role(role, candidate)
        except Exception as exc:
            last_exc = exc
            logger.warning("Model %r failed for role=%s: %s", candidate, role, exc)
    raise RuntimeError(f"No working model for role={role}") from last_exc