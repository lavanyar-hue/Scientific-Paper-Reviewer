"""
Review endpoints.

POST /api/review              — create a new review job
GET  /api/review/{job_id}     — poll job status + results
WS   /ws/review/{job_id}      — real-time progress stream
GET  /api/history             — list past review jobs
"""

import json
import logging
import threading
import time as _time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from app.rate_limiter import limiter
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AgentResponse, IntegrityCheck, Paper, ReviewJob, RetrievalTrace
from app.schemas import ModelConfig, ReviewJobOut, ReviewJobSummary, ReviewRequest
from app.ws_manager import manager
from app.utils import plagiarism
from app.utils import observability

logger = logging.getLogger(__name__)
router = APIRouter()

# Track cancellation requests: job_id -> True means cancel requested
_cancel_flags: dict[str, bool] = {}


def is_cancelled(job_id: str) -> bool:
    return _cancel_flags.get(job_id, False)


def _estimate_review_time(paper_content: str, model_config: dict) -> dict:
    """
    Estimate how long the review will take based on paper length and models selected.
    Returns a dict with estimated_seconds and display string.
    """
    char_count = len(paper_content) if paper_content else 0

    # Base time per model API call (seconds) — rough empirical values
    MODEL_LATENCY = {
        "gemini": 15,
        "claude": 20,
        "gpt": 25,
        "llama": 12,
        "mistral": 18,
        "groq": 8,
        "ollama": 30,
    }

    def _model_latency(model_name: Optional[str]) -> int:
        if not model_name:
            return 15
        m = model_name.lower()
        for key, val in MODEL_LATENCY.items():
            if key in m:
                return val
        return 20

    # Get latencies for each role
    a_primary_lat = _model_latency(model_config.get("group_a_primary"))
    b_primary_lat = _model_latency(model_config.get("group_b_primary"))
    a_critic_lat  = _model_latency(model_config.get("group_a_critic"))
    b_critic_lat  = _model_latency(model_config.get("group_b_critic"))
    synth_lat     = _model_latency(model_config.get("synthesizer"))

    # Agentic mode: each primary/critic does up to 4 tool calls (reduced from 6)
    agentic_factor = 3.5 if char_count > 5000 else 2.0

    # Pipeline: A-primary + B-primary run in parallel, then A-critic + B-critic in parallel, then synth
    # Layer 1: max(a_primary, b_primary)
    # Layer 2: max(a_critic, b_critic)
    # Layer 3: synth
    layer1 = max(a_primary_lat, b_primary_lat) * agentic_factor
    layer2 = max(a_critic_lat, b_critic_lat) * agentic_factor
    layer3 = synth_lat * 1.5  # synth is not agentic

    integrity_time = 10  # integrity check runs in parallel with layer 1 now

    # Total critical path
    estimated_seconds = int(layer1 + layer2 + layer3 + integrity_time + 10)  # +10s buffer

    if estimated_seconds < 60:
        display = f"~{estimated_seconds}s"
    elif estimated_seconds < 120:
        display = f"~1–2 min"
    elif estimated_seconds < 180:
        display = f"~2–3 min"
    elif estimated_seconds < 300:
        display = f"~3–5 min"
    else:
        display = f"~{estimated_seconds // 60}–{estimated_seconds // 60 + 1} min"

    return {"estimated_seconds": estimated_seconds, "display": display}


# ── Background task ────────────────────────────────────────────────────────────

