"""
LangGraph orchestration for PaperLens — Agentic RAG edition.

Graph topology (unchanged shape from the original):
  START
    -> [group_a_primary, group_b_primary]   (parallel fan-out)
    -> [group_a_critic,  group_b_critic]    (parallel, each depends on its own primary)
    -> synthesize
  END

What changed: each reviewer node is now an AGENTIC node. Instead of being
handed the full paper text in the prompt, it gets a `retrieve_paper_section`
tool (see agents/tools.py) and loops reason -> retrieve -> reason -> ... until
it has enough evidence to produce its verdict. This directly targets the
hallucination risk of stuffing an 80k-char truncated blob into one prompt.

Two config toggles (env vars):
  AGENTIC_RAG_ENABLED        default "true"  — falls back to the old
                              full-text-in-prompt behaviour if "false"
                              (useful for A/B comparison or if a paper
                              failed to index).
  INDEPENDENT_AGENTS_MODE    default "false" — if "true", critics do NOT
                              see their primary's review and instead form
                              a fully independent second opinion using only
                              retrieval, matching the "4 independent AIs"
                              framing. Default keeps the original
                              primary-then-critic-refines structure.

Every retrieval call each node makes is captured and handed back in the
final state as `retrieval_traces`, keyed by node name, so the caller
(routers/review.py) can persist it for later fine-tuning export.
"""

from __future__ import annotations

import json
import logging
import operator
import os
import re
import time
from datetime import datetime
from typing import Annotated, Any, Dict, List, Optional, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph

from app.agents.llm_clients import get_model_for_role, DEFAULTS, provider_from_model
from app.agents.prompts import (
    AGENTIC_CRITIC_REVIEWER_PROMPT,
    AGENTIC_PRIMARY_REVIEWER_PROMPT,
    CRITIC_REVIEWER_PROMPT,
    PRIMARY_REVIEWER_PROMPT,
    SYNTHESIZER_PROMPT,
    SYSTEM_PROMPT,
)
from app.agents.tools import run_agentic_reviewer, run_simple_rag_reviewer
from app.utils import chunking
from app.utils import observability
from app.utils import cost_tracker

logger = logging.getLogger(__name__)

MAX_RETRIES = 4         # more retries for rate limits
RETRY_DELAY = 5         # base delay, doubles each retry — 5, 10, 20, 40s

AGENTIC_RAG_ENABLED = os.getenv("AGENTIC_RAG_ENABLED", "true").lower() == "true"
INDEPENDENT_AGENTS_MODE = os.getenv("INDEPENDENT_AGENTS_MODE", "false").lower() == "true"

def _agentic_rag_enabled():
    return os.getenv("AGENTIC_RAG_ENABLED", "true").lower() == "true"


# ── LangGraph state ────────────────────────────────────────────────────────────

class PaperLensState(TypedDict):
    job_id: str
    paper_id: str
    paper_title: str
    authors: str
    paper_full_text: str
    research_field: str
    current_date: str
    model_config: Dict[str, Optional[str]]
    integrity_report: Optional[str]  # from plagiarism/AI-text/CNN checks, JSON string

    group_a_primary: Optional[Dict[str, Any]]
    group_a_critic: Optional[Dict[str, Any]]
    group_b_primary: Optional[Dict[str, Any]]
    group_b_critic: Optional[Dict[str, Any]]
    final_review: Optional[Dict[str, Any]]

    retrieval_traces: Annotated[Dict[str, List[dict]], lambda a, b: {**a, **b}]
    errors: Annotated[List[str], operator.add]
    _db_callback: Any


# ── Helpers ────────────────────────────────────────────────────────────────────

def _strip_fences(text: str) -> str:
    # Strip <think>...</think> blocks from reasoning models (e.g. qwen3)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE)
    return text.strip()


def _parse_llm_json(raw: str) -> Dict[str, Any]:
    cleaned = _strip_fences(raw)
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        cleaned = match.group(0)
    return json.loads(cleaned)


