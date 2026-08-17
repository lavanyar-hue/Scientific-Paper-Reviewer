"""
Paper ingestion endpoints.

POST /api/papers/upload  — multipart PDF upload
POST /api/papers/arxiv   — fetch by arXiv ID
GET  /api/papers/list    — list user's papers
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.security import OAuth2PasswordBearer
from app.rate_limiter import limiter
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Paper
from app.schemas import ArxivRequest, PaperOut
from app.utils.arxiv_fetcher import fetch_arxiv_paper
from app.utils.pdf_parser import (
    extract_abstract,
    extract_images,
    extract_text,
    infer_research_field,
    truncate_for_llm,
)
# chunking and cnn_figures are imported lazily inside _index_and_analyze()
# below, not at module load time — this keeps app startup memory low on
# constrained deployment tiers, and ENABLE_CNN_FIGURES lets you skip the
# ~1GB+ torch/torchvision footprint entirely on a free-tier host. See
# DEPLOYMENT.md.
import os
ENABLE_CNN_FIGURES = os.getenv("ENABLE_CNN_FIGURES", "true").lower() == "true"

logger = logging.getLogger(__name__)
router = APIRouter()


def _index_and_analyze(paper_id: str, full_text: str, pdf_bytes: Optional[bytes]) -> None:
    """
    Chunk+embed the paper for RAG retrieval, and run CNN figure analysis if
    the raw PDF bytes are available. Best-effort — logs and continues on
    failure rather than blocking the upload response.

    Imports are lazy (not at module top) so a deployment with
    ENABLE_CNN_FIGURES=false never pays the torch/torchvision import cost
    at all — meaningful on a memory-constrained free tier. See DEPLOYMENT.md.
    """
    from app.utils import chunking

    try:
        chunking.index_paper(paper_id, full_text)
    except Exception as exc:
        logger.error("Failed to index paper %s for RAG: %s", paper_id, exc)

    if pdf_bytes is not None and ENABLE_CNN_FIGURES:
        try:
            from app.utils import cnn_figures
            images = extract_images(pdf_bytes)
            if images:
                analyses = cnn_figures.analyze_paper_figures(images)
                duplicates = cnn_figures.find_duplicate_figures(analyses)
                logger.info(
                    "Paper %s: analyzed %d figures, %d potential duplicates",
                    paper_id, len(analyses), len(duplicates),
                )
        except Exception as exc:
            logger.error("Figure analysis failed for paper %s: %s", paper_id, exc)
    elif pdf_bytes is not None and not ENABLE_CNN_FIGURES:
        logger.info("Skipping figure analysis for paper %s — ENABLE_CNN_FIGURES=false", paper_id)

MAX_PDF_SIZE = 50 * 1024 * 1024  # 50 MB

# optional auth - won't fail if no token provided
oauth2_optional = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


def _get_optional_user(token: Optional[str] = Depends(oauth2_optional), db: Session = Depends(get_db)):
    if not token:
        return None
    try:
        from app.routers.auth import get_current_user
        import jwt
        from app.utils.security import SECRET_KEY, ALGORITHM
        from app.models import User
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if username:
            return db.query(User).filter(User.username == username).first()
    except Exception:
        pass
    return None


@router.post("/upload", response_model=PaperOut)
@limiter.limit("10/minute")
async def upload_pdf(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user=Depends(_get_optional_user),
):
    """Upload a PDF and extract its text."""
    pdf_bytes = await file.read()
    if len(pdf_bytes) > MAX_PDF_SIZE:
        raise HTTPException(413, "PDF exceeds 50 MB limit.")
    if len(pdf_bytes) < 1024:
        raise HTTPException(400, "File appears to be empty or too small.")
    # Magic-byte check: a .pdf extension proves nothing about actual content —
    # verify the file starts with the real PDF header before parsing it.
    if not pdf_bytes.startswith(b"%PDF-"):
        raise HTTPException(400, "File does not appear to be a valid PDF (missing %PDF header).")

    try:
        content = extract_text(pdf_bytes)
    except ValueError as exc:
        raise HTTPException(422, str(exc))

    abstract = extract_abstract(content)
    research_field = infer_research_field(content)
    filename = file.filename or "uploaded_paper.pdf"
    title = filename.replace(".pdf", "").replace("_", " ").replace("-", " ")

    paper = Paper(
        title=title,
        content=truncate_for_llm(content),
        abstract=abstract,
        research_field=research_field,
        user_id=current_user.id if current_user else None,
    )
    db.add(paper)
    db.commit()
    db.refresh(paper)
    logger.info("Paper uploaded: id=%s title=%s user=%s", paper.id, paper.title, current_user.id if current_user else "anon")

    _index_and_analyze(paper.id, content, pdf_bytes)

    return paper


@router.post("/arxiv", response_model=PaperOut)
async def fetch_arxiv(
    body: ArxivRequest,
    db: Session = Depends(get_db),
    current_user=Depends(_get_optional_user),
):
    """Fetch a paper from arXiv by ID and store it."""
    arxiv_id = body.arxiv_id.strip()

    existing = db.query(Paper).filter(Paper.arxiv_id == arxiv_id).first()
    if existing:
        logger.info("arXiv paper already in DB: %s", arxiv_id)
        return existing

    try:
        data = await fetch_arxiv_paper(arxiv_id)
    except Exception as exc:
        logger.error("arXiv fetch failed for %s: %s", arxiv_id, exc)
        raise HTTPException(502, f"Failed to fetch arXiv paper: {exc}")

    paper = Paper(
        arxiv_id=data["arxiv_id"],
        title=data["title"],
        authors=data["authors"],
        abstract=data["abstract"],
        pdf_url=data["pdf_url"],
        content=truncate_for_llm(data["content"]),
        research_field=data["research_field"],
        user_id=current_user.id if current_user else None,
    )
    db.add(paper)
    db.commit()
    db.refresh(paper)
    logger.info("arXiv paper stored: id=%s title=%s", paper.id, paper.title)

    # arXiv fetcher returns extracted text only, not raw PDF bytes, so figure
    # analysis is skipped for this path — text indexing still runs.
    _index_and_analyze(paper.id, data["content"], pdf_bytes=None)

    return paper


@router.get("/list")
async def list_papers(
    db: Session = Depends(get_db),
    current_user=Depends(_get_optional_user),
):
    """Return all papers belonging to the current user."""
    if not current_user:
        return {"papers": []}
    papers = (
        db.query(Paper)
        .filter(Paper.user_id == current_user.id)
        .order_by(Paper.created_at.desc())
        .limit(50)
        .all()
    )
    return {
        "papers": [
            {
                "id": p.id,
                "title": p.title or "Untitled",
                "authors": p.authors or "Unknown",
                "abstract": p.abstract,
                "research_field": p.research_field,
                "created_at": p.created_at.isoformat(),
            }
            for p in papers
        ]
    }


@router.delete("/{paper_id}")
async def delete_paper(
    paper_id: str,
    db: Session = Depends(get_db),
    current_user=Depends(_get_optional_user),
):
    """Delete a paper and all its associated review jobs."""
    if not current_user:
        raise HTTPException(401, "Authentication required.")
    paper = db.query(Paper).filter(Paper.id == paper_id, Paper.user_id == current_user.id).first()
    if not paper:
        raise HTTPException(404, "Paper not found or access denied.")

    # Delete associated review jobs (cascades to agent responses via DB relationships)
    from app.models import ReviewJob, AgentResponse
    jobs = db.query(ReviewJob).filter(ReviewJob.paper_id == paper_id).all()
    for job in jobs:
        db.query(AgentResponse).filter(AgentResponse.job_id == job.id).delete()
        db.delete(job)

    db.delete(paper)
    db.commit()
    return {"ok": True, "message": "Paper deleted."}