def _run_review_task(job_id: str, db_url: str, model_config_dict: dict):
    """
    Runs the LangGraph pipeline in a background thread.
    Creates its own DB session since SQLite connections aren't thread-safe across sessions.
    Integrity checks now run in parallel with the first reviewer wave for speed.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    connect_args = {"check_same_thread": False} if db_url.startswith("sqlite") else {}
    engine = create_engine(db_url, connect_args=connect_args)
    ThreadSession = sessionmaker(bind=engine)
    db: Session = ThreadSession()

    job: Optional[ReviewJob] = None
    try:
        job = db.query(ReviewJob).filter(ReviewJob.id == job_id).first()
        if not job:
            logger.error("Job not found: %s", job_id)
            return

        paper = db.query(Paper).filter(Paper.id == job.paper_id).first()
        if not paper:
            logger.error("Paper not found for job %s", job_id)
            job.status = "failed"
            job.error_message = "Paper record not found."
            db.commit()
            return

        job.status = "processing"
        db.commit()
        manager.broadcast_sync(job_id, {"event": "status", "job_id": job_id, "data": {"status": "processing"}})

        # Check if already cancelled before starting
        if is_cancelled(job_id):
            job.status = "failed"
            job.error_message = "Cancelled by user."
            job.completed_at = datetime.utcnow()
            db.commit()
            manager.broadcast_sync(job_id, {"event": "job_failed", "job_id": job_id, "data": {"error_message": "Cancelled by user."}})
            return

        # ── Integrity checks run in a separate thread, parallel with review pipeline ──
        integrity_report_str = None
        integrity_future_result = {}

        def _run_integrity():
            try:
                from app.agents.llm_clients import get_model_for_role
                judge_llm, _ = get_model_for_role("synthesizer", model_config_dict.get("synthesizer"))
                report = plagiarism.run_integrity_checks(paper.id, paper.content, llm=judge_llm)
                integrity_future_result["report"] = report
                if report["flags"]:
                    manager.broadcast_sync(
                        job_id,
                        {"event": "integrity_flags", "job_id": job_id, "data": {"flags": report["flags"]}},
                    )
            except Exception as exc:
                logger.warning("Integrity checks failed for job %s (continuing): %s", job_id, exc)
                integrity_future_result["error"] = str(exc)

        integrity_thread = threading.Thread(target=_run_integrity, daemon=True)
        integrity_thread.start()

        # ── DB callback invoked by each agent node right after completion ────
        def db_callback(
            job_id: str,
            group: str,
            agent_role: str,
            model_name: str,
            response: Optional[dict],
            error_message: Optional[str],
        ):
            ar = AgentResponse(
                job_id=job_id,
                group=group,
                agent_role=agent_role,
                model_name=model_name,
                response=response,
                status="failed" if error_message else "completed",
                error_message=error_message,
            )
            db.add(ar)
            db.commit()
            db.refresh(ar)

            payload = {
                "event": "agent_complete",
                "job_id": job_id,
                "data": {
                    "id": ar.id,
                    "group": group,
                    "agent_role": agent_role,
                    "model_name": model_name,
                    "status": ar.status,
                    "response": response,
                    "error_message": error_message,
                    "created_at": ar.created_at.isoformat(),
                },
            }
            manager.broadcast_sync(job_id, payload)
            logger.info("Agent complete: job=%s group=%s role=%s", job_id, group, agent_role)

        # ── Wait for integrity check before synthesizer (it should be done by then) ─
        integrity_thread.join(timeout=90)  # don't block forever
        report = integrity_future_result.get("report")
        if report:
            try:
                ic = IntegrityCheck(
                    paper_id=paper.id,
                    max_similarity=report["max_similarity"],
                    similarity_matches=report["similarity_matches"],
                    ai_text_heuristic_score=report["ai_text_heuristic_score"],
                    ai_text_llm_judgment=report["ai_text_llm_judgment"],
                    flags=report["flags"],
                )
                db.add(ic)
                db.commit()
                integrity_report_str = plagiarism.report_to_prompt_string(report)
            except Exception as exc:
                logger.warning("Failed to save integrity check: %s", exc)

        # ── Run LangGraph ─────────────────────────────────────────────────────
        # Check cancellation one more time before the expensive LLM calls start
        if is_cancelled(job_id):
            job.status = "failed"
            job.error_message = "Cancelled by user."
            job.completed_at = datetime.utcnow()
            db.commit()
            manager.broadcast_sync(job_id, {"event": "job_failed", "job_id": job_id, "data": {"error_message": "Cancelled by user."}})
            return

        from app.agents.orchestrator import run_review

        final_state = run_review(
            job_id=job_id,
            paper_id=paper.id,
            paper_title=paper.title or "Untitled",
            authors=paper.authors or "Unknown",
            paper_full_text=paper.content,
            research_field=paper.research_field or "computer science / general",
            model_config=model_config_dict,
            db_callback=db_callback,
            integrity_report=integrity_report_str,
        )

        # Persist retrieval traces
        for agent_role, steps in (final_state.get("retrieval_traces") or {}).items():
            for i, step in enumerate(steps):
                db.add(
                    RetrievalTrace(
                        job_id=job_id,
                        agent_role=agent_role,
                        step_index=i,
                        query=step.get("query", ""),
                        section_filter=step.get("section_filter"),
                        retrieved_chunk_ids=step.get("retrieved_chunk_ids"),
                        retrieved_sections=step.get("retrieved_sections"),
                    )
                )
        db.commit()

        job.final_review = final_state.get("final_review")
        job.status = "completed" if final_state.get("final_review") else "failed"
        if final_state.get("errors"):
            job.error_message = "; ".join(final_state["errors"])
        job.completed_at = datetime.utcnow()
        db.commit()

        manager.broadcast_sync(
            job_id,
            {
                "event": "job_complete" if job.status == "completed" else "job_failed",
                "job_id": job_id,
                "data": {
                    "status": job.status,
                    "final_review": job.final_review,
                    "error_message": job.error_message,
                },
            },
        )

    except Exception as exc:
        logger.exception("Unhandled error in review task for job %s: %s", job_id, exc)
        if job:
            job.status = "failed"
            job.error_message = str(exc)
            job.completed_at = datetime.utcnow()
            db.commit()
            manager.broadcast_sync(
                job_id,
                {"event": "job_failed", "job_id": job_id, "data": {"error_message": str(exc)}},
            )
    finally:
        db.close()


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/review", response_model=ReviewJobOut)
@limiter.limit("5/minute")
async def create_review(
    request: Request,
    body: ReviewRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Create a review job and kick it off as a background task."""
    paper = db.query(Paper).filter(Paper.id == body.paper_id).first()
    if not paper:
        raise HTTPException(404, "Paper not found.")

    mc = body.ai_model_config or ModelConfig()
    mc_dict = {
        "group_a_primary": mc.group_a_primary,
        "group_a_critic":  mc.group_a_critic,
        "group_b_primary": mc.group_b_primary,
        "group_b_critic":  mc.group_b_critic,
        "synthesizer":     mc.synthesizer,
    }

    # Estimate time and include in job metadata
    estimate = _estimate_review_time(paper.content or "", mc_dict)

    job = ReviewJob(paper_id=paper.id, status="queued", model_config=mc_dict)
    db.add(job)
    db.commit()
    db.refresh(job)

    # Broadcast time estimate immediately
    manager.broadcast_sync(job.id, {
        "event": "time_estimate",
        "job_id": job.id,
        "data": estimate,
    })

    import os
    db_url = os.getenv("DATABASE_URL", "sqlite:///./PaperLens.db")

    t = threading.Thread(
        target=_run_review_task,
        args=(job.id, db_url, mc_dict),
        daemon=True,
    )
    t.start()

    db.refresh(job)
    # Attach estimate to response via extra field
    job_out = ReviewJobOut.from_orm(job)
    return job_out


