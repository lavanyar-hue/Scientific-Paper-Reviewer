"""
AI Research Assistant chat endpoint.

POST /api/chat/stream  — SSE streaming chat with optional paper context.
POST /api/chat         — non-streaming fallback (single JSON response).

The assistant is aware of:
  - The paper's title, authors, abstract and full text (if paper_id provided)
  - Relevant chunks retrieved via RAG from Chroma (beats truncated full text)
  - The final review verdict (if a completed review job exists for that paper)
  - Conversation history sent by the client (last N messages)
"""
import json
import logging
import os
import threading
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Paper, ReviewJob

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chat", tags=["chat"])

# ── LLM client cache — build once per process, reuse across requests ──────────
_chat_llm_cache: Optional[Any] = None
_chat_llm_lock = threading.Lock()
_chat_llm_model_key: Optional[str] = None  # track which model is cached


def _reset_chat_llm_cache():
    """Force rebuild of LLM cache on next request (e.g. after config change)."""
    global _chat_llm_cache, _chat_llm_model_key
    _chat_llm_cache = None
    _chat_llm_model_key = None


# ── Request schemas ────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str   # "user" | "assistant"
    content: str

class ChatRequest(BaseModel):
    message: str
    paper_id: Optional[str] = None
    job_id: Optional[str] = None
    history: List[ChatMessage] = []


# ── RAG retrieval for chat ─────────────────────────────────────────────────────

def _retrieve_for_chat(paper_id: str, query: str, k: int = 5) -> str:
    """
    Retrieve the most relevant chunks from Chroma for the given query.
    Falls back to empty string if retrieval fails.
    """
    try:
        from app.utils import chunking
        results = chunking.retrieve(paper_id=paper_id, query=query, k=k)
        if not results:
            return ""
        chunks = []
        for r in results:
            section = r.get("section", "")
            text = r.get("text", "")
            if section:
                chunks.append(f"[{section}]\n{text}")
            else:
                chunks.append(text)
        return "\n\n---\n\n".join(chunks)
    except Exception as e:
        logger.warning("RAG retrieval for chat failed: %s", e)
        return ""


# ── System prompt builder ──────────────────────────────────────────────────────

def _build_system(paper: Optional[Paper], job: Optional[ReviewJob], rag_context: str = "") -> str:
    parts = [
        "You are PaperLens Research Assistant. Be concise and direct — "
        "give short, clear answers. No bullet points unless specifically asked. "
        "No markdown headers. Just plain conversational text. "
        "Max 3-4 sentences for simple questions, a short paragraph for complex ones. "
        "Ground answers in the paper's actual content only. Never fabricate.",
    ]

    if paper:
        parts.append(f"\nPaper: {paper.title or 'Unknown'}")
        if paper.authors:
            parts.append(f"Authors: {paper.authors}")
        if paper.abstract:
            parts.append(f"Abstract: {paper.abstract[:500]}")

        if rag_context:
            parts.append(f"\nRelevant excerpts:\n{rag_context}")
        elif paper.content:
            excerpt = paper.content[:4000]
            if len(paper.content) > 4000:
                excerpt += "\n[...truncated...]"
            parts.append(f"\nPaper text:\n{excerpt}")

    if job and job.final_review:
        fr = job.final_review
        parts.append(
            f"\nReview result: {fr.get('final_recommendation','N/A')}, "
            f"score {fr.get('final_scores',{}).get('overall','N/A')}/10"
        )

    parts.append(
        "\nAnswer the user's question clearly and helpfully. "
        "If asked to summarise, explain equations, suggest related work, or critique methodology, do so. "
        "If a question cannot be answered from the available content, say so honestly. "
        "Keep responses concise and well-structured — use bullet points or numbered lists for clarity."
    )
    return "\n".join(parts)


# ── LLM caller — cached, picks cheapest/fastest available provider ─────────────

def _get_chat_llm() -> Any:
    """
    Return a cached LangChain chat model. Built once per process, reused for all requests.
    Auto-invalidates if the GROQ_API_KEY env var changes (e.g. after restart).
    """
    global _chat_llm_cache, _chat_llm_model_key
    # Use current chat key as cache key — if it changed, rebuild
    current_key = (os.environ.get("GROQ_API_KEY_CHAT") or os.environ.get("GROQ_API_KEY", ""))[:8]
    if _chat_llm_cache is not None and _chat_llm_model_key == current_key:
        return _chat_llm_cache

    with _chat_llm_lock:
        if _chat_llm_cache is not None and _chat_llm_model_key == current_key:
            return _chat_llm_cache

        llm = _build_chat_llm()
        _chat_llm_cache = llm
        _chat_llm_model_key = current_key
        return llm