def _extract_retry_after(exc_str: str) -> float:
    """Extract suggested wait time from Groq rate limit error messages."""
    m = re.search(r"try again in (\d+(?:\.\d+)?)s", exc_str, re.IGNORECASE)
    return float(m.group(1)) + 2 if m else 20.0


def _call_llm(role: str, override_model: Optional[str], system_text: str, human_text: str, job_id: Optional[str] = None) -> tuple:
    """Plain (non-agentic) LLM call with retries and Groq fallback."""
    llm, model_name = get_model_for_role(role, override_model)
    messages = [SystemMessage(content=system_text), HumanMessage(content=human_text)]

    last_exc: Optional[Exception] = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = llm.invoke(messages)
            parsed = _parse_llm_json(response.content)
            if job_id:
                provider = provider_from_model(model_name) or "unknown"
                usage = cost_tracker.extract_usage_from_response(
                    response, provider, fallback_char_count=len(system_text) + len(human_text)
                )
                observability.event(job_id, "llm_call", role, {"model": model_name, **usage})
            return parsed, model_name
        except Exception as exc:
            last_exc = exc
            err_str = str(exc).lower()
            wait = RETRY_DELAY * (2 ** attempt)
            if "rate" in err_str or "429" in err_str or "quota" in err_str or "tpm" in err_str:
                wait = max(wait, _extract_retry_after(str(exc)))
                logger.warning("Rate limit hit (role=%s attempt=%d), waiting %.0fs", role, attempt + 1, wait)
            elif "empty" in err_str or "column 1" in err_str or "expecting value" in err_str:
                # Empty response — switch to fallback model immediately
                logger.warning("Empty/invalid response from %s (role=%s) — trying fallback", model_name, role)
                try:
                    groq_llm, groq_model = get_model_for_role(role, "qwen/qwen3.6-27b")
                    response = groq_llm.invoke(messages)
                    parsed = _parse_llm_json(response.content)
                    logger.info("Fallback succeeded for role=%s", role)
                    return parsed, groq_model
                except Exception as groq_exc:
                    logger.warning("Fallback also failed: %s", groq_exc)
                    last_exc = groq_exc
            else:
                logger.warning("LLM call failed (role=%s attempt=%d): %s", role, attempt + 1, exc)
            if attempt < MAX_RETRIES:
                time.sleep(wait)
    raise RuntimeError(f"LLM call failed after {MAX_RETRIES + 1} attempts") from last_exc


def _call_llm_agentic(role: str, override_model: Optional[str], system_text: str, human_text: str, paper_id: str) -> tuple:
    """Agentic tool-calling call with retries. Returns (parsed_dict, model_name, trace)."""
    llm, model_name = get_model_for_role(role, override_model)

    last_exc: Optional[Exception] = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            parsed, trace = run_agentic_reviewer(llm, system_text, human_text, paper_id)
            return parsed, model_name, trace
        except Exception as exc:
            last_exc = exc
            err_str = str(exc).lower()
            wait = RETRY_DELAY * (2 ** attempt)
            if "rate" in err_str or "429" in err_str or "quota" in err_str or "tpm" in err_str:
                wait = max(wait, _extract_retry_after(str(exc)))
                logger.warning("Rate limit hit (role=%s attempt=%d), waiting %.0fs", role, attempt + 1, wait)
            else:
                logger.warning("Agentic LLM call failed (role=%s attempt=%d): %s", role, attempt + 1, exc)
            if attempt < MAX_RETRIES:
                time.sleep(wait)
    raise RuntimeError(f"Agentic LLM call failed after {MAX_RETRIES + 1} attempts") from last_exc


def _system(state: PaperLensState) -> str:
    return SYSTEM_PROMPT.format(current_date=state["current_date"], research_field=state["research_field"])


def _db_write(state: PaperLensState, group: str, role: str, model: str, response: Optional[Dict], error: Optional[str]):
    cb = state.get("_db_callback")
    if cb:
        try:
            cb(job_id=state["job_id"], group=group, agent_role=role, model_name=model, response=response, error_message=error)
        except Exception as exc:
            logger.error("DB callback failed: %s", exc)


