"""
Shared PDF chunking + vector store layer for PaperLens.

Splits extracted paper text into section-aware chunks, embeds them, and
stores them in a per-paper Chroma collection. This is the single foundation
that the agentic RAG reviewer nodes (agents/tools.py), the plagiarism/AI-text
detector (utils/plagiarism.py), and the CNN figure pipeline all read from.

No API key required — embeddings run locally via sentence-transformers.
"""

from __future__ import annotations

import logging
import os
import re
from typing import List, Optional, TypedDict

import chromadb
from langchain_text_splitters import RecursiveCharacterTextSplitter

logger = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────────────────────────

CHROMA_PERSIST_DIR = os.getenv("CHROMA_PERSIST_DIR", "./chroma_store")
EMBEDDING_MODEL_NAME = os.getenv("EMBEDDING_MODEL_NAME", "all-MiniLM-L6-v2")

CHUNK_SIZE = 1200
CHUNK_OVERLAP = 200

_SECTION_HEADERS = [
    "abstract", "introduction", "related work", "background",
    "methodology", "methods", "approach", "experiments",
    "results", "evaluation", "discussion", "limitations",
    "conclusion", "references", "acknowledgments", "appendix",
]

_SECTION_RE = re.compile(
    r"^\s*(?:\d+\.?\s+)?(" + "|".join(_SECTION_HEADERS) + r")\s*$",
    re.IGNORECASE | re.MULTILINE,
)


# ── Types ────────────────────────────────────────────────────────────────────

class Chunk(TypedDict):
    id: str
    text: str
    section: str
    chunk_index: int


# ── Section splitting ────────────────────────────────────────────────────────

def split_into_sections(text: str) -> List[tuple]:
    """
    Split raw paper text into (section_name, section_text) pairs using
    heading detection. Falls back to a single "full_text" section if no
    headings are found.
    """
    matches = list(_SECTION_RE.finditer(text))
    if not matches:
        return [("full_text", text)]

    sections: List[tuple] = []
    for i, match in enumerate(matches):
        section_name = match.group(1).strip().lower()
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        section_text = text[start:end].strip()
        if section_text:
            sections.append((section_name, section_text))

    preamble = text[: matches[0].start()].strip()
    if preamble:
        sections.insert(0, ("preamble", preamble))

    return sections


# ── Chunking ─────────────────────────────────────────────────────────────────

def chunk_paper(text: str, paper_id: str) -> List[Chunk]:
    """Split full paper text into section-aware, overlapping chunks."""
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", " ", ""],
    )

    chunks: List[Chunk] = []
    idx = 0
    for section_name, section_text in split_into_sections(text):
        for piece in splitter.split_text(section_text):
            chunks.append(
                Chunk(id=f"{paper_id}_chunk_{idx}", text=piece, section=section_name, chunk_index=idx)
            )
            idx += 1

    logger.info("Chunked paper %s into %d chunks across sections", paper_id, idx)
    return chunks



# ── Vector store (lazy init) ────────────────────────────────────────────────
# Client/embedding function are created on first actual use, not at import
# time. This means importing this module (or anything that imports it, like
# plagiarism.py) never requires chromadb/sentence-transformers to be
# installed — only calling index_paper/retrieve/etc. does. Useful for unit
# testing pure logic (split_into_sections, chunk_paper) without the full
# dependency stack, and avoids crashing the whole app at startup if the
# vector store backend has a transient problem.

_client = None
_embedding_fn = None


def _get_client():
    global _client
    if _client is None:
        _client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)
    return _client


def _get_embedding_fn():
    global _embedding_fn
    if _embedding_fn is None:
        try:
            # Try SentenceTransformer if available (local dev)
            from chromadb.utils import embedding_functions
            _embedding_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
                model_name=EMBEDDING_MODEL_NAME
            )
        except Exception:
            # Fall back to chromadb's default embedding (no torch needed)
            _embedding_fn = chromadb.utils.embedding_functions.DefaultEmbeddingFunction()
    return _embedding_fn


def _collection_name(paper_id: str) -> str:
    return f"paper_{paper_id}"


