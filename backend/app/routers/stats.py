"""Fully dynamic stats & history endpoints — zero mock data."""
from datetime import datetime, timedelta
from typing import Any, List

from fastapi import APIRouter, Depends
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import AgentResponse, Paper, ReviewJob, User
from app.routers.auth import get_current_user
from app.utils import observability

router = APIRouter(prefix="/api/stats", tags=["stats"])


# ── User stats ─────────────────────────────────────────────────────────────────

@router.get("/user")
def get_user_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Any:
    total_reviews = db.query(ReviewJob).filter(ReviewJob.user_id == current_user.id).count()
    total_papers = db.query(Paper).filter(Paper.user_id == current_user.id).count()

    avg_score_q = (
        db.query(func.avg(ReviewJob.score))
        .filter(ReviewJob.user_id == current_user.id, ReviewJob.status == "completed")
        .scalar()
    )
    avg_score = round(float(avg_score_q), 1) if avg_score_q else 0.0

    completed = (
        db.query(ReviewJob)
        .filter(ReviewJob.user_id == current_user.id, ReviewJob.status == "completed")
        .count()
    )

    # Average processing time in seconds
    jobs_with_times = (
        db.query(ReviewJob)
        .filter(
            ReviewJob.user_id == current_user.id,
            ReviewJob.status == "completed",
            ReviewJob.completed_at.isnot(None),
        )
        .all()
    )
    if jobs_with_times:
        total_secs = sum(
            (j.completed_at - j.created_at).total_seconds() for j in jobs_with_times
        )
        avg_secs = total_secs / len(jobs_with_times)
        mins, secs = divmod(int(avg_secs), 60)
        avg_time = f"{mins}m {secs}s"
    else:
        avg_time = "N/A"

    return {
        "total_reviews": total_reviews,
        "total_papers": total_papers,
        "completed_reviews": completed,
        "average_score": avg_score,
        "average_time": avg_time,
        "username": current_user.username,
        "email": current_user.email,
        "is_admin": current_user.is_admin,
        "member_since": current_user.created_at.isoformat(),
    }


# ── Chart data: real per-review scores ─────────────────────────────────────────