def _paper_indexed(paper_id: str) -> bool:
    """Guard: fall back to plain mode if a paper somehow wasn't indexed (e.g. Chroma unavailable)."""
    return bool(chunking.list_sections(paper_id))


# ── Node factory: primary reviewer (agentic) ───────────────────────────────────

def _resolve_path(state: "PaperLensState", role: str, override: Optional[str]) -> str:
    """
    Decide which of the three code paths a node should take:
      "tool_loop"   — agentic RAG with real retrieve-tool binding (Claude/GPT-4o/Gemini/Mistral/Groq)
      "simple_rag"  — retrieval done upfront, single call (Ollama — no bind_tools support)
      "plain_text"  — original full-text-in-prompt behavior (AGENTIC_RAG_ENABLED=false, or paper not indexed)
    """
    if not (_agentic_rag_enabled() and _paper_indexed(state["paper_id"])):
        return "plain_text"
    model_name = override or DEFAULTS.get(role)
    provider = provider_from_model(model_name) if model_name else None
    return "simple_rag" if provider == "ollama" else "tool_loop"


def _make_primary_node(group: str):
    role = f"group_{group.lower()}_primary"

    def node(state: PaperLensState) -> dict:
        # Stagger Group B by 3s to spread token usage and avoid simultaneous 429s
        if group == "B":
            time.sleep(3)
        override = state["model_config"].get(role)
        system = _system(state)
        path = _resolve_path(state, role, override)
        observability.event(state["job_id"], "node_start", role, {"path": path})
        _node_t0 = time.time()

        try:
            if path == "tool_loop":
                human = AGENTIC_PRIMARY_REVIEWER_PROMPT.format(
                    group=group, paper_title=state["paper_title"], authors=state["authors"]
                )
                parsed, model, trace = _call_llm_agentic(role, override, system, human, state["paper_id"])
                traces = dict(state.get("retrieval_traces", {}))
                traces[role] = trace
            elif path == "simple_rag":
                llm, model = get_model_for_role(role, override)
                human = AGENTIC_PRIMARY_REVIEWER_PROMPT.format(
                    group=group, paper_title=state["paper_title"], authors=state["authors"]
                ).replace(
                    "You do NOT have the full paper text in this prompt. Use the retrieve_paper_section "
                    "tool to pull the specific excerpts you need — start broad (e.g. abstract, introduction) "
                    "then drill into methods, results, and limitations as your review requires. Only stop "
                    "calling the tool once you have enough evidence to review every dimension below. Do not "
                    "guess or fabricate content you have not retrieved.",
                    "Relevant excerpts from the paper are provided below the prompt. Base your review only "
                    "on that retrieved content — do not guess or fabricate content that isn't shown.",
                )
                parsed, trace = run_simple_rag_reviewer(llm, system, human, state["paper_id"], job_id=state["job_id"], role=role)
                traces = dict(state.get("retrieval_traces", {}))
                traces[role] = trace
            else:
                # Truncate to ~8000 chars (~2000 tokens) for faster responses
                truncated_text = state["paper_full_text"][:8000]
                if len(state["paper_full_text"]) > 8000:
                    truncated_text += "\n\n[...paper truncated for speed...]"
                human = PRIMARY_REVIEWER_PROMPT.format(
                    group=group, paper_title=state["paper_title"], authors=state["authors"],
                    paper_full_text=truncated_text,
                )
                parsed, model = _call_llm(role, override, system, human, job_id=state["job_id"])
                traces = state.get("retrieval_traces", {})

            _db_write(state, group, "primary", model if path != "simple_rag" else (override or DEFAULTS.get(role)), parsed, None)
            observability.event(
                state["job_id"], "node_end", role,
                {"path": path, "model": model if path != "simple_rag" else (override or DEFAULTS.get(role))},
                (time.time() - _node_t0) * 1000,
            )
            result = {f"group_{group.lower()}_primary": parsed}
            if path != "plain_text":
                result["retrieval_traces"] = traces
            return result
        except Exception as exc:
            msg = str(exc)
            logger.error("%s failed: %s", role, msg)
            _db_write(state, group, "primary", override or "unknown", None, msg)
            observability.event(state["job_id"], "node_error", role, {"error": msg}, (time.time() - _node_t0) * 1000)
            return {
                f"group_{group.lower()}_primary": None,
                "errors": [f"{role}: {msg}"],
            }

    return node