@router.post("/review/{job_id}/cancel")
async def cancel_review(job_id: str, db: Session = Depends(get_db)):
    """Cancel a running review job."""
    job = db.query(ReviewJob).filter(ReviewJob.id == job_id).first()
    if not job:
        raise HTTPException(404, "Review job not found.")
    if job.status not in ("queued", "processing"):
        raise HTTPException(400, f"Job is already {job.status} — cannot cancel.")

    _cancel_flags[job_id] = True
    job.status = "failed"
    job.error_message = "Cancelled by user."
    job.completed_at = datetime.utcnow()
    db.commit()

    manager.broadcast_sync(job_id, {
        "event": "job_failed",
        "job_id": job_id,
        "data": {"error_message": "Cancelled by user."},
    })
    return {"ok": True, "message": "Review cancelled."}


@router.get("/review/{job_id}/estimate")
async def get_review_estimate(job_id: str, db: Session = Depends(get_db)):
    """Return estimated time and current elapsed time for a review job."""
    job = db.query(ReviewJob).filter(ReviewJob.id == job_id).first()
    if not job:
        raise HTTPException(404, "Review job not found.")

    paper = db.query(Paper).filter(Paper.id == job.paper_id).first()
    estimate = _estimate_review_time(paper.content or "" if paper else "", job.model_config or {})

    elapsed_seconds = None
    if job.created_at:
        elapsed_seconds = int((datetime.utcnow() - job.created_at).total_seconds())

    done_count = sum(1 for r in job.agent_responses if r.status == "completed")
    progress_pct = int((done_count / 5) * 100)

    return {
        "job_id": job_id,
        "status": job.status,
        "estimated_seconds": estimate["estimated_seconds"],
        "estimated_display": estimate["display"],
        "elapsed_seconds": elapsed_seconds,
        "progress_pct": progress_pct,
        "agents_done": done_count,
        "agents_total": 5,
    }