def index_paper(paper_id: str, text: str) -> int:
    """Chunk + embed + upsert a paper into its own Chroma collection. Idempotent."""
    chunks = chunk_paper(text, paper_id)
    if not chunks:
        logger.warning("No chunks produced for paper %s", paper_id)
        return 0

    collection = _get_client().get_or_create_collection(
        name=_collection_name(paper_id), embedding_function=_get_embedding_fn()
    )
    collection.upsert(
        ids=[c["id"] for c in chunks],
        documents=[c["text"] for c in chunks],
        metadatas=[
            {"section": c["section"], "chunk_index": c["chunk_index"], "paper_id": paper_id}
            for c in chunks
        ],
    )
    logger.info("Indexed %d chunks for paper %s", len(chunks), paper_id)
    return len(chunks)


def retrieve(paper_id: str, query: str, k: int = 5, section_filter: Optional[str] = None) -> List[Chunk]:
    """Retrieve top-k relevant chunks for a paper given a natural-language query."""
    try:
        collection = _get_client().get_collection(name=_collection_name(paper_id), embedding_function=_get_embedding_fn())
    except Exception as exc:
        logger.error("No collection found for paper %s: %s", paper_id, exc)
        return []

    where = {"section": section_filter} if section_filter else None
    result = collection.query(query_texts=[query], n_results=k, where=where)

    if not result["ids"] or not result["ids"][0]:
        return []

    retrieved: List[Chunk] = []
    for doc_id, doc_text, meta in zip(result["ids"][0], result["documents"][0], result["metadatas"][0]):
        retrieved.append(
            Chunk(id=doc_id, text=doc_text, section=meta.get("section", "unknown"), chunk_index=meta.get("chunk_index", -1))
        )
    return retrieved


def retrieve_with_distances(paper_id: str, query_text: str, k: int = 3):
    """
    Like retrieve(), but returns real Chroma cosine distances alongside each
    chunk instead of just the chunk content. Used by plagiarism.py for a
    proper similarity score instead of the token-overlap approximation.
    Returns a list of (chunk_dict, distance) tuples, distance in [0, 2]
    (0 = identical, ~1 = orthogonal, 2 = opposite) for cosine space.
    """
    try:
        collection = _get_client().get_collection(name=_collection_name(paper_id), embedding_function=_get_embedding_fn())
    except Exception as exc:
        logger.error("No collection found for paper %s: %s", paper_id, exc)
        return []

    result = collection.query(query_texts=[query_text], n_results=k, include=["documents", "metadatas", "distances"])
    if not result["ids"] or not result["ids"][0]:
        return []

    out = []
    for doc_id, doc_text, meta, dist in zip(
        result["ids"][0], result["documents"][0], result["metadatas"][0], result["distances"][0]
    ):
        chunk = Chunk(id=doc_id, text=doc_text, section=meta.get("section", "unknown"), chunk_index=meta.get("chunk_index", -1))
        out.append((chunk, dist))
    return out


def list_sections(paper_id: str) -> List[str]:
    """Return the distinct section names available for a paper's chunks."""
    try:
        collection = _get_client().get_collection(name=_collection_name(paper_id), embedding_function=_get_embedding_fn())
    except Exception:
        return []
    data = collection.get(include=["metadatas"])
    return sorted({m.get("section", "unknown") for m in data.get("metadatas", [])})


def get_all_chunk_texts(paper_id: str) -> List[str]:
    """Return every chunk's raw text for a paper (used by the plagiarism scanner)."""
    try:
        collection = _get_client().get_collection(name=_collection_name(paper_id), embedding_function=_get_embedding_fn())
    except Exception:
        return []
    data = collection.get(include=["documents"])
    return data.get("documents", [])


def list_indexed_paper_ids(exclude: Optional[str] = None) -> List[str]:
    """Return paper_ids of every paper currently indexed (for cross-paper plagiarism checks)."""
    ids = []
    for coll in _get_client().list_collections():
        name = coll.name if hasattr(coll, "name") else coll
        if name.startswith("paper_"):
            pid = name[len("paper_"):]
            if pid != exclude:
                ids.append(pid)
    return ids


def delete_paper_index(paper_id: str) -> None:
    """Remove a paper's collection (e.g. on re-upload or cleanup)."""
    try:
        _get_client().delete_collection(name=_collection_name(paper_id))
    except Exception as exc:
        logger.warning("Could not delete collection for paper %s: %s", paper_id, exc)