# ── Node factory: critic reviewer (agentic) ─────────────────────────────────────

def _make_critic_node(group: str):
    role = f"group_{group.lower()}_critic"
    primary_key = f"group_{group.lower()}_primary"

    def node(state: PaperLensState) -> dict:
        override = state["model_config"].get(role)
        system = _system(state)
        path = _resolve_path(state, role, override)
        observability.event(state["job_id"], "node_start", role, {"path": path})
        _node_t0 = time.time()

        # In independent-agents mode, the critic never sees the primary's output —
        # it forms a second opinion purely from its own retrieval.
        primary_output = {} if INDEPENDENT_AGENTS_MODE else (state.get(primary_key) or {})
        initial = json.dumps(primary_output, indent=2)

        try:
            if path == "tool_loop":
                human = AGENTIC_CRITIC_REVIEWER_PROMPT.format(group=group, initial_review_json=initial)
                parsed, model, trace = _call_llm_agentic(role, override, system, human, state["paper_id"])
                traces = dict(state.get("retrieval_traces", {}))
                traces[role] = trace
            elif path == "simple_rag":
                llm, model = get_model_for_role(role, override)
                human = AGENTIC_CRITIC_REVIEWER_PROMPT.format(group=group, initial_review_json=initial).replace(
                    "You do NOT have the full paper text in this prompt. Use the retrieve_paper_section tool "
                    "to independently verify the Primary Reviewer's claims against the actual paper content — "
                    "especially anything specific (numbers, methods, citations) that could be hallucinated. "
                    "Retrieve whatever sections you need to confirm or correct each claim.",
                    "Relevant excerpts from the paper are provided below the prompt. Use them to independently "
                    "verify the Primary Reviewer's claims — especially anything specific (numbers, methods, "
                    "citations) that could be hallucinated.",
                )
                parsed, trace = run_simple_rag_reviewer(llm, system, human, state["paper_id"], job_id=state["job_id"], role=role)
                traces = dict(state.get("retrieval_traces", {}))
                traces[role] = trace
            else:
                truncated_text = state["paper_full_text"][:8000]
                if len(state["paper_full_text"]) > 8000:
                    truncated_text += "\n\n[...truncated...]"
                human = CRITIC_REVIEWER_PROMPT.format(
                    group=group, initial_review_json=initial, paper_full_text=truncated_text
                )
                parsed, model = _call_llm(role, override, system, human, job_id=state["job_id"])
                traces = state.get("retrieval_traces", {})

            _db_write(state, group, "critic", model if path != "simple_rag" else (override or DEFAULTS.get(role)), parsed, None)
            observability.event(
                state["job_id"], "node_end", role,
                {"path": path, "model": model if path != "simple_rag" else (override or DEFAULTS.get(role))},
                (time.time() - _node_t0) * 1000,
            )
            result = {f"group_{group.lower()}_critic": parsed}
            if path != "plain_text":
                result["retrieval_traces"] = traces
            return result
        except Exception as exc:
            msg = str(exc)
            logger.error("%s failed: %s", role, msg)
            _db_write(state, group, "critic", override or "unknown", None, msg)
            observability.event(state["job_id"], "node_error", role, {"error": msg}, (time.time() - _node_t0) * 1000)
            return {
                f"group_{group.lower()}_critic": None,
                "errors": [f"{role}: {msg}"],
            }

    return node