@router.get("/review/{job_id}", response_model=ReviewJobOut)
async def get_review(job_id: str, db: Session = Depends(get_db)):
    """Poll current job status and any completed agent responses."""
    job = db.query(ReviewJob).filter(ReviewJob.id == job_id).first()
    if not job:
        raise HTTPException(404, "Review job not found.")
    return job


@router.get("/review/{job_id}/trace")
async def get_review_trace(job_id: str) -> dict:
    """
    Return the full structured event trace for a review job.
    """
    events = observability.get_trace_for_job(job_id)
    if not events:
        raise HTTPException(status_code=404, detail=f"No trace found for job_id={job_id}")
    summary = observability.summarize_job(job_id)
    return {"job_id": job_id, "summary": summary, "events": events}


@router.get("/history", response_model=List[ReviewJobSummary])
async def list_history(db: Session = Depends(get_db)):
    """Return all past review jobs (most recent first) — single optimised query."""
    from sqlalchemy.orm import joinedload

    jobs = (
        db.query(ReviewJob)
        .options(joinedload(ReviewJob.paper))  # eager-load paper to avoid N+1
        .order_by(ReviewJob.created_at.desc())
        .limit(100)
        .all()
    )

    summaries = []
    for job in jobs:
        paper = job.paper
        final_rec = None
        overall = None
        if job.final_review:
            final_rec = job.final_review.get("final_recommendation")
            scores = job.final_review.get("final_scores", {})
            overall = scores.get("overall")
        summaries.append(
            ReviewJobSummary(
                id=job.id,
                paper_id=job.paper_id,
                status=job.status,
                paper_title=paper.title if paper else None,
                final_recommendation=final_rec,
                overall_score=overall,
                created_at=job.created_at,
                completed_at=job.completed_at,
            )
        )
    return summaries


# ── WebSocket ──────────────────────────────────────────────────────────────────

@router.websocket("/ws/review/{job_id}")
async def ws_review(job_id: str, websocket: WebSocket, db: Session = Depends(get_db)):
    await manager.connect(job_id, websocket)
    try:
        job = db.query(ReviewJob).filter(ReviewJob.id == job_id).first()
        if job:
            # Send time estimate on connect
            if job.paper_id:
                paper = db.query(Paper).filter(Paper.id == job.paper_id).first()
                estimate = _estimate_review_time(paper.content or "" if paper else "", job.model_config or {})
                elapsed = int((datetime.utcnow() - job.created_at).total_seconds()) if job.created_at else 0
                await websocket.send_text(json.dumps({
                    "event": "time_estimate",
                    "job_id": job_id,
                    "data": {**estimate, "elapsed_seconds": elapsed},
                }))

            # Replay any already-completed agent responses
            for ar in job.agent_responses:
                await websocket.send_text(
                    json.dumps({
                        "event": "agent_complete",
                        "job_id": job_id,
                        "data": {
                            "id": ar.id,
                            "group": ar.group,
                            "agent_role": ar.agent_role,
                            "model_name": ar.model_name,
                            "status": ar.status,
                            "response": ar.response,
                            "error_message": ar.error_message,
                            "created_at": ar.created_at.isoformat(),
                        },
                    })
                )
            if job.status in ("completed", "failed"):
                await websocket.send_text(
                    json.dumps({
                        "event": "job_complete" if job.status == "completed" else "job_failed",
                        "job_id": job_id,
                        "data": {
                            "status": job.status,
                            "final_review": job.final_review,
                            "error_message": job.error_message,
                        },
                    })
                )

        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(job_id, websocket)