@router.get("/charts")
def get_chart_data(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Any:
    jobs = (
        db.query(ReviewJob)
        .filter(
            ReviewJob.user_id == current_user.id,
            ReviewJob.status == "completed",
            ReviewJob.score.isnot(None),
        )
        .order_by(ReviewJob.created_at.asc())
        .limit(15)
        .all()
    )
    score_trend = []
    for job in jobs:
        paper = db.query(Paper).filter(Paper.id == job.paper_id).first()
        label = (paper.title[:25] + "…") if paper and paper.title else job.id[:8]
        score_trend.append({"name": label, "score": round(job.score, 1)})

    return {"score_trend": score_trend}


# ── Timeline / Activity history ────────────────────────────────────────────────

@router.get("/activity")
def get_activity(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Any:
    """Return real activity timeline for the logged-in user."""

    events: List[dict] = []

    # Papers uploaded by this user
    papers = (
        db.query(Paper)
        .filter(Paper.user_id == current_user.id)
        .order_by(Paper.created_at.desc())
        .limit(50)
        .all()
    )
    for p in papers:
        # Find the latest job for this paper to get job_id for linking
        latest_job = (
            db.query(ReviewJob)
            .filter(ReviewJob.paper_id == p.id)
            .order_by(ReviewJob.created_at.desc())
            .first()
        )
        events.append(
            {
                "id": f"paper-{p.id}",
                "type": "upload",
                "icon": "file",
                "color": "blue",
                "title": "Paper Uploaded",
                "subtitle": p.title or "Untitled Paper",
                "user": current_user.username,
                "timestamp": p.created_at.isoformat(),
                "job_id": latest_job.id if latest_job else None,
            }
        )

    # Review jobs for this user
    jobs = (
        db.query(ReviewJob)
        .filter(ReviewJob.user_id == current_user.id)
        .order_by(ReviewJob.created_at.desc())
        .limit(50)
        .all()
    )
    for job in jobs:
        paper = db.query(Paper).filter(Paper.id == job.paper_id).first()
        paper_title = (paper.title or "Untitled") if paper else "Unknown"

        events.append(
            {
                "id": f"job-start-{job.id}",
                "type": "review_started",
                "icon": "bot",
                "color": "indigo",
                "title": "AI Review Started",
                "subtitle": paper_title,
                "user": "System",
                "timestamp": job.created_at.isoformat(),
                "job_id": job.id,
            }
        )

        # Agent responses for this job
        for ar in (
            db.query(AgentResponse)
            .filter(AgentResponse.job_id == job.id)
            .order_by(AgentResponse.created_at.asc())
            .all()
        ):
            role_label = {
                "primary": "Primary Reviewer",
                "critic": "Critic Agent",
                "synthesizer": "Synthesis Agent",
            }.get(ar.agent_role, ar.agent_role)
            color = "emerald" if ar.status == "completed" else "red"
            events.append(
                {
                    "id": f"ar-{ar.id}",
                    "type": "agent_response",
                    "icon": "check" if ar.status == "completed" else "alert",
                    "color": color,
                    "title": f"{role_label} ({ar.group})",
                    "subtitle": f"Model: {ar.model_name or 'unknown'}",
                    "user": role_label,
                    "timestamp": ar.created_at.isoformat(),
                }
            )

        if job.completed_at:
            events.append(
                {
                    "id": f"job-done-{job.id}",
                    "type": "review_completed",
                    "icon": "check_circle",
                    "color": "emerald",
                    "title": "Review Completed" if job.status == "completed" else "Review Failed",
                    "subtitle": f"Score: {round(job.score, 1) if job.score else 'N/A'}",
                    "user": "System",
                    "timestamp": job.completed_at.isoformat(),
                }
            )

    # Sort all events by timestamp descending
    events.sort(key=lambda e: e["timestamp"], reverse=True)

    # Group by date
    grouped: dict[str, list] = {}
    today = datetime.utcnow().date()
    yesterday = today - timedelta(days=1)

    for event in events[:80]:  # cap at 80
        dt = datetime.fromisoformat(event["timestamp"]).date()
        # Convert UTC to IST (UTC+5:30) for grouping
        from datetime import timezone, timedelta as _td
        ist_offset = _td(hours=5, minutes=30)
        ist_dt = datetime.fromisoformat(event["timestamp"]).replace(tzinfo=timezone.utc) + ist_offset
        dt = ist_dt.date()
        today_ist = (datetime.utcnow().replace(tzinfo=timezone.utc) + ist_offset).date()
        yesterday_ist = today_ist - timedelta(days=1)
        if dt == today_ist:
            label = "Today"
        elif dt == yesterday_ist:
            label = "Yesterday"
        else:
            label = dt.strftime("%b %d")
        grouped.setdefault(label, []).append(event)

    return {"groups": [{"date": k, "events": v} for k, v in grouped.items()]}


# ── Paper list for dashboard ────────────────────────────────────────────────────

@router.get("/papers")
def get_user_papers(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Any:
    """Return enriched paper list with latest review job info."""
    papers = (
        db.query(Paper)
        .filter(Paper.user_id == current_user.id)
        .order_by(Paper.created_at.desc())
        .limit(20)
        .all()
    )

    result = []
    for paper in papers:
        latest_job = (
            db.query(ReviewJob)
            .filter(ReviewJob.paper_id == paper.id)
            .order_by(ReviewJob.created_at.desc())
            .first()
        )

        # Count versions (number of jobs for this paper)
        version = db.query(ReviewJob).filter(ReviewJob.paper_id == paper.id).count()

        # Map status to progress
        status_map = {
            "queued": ("Uploaded", 5),
            "processing": ("Reviewing", 55),
            "completed": ("Completed", 100),
            "failed": ("Failed", 100),
        }
        if latest_job:
            status_label, progress = status_map.get(latest_job.status, ("Unknown", 0))
        else:
            status_label, progress = "Uploaded", 5

        # Agent count for confidence score proxy
        agent_count = 0
        confidence = None
        if latest_job:
            agent_count = (
                db.query(AgentResponse)
                .filter(
                    AgentResponse.job_id == latest_job.id,
                    AgentResponse.status == "completed",
                )
                .count()
            )
            if latest_job.score:
                confidence = min(99, int(latest_job.score * 10))

        result.append(
            {
                "id": paper.id,
                "title": paper.title or "Untitled Paper",
                "authors": paper.authors or "Unknown Authors",
                "tag": paper.research_field or "General",
                "version": f"v{max(1, version)}.0",
                "status": status_label,
                "progress": progress,
                "agent": latest_job.model_config.get("synthesizer", "Orchestrator") if latest_job and latest_job.model_config else "—",
                "confidence": confidence,
                "score": round(latest_job.score, 1) if latest_job and latest_job.score else None,
                "job_id": latest_job.id if latest_job else None,
                "last_updated": (latest_job.created_at if latest_job else paper.created_at).isoformat(),
            }
        )

    return {"papers": result}


# ── Admin stats ─────────────────────────────────────────────────────────────────

@router.get("/admin")
def get_admin_stats(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Any:
    if not current_user.is_admin:
        return {"error": "Not authorized"}

    total_reviews = db.query(ReviewJob).count()
    total_users = db.query(User).count()
    total_papers = db.query(Paper).count()

    completed = db.query(ReviewJob).filter(ReviewJob.status == "completed").count()
    failed = db.query(ReviewJob).filter(ReviewJob.status == "failed").count()
    processing = db.query(ReviewJob).filter(ReviewJob.status == "processing").count()

    success_rate = round((completed / total_reviews * 100), 1) if total_reviews > 0 else 0.0

    avg_score_q = (
        db.query(func.avg(ReviewJob.score))
        .filter(ReviewJob.status == "completed")
        .scalar()
    )
    avg_score = round(float(avg_score_q), 1) if avg_score_q else 0.0

    # Unique models used
    models_used = (
        db.query(AgentResponse.model_name)
        .filter(AgentResponse.model_name.isnot(None))
        .distinct()
        .all()
    )
    active_models = [m[0] for m in models_used]

    # Real daily review counts for last 7 days
    daily_reviews = []
    day_names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    for i in range(6, -1, -1):
        day = datetime.utcnow().date() - timedelta(days=i)
        count = db.query(ReviewJob).filter(
            func.date(ReviewJob.created_at) == day
        ).count()
        daily_reviews.append({
            "name": day_names[day.weekday()],
            "reviews": count,
            "date": day.isoformat(),
        })

    return {
        "total_reviews": total_reviews,
        "total_users": total_users,
        "total_papers": total_papers,
        "completed_reviews": completed,
        "failed_reviews": failed,
        "processing_reviews": processing,
        "success_rate": success_rate,
        "average_score": avg_score,
        "active_models": active_models,
        "active_model_count": len(active_models),
        "daily_reviews": daily_reviews,
    }


# ── Cost / latency dashboard ────────────────────────────────────────────────

@router.get("/cost-dashboard")
async def cost_dashboard(job_limit: int = 200, db: Session = Depends(get_db)) -> dict:
    """
    Aggregates observability trace events (see utils/observability.py) across
    recent review jobs into per-model and per-role cost/latency stats.

    HONEST SCOPE NOTE: tool_loop path (agentic RAG with real tool-calling)
    only logs cost/tokens for its FINAL call today, not every intermediate
    retrieve-reason step — so tool_loop costs shown here are a lower bound,
    not exact. plain_text and simple_rag paths are fully accounted for.
    Extending per-step cost tracking inside the agentic loop is a natural
    next improvement (see PLACEMENT_UPGRADES.md).
    """
    recent_jobs = (
        db.query(ReviewJob.id)
        .order_by(ReviewJob.created_at.desc())
        .limit(job_limit)
        .all()
    )
    job_ids = [j.id for j in recent_jobs]

    per_model: dict = {}
    per_role: dict = {}
    total_cost = 0.0
    total_calls = 0
    latencies: List[float] = []

    for job_id in job_ids:
        events = observability.get_trace_for_job(job_id)
        for e in events:
            if e["event_type"] == "llm_call":
                data = e.get("data", {})
                model = data.get("model", "unknown")
                role = e.get("agent_role", "unknown")
                cost = data.get("estimated_cost_usd", 0.0) or 0.0
                total_cost += cost
                total_calls += 1

                m = per_model.setdefault(model, {"calls": 0, "total_cost_usd": 0.0, "input_tokens": 0, "output_tokens": 0, "estimated_token_calls": 0})
                m["calls"] += 1
                m["total_cost_usd"] += cost
                m["input_tokens"] += data.get("input_tokens", 0) or 0
                m["output_tokens"] += data.get("output_tokens", 0) or 0
                if data.get("tokens_are_estimated"):
                    m["estimated_token_calls"] += 1

                r = per_role.setdefault(role, {"calls": 0, "total_cost_usd": 0.0})
                r["calls"] += 1
                r["total_cost_usd"] += cost

            elif e["event_type"] in ("node_end", "node_error") and e.get("duration_ms"):
                latencies.append(e["duration_ms"])

    for m in per_model.values():
        m["total_cost_usd"] = round(m["total_cost_usd"], 4)
    for r in per_role.values():
        r["total_cost_usd"] = round(r["total_cost_usd"], 4)

    avg_latency_ms = round(sum(latencies) / len(latencies), 1) if latencies else None

    return {
        "jobs_analyzed": len(job_ids),
        "total_llm_calls": total_calls,
        "total_estimated_cost_usd": round(total_cost, 4),
        "avg_node_latency_ms": avg_latency_ms,
        "per_model": per_model,
        "per_role": per_role,
        "scope_note": (
            "tool_loop (agentic RAG) path currently logs cost for its final call only, "
            "not every intermediate retrieval step — costs shown are a lower bound for "
            "papers reviewed via that path. plain_text and simple_rag paths are fully counted."
        ),
    }