node_group_a_primary = _make_primary_node("A")
node_group_b_primary = _make_primary_node("B")
node_group_a_critic = _make_critic_node("A")
node_group_b_critic = _make_critic_node("B")


# ── Synthesizer (unchanged: not agentic — sees both full refined reviews) ──────

def node_synthesize(state: PaperLensState) -> dict:
    role = "synthesizer"
    override = state["model_config"].get(role)
    system = _system(state)
    # Limit synthesizer input to 3000 chars for speed — it mainly needs the two reviews, not full text
    synth_text = state["paper_full_text"][:3000]
    if len(state["paper_full_text"]) > 3000:
        synth_text += "\n\n[...truncated for speed...]"
    human = SYNTHESIZER_PROMPT.format(
        paper_full_text=synth_text,
        group_a_review=json.dumps(state.get("group_a_critic") or state.get("group_a_primary") or {}, indent=2),
        group_b_review=json.dumps(state.get("group_b_critic") or state.get("group_b_primary") or {}, indent=2),
        integrity_report=state.get("integrity_report") or "No automated integrity checks were run for this paper.",
    )
    try:
        parsed, model = _call_llm(role, override, system, human, job_id=state["job_id"])
        _db_write(state, "FINAL", "synthesizer", model, parsed, None)
        return {"final_review": parsed}
    except Exception as exc:
        msg = str(exc)
        logger.error("synthesizer failed: %s", msg)
        _db_write(state, "FINAL", "synthesizer", override or "unknown", None, msg)
        return {"final_review": None, "errors": [f"synthesizer: {msg}"]}


# ── Graph wiring ───────────────────────────────────────────────────────────────

def build_graph():
    graph = StateGraph(PaperLensState)

    def dispatch(state: PaperLensState) -> list:
        return ["node_a_primary", "node_b_primary"]

    graph.add_node("dispatch", lambda s: s)
    graph.add_node("node_a_primary", node_group_a_primary)
    graph.add_node("node_b_primary", node_group_b_primary)
    graph.add_node("node_a_critic", node_group_a_critic)
    graph.add_node("node_b_critic", node_group_b_critic)
    graph.add_node("node_synthesize", node_synthesize)

    graph.add_edge(START, "dispatch")
    graph.add_conditional_edges(
        "dispatch", dispatch,
        {"node_a_primary": "node_a_primary", "node_b_primary": "node_b_primary"},
    )
    graph.add_edge("node_a_primary", "node_a_critic")
    graph.add_edge("node_b_primary", "node_b_critic")
    graph.add_edge("node_a_critic", "node_synthesize")
    graph.add_edge("node_b_critic", "node_synthesize")
    graph.add_edge("node_synthesize", END)

    return graph.compile()


_compiled_graph = build_graph()


def run_review(
    job_id: str,
    paper_id: str,
    paper_title: str,
    authors: str,
    paper_full_text: str,
    research_field: str,
    model_config: Dict[str, Optional[str]],
    db_callback: Any,
    integrity_report: Optional[str] = None,
) -> PaperLensState:
    """Execute the full review pipeline synchronously. Returns the final state."""
    initial_state: PaperLensState = {
        "job_id": job_id,
        "paper_id": paper_id,
        "paper_title": paper_title,
        "authors": authors,
        "paper_full_text": paper_full_text,
        "research_field": research_field,
        "current_date": datetime.utcnow().strftime("%Y-%m-%d"),
        "model_config": model_config,
        "integrity_report": integrity_report,
        "group_a_primary": None,
        "group_a_critic": None,
        "group_b_primary": None,
        "group_b_critic": None,
        "final_review": None,
        "retrieval_traces": {},
        "errors": [],
        "_db_callback": db_callback,
    }
    observability.event(job_id, "job_start", None, {"paper_id": paper_id, "paper_title": paper_title})
    final_state = _compiled_graph.invoke(initial_state)
    observability.event(
        job_id, "job_end", None,
        {"success": bool(final_state.get("final_review")), "errors": final_state.get("errors", [])},
    )
    return final_state