def _build_chat_llm() -> Any:
    """Build and return the best available LLM for chat."""

    # Groq — use dedicated chat key (separate from review agents) to avoid TPM contention
    chat_key = os.environ.get("GROQ_API_KEY_CHAT") or os.environ.get("GROQ_API_KEY", "")
    if chat_key not in ("", "your_groq_api_key_here"):
        try:
            from langchain_openai import ChatOpenAI
            llm = ChatOpenAI(
                model="qwen/qwen3.6-27b",
                api_key=chat_key,
                base_url="https://api.groq.com/openai/v1",
                max_tokens=1500,
                temperature=0.4,
                timeout=45,
            )
            logger.info("Chat LLM: Groq qwen/qwen3.6-27b (dedicated chat key)")
            return llm
        except Exception as e:
            logger.warning("Groq chat init failed: %s", e)

    # Anthropic claude-3-haiku (fast + smart)
    if os.environ.get("ANTHROPIC_API_KEY", "") not in ("", "your_anthropic_api_key_here"):
        try:
            from langchain_anthropic import ChatAnthropic
            llm = ChatAnthropic(
                model="claude-3-haiku-20240307",
                api_key=os.environ["ANTHROPIC_API_KEY"],
                max_tokens=1500,
                timeout=45,
            )
            logger.info("Chat LLM: Anthropic claude-3-haiku")
            return llm
        except Exception as e:
            logger.warning("Anthropic chat init failed: %s", e)

    # Google gemini-1.5-flash (stable, widely available)
    if os.environ.get("GOOGLE_API_KEY", "") not in ("", "your_google_api_key_here"):
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI
            llm = ChatGoogleGenerativeAI(
                model="gemini-1.5-flash",
                google_api_key=os.environ["GOOGLE_API_KEY"],
                max_output_tokens=1500,
                timeout=45,
            )
            logger.info("Chat LLM: Google gemini-1.5-flash")
            return llm
        except Exception as e:
            logger.warning("Google chat init failed: %s", e)

    # Mistral small
    if os.environ.get("MISTRAL_API_KEY", "") not in ("", "your_mistral_api_key_here"):
        try:
            from langchain_mistralai import ChatMistralAI
            llm = ChatMistralAI(
                model="mistral-small-latest",
                api_key=os.environ["MISTRAL_API_KEY"],
                max_tokens=1500,
                timeout=45,
            )
            logger.info("Chat LLM: Mistral small")
            return llm
        except Exception as e:
            logger.warning("Mistral chat init failed: %s", e)

    # OpenAI as last resort
    if os.environ.get("OPENAI_API_KEY", "") not in ("", "your_openai_api_key_here"):
        try:
            from langchain_openai import ChatOpenAI
            llm = ChatOpenAI(
                model="gpt-4o-mini",
                api_key=os.environ["OPENAI_API_KEY"],
                max_tokens=1500,
                timeout=45,
            )
            logger.info("Chat LLM: OpenAI gpt-4o-mini")
            return llm
        except Exception as e:
            logger.warning("OpenAI chat init failed: %s", e)

    raise HTTPException(
        status_code=503,
        detail=(
            "No working LLM API key found. "
            "Add GROQ_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, MISTRAL_API_KEY, "
            "or OPENAI_API_KEY to backend/.env and restart the server."
        )
    )


# ── SSE streaming endpoint ─────────────────────────────────────────────────────

@router.post("/stream")
async def chat_stream(body: ChatRequest, db: Session = Depends(get_db)):
    """
    Stream AI assistant response as Server-Sent Events.
    Uses RAG to retrieve relevant paper sections for better context quality.
    """
    paper: Optional[Paper] = None
    job: Optional[ReviewJob] = None

    if body.paper_id:
        paper = db.query(Paper).filter(Paper.id == body.paper_id).first()

    if body.job_id:
        job = db.query(ReviewJob).filter(ReviewJob.id == body.job_id).first()
    elif paper:
        job = (
            db.query(ReviewJob)
            .filter(ReviewJob.paper_id == paper.id, ReviewJob.status == "completed")
            .order_by(ReviewJob.created_at.desc())
            .first()
        )

    # RAG: retrieve relevant content for this specific question
    rag_context = ""
    if paper and body.message:
        rag_context = _retrieve_for_chat(paper.id, body.message, k=5)

    system_text = _build_system(paper, job, rag_context)

    try:
        llm = _get_chat_llm()
    except HTTPException as exc:
        async def error_gen():
            yield f"data: {json.dumps({'error': exc.detail})}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(error_gen(), media_type="text/event-stream")

    from langchain_core.messages import HumanMessage, SystemMessage, AIMessage

    messages = [SystemMessage(content=system_text)]
    for msg in body.history[-10:]:
        if msg.role == "user":
            messages.append(HumanMessage(content=msg.content))
        elif msg.role == "assistant":
            messages.append(AIMessage(content=msg.content))
    messages.append(HumanMessage(content=body.message))

    async def generate():
        try:
            async for chunk in llm.astream(messages):
                text = chunk.content if hasattr(chunk, "content") else str(chunk)
                if text:
                    yield f"data: {json.dumps({'token': text})}\n\n"
        except Exception as exc:
            logger.error("Chat stream error: %s", exc)
            # Clear cache so next request tries fresh init
            global _chat_llm_cache
            _chat_llm_cache = None
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Non-streaming fallback ─────────────────────────────────────────────────────

@router.post("")
async def chat_sync(body: ChatRequest, db: Session = Depends(get_db)):
    """Non-streaming fallback — returns full response as JSON."""
    paper: Optional[Paper] = None
    job: Optional[ReviewJob] = None

    if body.paper_id:
        paper = db.query(Paper).filter(Paper.id == body.paper_id).first()
    if body.job_id:
        job = db.query(ReviewJob).filter(ReviewJob.id == body.job_id).first()
    elif paper:
        job = (
            db.query(ReviewJob)
            .filter(ReviewJob.paper_id == paper.id, ReviewJob.status == "completed")
            .order_by(ReviewJob.created_at.desc())
            .first()
        )

    rag_context = ""
    if paper and body.message:
        rag_context = _retrieve_for_chat(paper.id, body.message, k=5)

    system_text = _build_system(paper, job, rag_context)
    llm = _get_chat_llm()

    from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
    messages = [SystemMessage(content=system_text)]
    for msg in body.history[-10:]:
        if msg.role == "user":
            messages.append(HumanMessage(content=msg.content))
        elif msg.role == "assistant":
            messages.append(AIMessage(content=msg.content))
    messages.append(HumanMessage(content=body.message))

    try:
        resp = llm.invoke(messages)
        return {"response": resp.content}
    except Exception as exc:
        global _chat_llm_cache
        _chat_llm_cache = None
        raise HTTPException(status_code=500, detail=str(exc))