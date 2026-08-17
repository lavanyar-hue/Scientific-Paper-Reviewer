"""
Agentic RAG tooling for PaperLens reviewer nodes.

Gives each reviewer agent a `retrieve_paper_section` tool it can call
repeatedly (reason -> retrieve -> reason -> retrieve...) instead of being
handed the entire paper text up front. This is what makes the review
"agentic RAG" rather than plain RAG.

Every tool call is logged as a retrieval step so the trace (what was
looked up, in what order, and why) can later be exported as training
signal — see routers/finetune.py and models.RetrievalTrace.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable, Dict, List, Optional

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from app.utils import chunking

logger = logging.getLogger(__name__)

MAX_AGENTIC_STEPS = 6  # cap on retrieve-reason loops per agent, per paper


def make_retrieval_tool(paper_id: str, trace_sink: Optional[List[dict]] = None):
    """
    Build a `retrieve_paper_section` tool bound to a specific paper_id.
    trace_sink, if given, collects a record of every call for later logging.
    """

    @tool
    def retrieve_paper_section(query: str, section: Optional[str] = None) -> str:
        """
        Retrieve the most relevant excerpts from the paper being reviewed.
        Use this instead of assuming paper content — call it whenever you need
        to check a specific claim, section, or detail (e.g. "sample size used
        in experiments", "related work on transformers", "limitations
        discussed by the authors"). Optionally restrict to a known section
        name such as 'methods', 'results', 'references', 'abstract'.
        """
        chunks = chunking.retrieve(paper_id=paper_id, query=query, k=4, section_filter=section)
        if trace_sink is not None:
            trace_sink.append(
                {
                    "query": query,
                    "section_filter": section,
                    "retrieved_chunk_ids": [c["id"] for c in chunks],
                    "retrieved_sections": [c["section"] for c in chunks],
                    "timestamp": time.time(),
                }
            )
        if not chunks:
            return "No matching content found for that query."
        return "\n\n---\n\n".join(f"[section: {c['section']}]\n{c['text']}" for c in chunks)

    return retrieve_paper_section


def _strip_fences(text: str) -> str:
    import re
    # Strip <think>...</think> blocks from reasoning models (e.g. qwen3, deepseek-r1)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE)
    return text.strip()
    return text.strip()


def _parse_final_json(raw: str) -> Dict[str, Any]:
    import re
    cleaned = _strip_fences(raw)
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        cleaned = match.group(0)
    return json.loads(cleaned)


def run_agentic_reviewer(
    llm: Any,
    system_text: str,
    human_text: str,
    paper_id: str,
    max_steps: int = MAX_AGENTIC_STEPS,
) -> tuple:
    """
    Run a reviewer agent in a tool-calling loop:
      reason -> (optionally call retrieve_paper_section) -> reason -> ... -> final JSON verdict

    Returns (parsed_dict, retrieval_trace list).
    Raises on malformed final output or if max_steps is exhausted without a
    final answer (caller should treat as a failed node, same as before).
    """
    trace: List[dict] = []
    retrieve_tool = make_retrieval_tool(paper_id, trace_sink=trace)
    llm_with_tools = llm.bind_tools([retrieve_tool])

    messages: List[Any] = [
        SystemMessage(content=system_text),
        HumanMessage(content=human_text),
    ]

    for step in range(max_steps):
        response: AIMessage = llm_with_tools.invoke(messages)
        messages.append(response)

        tool_calls = getattr(response, "tool_calls", None) or []
        if not tool_calls:
            # No more retrieval requested — this should be the final JSON verdict
            parsed = _parse_final_json(response.content)
            return parsed, trace

        for call in tool_calls:
            if call["name"] == "retrieve_paper_section":
                result = retrieve_tool.invoke(call["args"])
            else:
                result = f"Unknown tool: {call['name']}"
            messages.append(ToolMessage(content=str(result), tool_call_id=call["id"]))

    # Ran out of steps — force a final answer with no more tool access
    final_prompt = HumanMessage(
        content="You have used your available retrieval steps. Based on everything "
        "retrieved so far, respond now with ONLY the final JSON verdict — no more tool calls."
    )
    messages.append(final_prompt)
    forced_response = llm.invoke(messages)  # plain llm, no tools bound, forces text output
    parsed = _parse_final_json(forced_response.content)
    return parsed, trace


def run_simple_rag_reviewer(llm: Any, system_text: str, human_prompt: str, paper_id: str, job_id: Optional[str] = None, role: Optional[str] = None) -> tuple:
    """
    Fallback for models that don't support LangChain tool-calling (e.g. the
    local Ollama client, which only implements .invoke()). Retrieves relevant
    chunks ONCE upfront across a few standard reviewer queries and stuffs them
    into the prompt — a single call, no reason/retrieve loop. Still solves the
    original "don't hand the model a truncated full-text blob" problem, just
    without adaptive retrieval.

    Returns (parsed_dict, retrieval_trace) — trace is a single-entry list
    (all queries run upfront) rather than the multi-step trace an agentic
    loop produces, so training-signal export still has something to show.
    """
    standard_queries = [
        "abstract and main contribution",
        "methodology and experimental setup",
        "results and evaluation",
        "limitations and related work",
    ]

    seen_ids = set()
    context_parts: List[str] = []
    trace: List[dict] = []
    for query in standard_queries:
        chunks = chunking.retrieve(paper_id=paper_id, query=query, k=3)
        trace.append(
            {
                "query": query,
                "section_filter": None,
                "retrieved_chunk_ids": [c["id"] for c in chunks],
                "retrieved_sections": [c["section"] for c in chunks],
                "timestamp": time.time(),
            }
        )
        for c in chunks:
            if c["id"] not in seen_ids:
                seen_ids.add(c["id"])
                context_parts.append(f"[section: {c['section']}]\n{c['text']}")

    context = "\n\n---\n\n".join(context_parts) if context_parts else "No indexed content found for this paper."
    full_human = f"{human_prompt}\n\nRetrieved paper excerpts (gathered upfront, not interactively):\n---\n{context}\n---"

    response = llm.invoke([SystemMessage(content=system_text), HumanMessage(content=full_human)])
    if job_id:
        from app.utils import observability, cost_tracker
        from app.agents.llm_clients import provider_from_model
        # Note: simple_rag is the Ollama path today, so provider is always
        # "ollama" here and cost is $0 — this call is logged mainly for
        # latency/volume visibility in the dashboard, not cost.
        provider = "ollama"
        usage = cost_tracker.extract_usage_from_response(
            response, provider, fallback_char_count=len(system_text) + len(full_human)
        )
        observability.event(job_id, "llm_call", role, {"model": "ollama", **usage})
    parsed = _parse_final_json(response.content)
    return parsed, trace