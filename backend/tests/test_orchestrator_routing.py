"""
Unit tests for the _resolve_path() routing logic in app/agents/orchestrator.py
— the exact fix for the Ollama bind_tools() crash found earlier. These tests
exist specifically so that bug can never silently regress: if someone later
changes provider detection or the AGENTIC_RAG_ENABLED default, this test
suite catches it before it reaches a running review job.

Stubs out langchain_core, langgraph, and chromadb so this runs without
installing the full backend dependency stack.

Run: cd backend && pytest tests/test_orchestrator_routing.py -v
"""

import sys
import os
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _install_stubs():
    for name in [
        "langgraph", "langgraph.graph",
        "chromadb", "chromadb.utils", "chromadb.utils.embedding_functions",
    ]:
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)

    class _FakeStateGraph:
        def __init__(self, *a, **kw):
            pass

        def add_node(self, *a, **kw):
            pass

        def add_edge(self, *a, **kw):
            pass

        def add_conditional_edges(self, *a, **kw):
            pass

        def compile(self, *a, **kw):
            return self

        def invoke(self, *a, **kw):
            return {}

    sys.modules["langgraph.graph"].StateGraph = _FakeStateGraph
    sys.modules["langgraph.graph"].START = "START"
    sys.modules["langgraph.graph"].END = "END"

    sys.modules["chromadb"].PersistentClient = lambda *a, **kw: None
    sys.modules["chromadb.utils.embedding_functions"].SentenceTransformerEmbeddingFunction = lambda *a, **kw: None


_install_stubs()

from app.agents import orchestrator  # noqa: E402


def _fake_state(paper_id="unindexed_paper"):
    return {"paper_id": paper_id, "model_config": {}}


def test_ollama_model_never_routes_to_tool_loop(monkeypatch):
    """
    THE regression guard for the original bug: an Ollama-assigned role must
    NEVER resolve to 'tool_loop', because _SimpleOllamaClient has no
    bind_tools() and would crash.
    """
    monkeypatch.setattr(orchestrator, "AGENTIC_RAG_ENABLED", True)
    monkeypatch.setattr(orchestrator, "_paper_indexed", lambda paper_id: True)  # pretend paper is indexed

    path = orchestrator._resolve_path(_fake_state(), "group_a_primary", "ollama:llama3.1")
    assert path != "tool_loop"
    assert path == "simple_rag"


def test_ollama_llama3_shorthand_also_routes_to_simple_rag(monkeypatch):
    monkeypatch.setattr(orchestrator, "AGENTIC_RAG_ENABLED", True)
    monkeypatch.setattr(orchestrator, "_paper_indexed", lambda paper_id: True)

    path = orchestrator._resolve_path(_fake_state(), "group_b_critic", "llama3.1-local")
    assert path == "simple_rag"


def test_claude_model_routes_to_tool_loop_when_indexed(monkeypatch):
    monkeypatch.setattr(orchestrator, "AGENTIC_RAG_ENABLED", True)
    monkeypatch.setattr(orchestrator, "_paper_indexed", lambda paper_id: True)

    path = orchestrator._resolve_path(_fake_state(), "group_a_primary", "claude-sonnet-4-5")
    assert path == "tool_loop"


def test_unindexed_paper_falls_back_to_plain_text_regardless_of_provider(monkeypatch):
    monkeypatch.setattr(orchestrator, "AGENTIC_RAG_ENABLED", True)
    monkeypatch.setattr(orchestrator, "_paper_indexed", lambda paper_id: False)  # not indexed

    claude_path = orchestrator._resolve_path(_fake_state(), "group_a_primary", "claude-sonnet-4-5")
    ollama_path = orchestrator._resolve_path(_fake_state(), "group_a_primary", "ollama:llama3.1")

    assert claude_path == "plain_text"
    assert ollama_path == "plain_text"


def test_agentic_rag_disabled_always_uses_plain_text(monkeypatch):
    monkeypatch.setattr(orchestrator, "AGENTIC_RAG_ENABLED", False)
    monkeypatch.setattr(orchestrator, "_paper_indexed", lambda paper_id: True)

    path = orchestrator._resolve_path(_fake_state(), "group_a_primary", "claude-sonnet-4-5")
    assert path == "plain_text"


def test_groq_model_routes_to_tool_loop(monkeypatch):
    """Groq uses an OpenAI-compatible client that DOES support bind_tools — should get the full loop."""
    monkeypatch.setattr(orchestrator, "AGENTIC_RAG_ENABLED", True)
    monkeypatch.setattr(orchestrator, "_paper_indexed", lambda paper_id: True)

    path = orchestrator._resolve_path(_fake_state(), "group_b_primary", "meta-llama/llama-4-scout-17b-16e-instruct")
    assert path == "tool_loop"


if __name__ == "__main__":
    print("This test file uses pytest's monkeypatch fixture — run with:")
    print("  pytest tests/test_orchestrator_routing.py -v")