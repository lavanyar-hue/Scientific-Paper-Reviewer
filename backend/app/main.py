"""PaperLens FastAPI application entry point."""

# Load .env FIRST — before any other import reads os.environ
from dotenv import load_dotenv
load_dotenv()

import asyncio
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.database import create_tables
from app.rate_limiter import limiter
from app.routers import review, papers, auth, stats, profile, finetune, chat
from app.routers import related as related_router

app = FastAPI(
    title="Scientific Paper Reviewer",
    description="Multi-agent AI system for scientific paper peer review — 5 agents, RAG retrieval, integrity checks",
    version="1.0.0",
)

# ── Rate limiting ────────────────────────────────────────────────────────────
# Defaults are conservative for a free/demo deployment — each LLM-backed
# review costs real money/quota, so unauthenticated abuse needs a low
# ceiling. Adjust via env vars if you have paid capacity to spare.
# Endpoint-specific stricter limits (upload, review) live in their routers.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ── CORS ─────────────────────────────────────────────────────────────────────
# Production frontend URL is read from an env var so a deployed instance
# doesn't need code changes — just set FRONTEND_URL when you deploy.
_allowed_origins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:3000",
    "http://frontend:5173",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
]
# Additional origins from env — FRONTEND_URL supports space-separated list
# e.g. FRONTEND_URL="https://paper-lens-liart.vercel.app https://myapp.com"
_frontend_url = os.getenv("FRONTEND_URL", "")
for _url in _frontend_url.split():
    if _url and _url not in _allowed_origins:
        _allowed_origins.append(_url)

# Allow all Vercel preview deployments via regex (covers *.vercel.app)
_allow_vercel = os.getenv("ALLOW_VERCEL_ORIGINS", "true").lower() == "true"

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_origin_regex=r"https://.*\.vercel\.app" if _allow_vercel else None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Security headers ─────────────────────────────────────────────────────────
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # HSTS only makes sense behind HTTPS — most deployment platforms
    # (Render/Railway/Fly) terminate TLS in front of the app, so this is
    # safe to always set; browsers ignore it over plain HTTP anyway.
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


async def _keep_alive():
    """Ping self every 10 minutes to prevent Render free tier from spinning down."""
    import httpx
    await asyncio.sleep(30)  # wait for full startup first
    while True:
        try:
            async with httpx.AsyncClient() as client:
                await client.get("https://scientific-paper-reviewer.onrender.com/ping", timeout=10)
        except Exception:
            pass
        await asyncio.sleep(600)  # every 10 minutes


@app.on_event("startup")
async def startup_event():
    # Store the main event loop so background threads can broadcast WebSocket messages
    from app.ws_manager import set_main_loop
    set_main_loop(asyncio.get_event_loop())
    create_tables()
    # Keep Render free tier alive
    asyncio.create_task(_keep_alive())


@app.get("/health")
async def health():
    """Fast health check — used by Render's health check probe."""
    from app.database import check_connection, DATABASE_URL
    try:
        db_ok = check_connection()
    except Exception:
        db_ok = False
    db_type = "supabase/postgres" if DATABASE_URL.startswith("postgresql") else "sqlite"
    return {
        "status": "ok",
        "service": "Scientific Paper Reviewer",
        "database": db_type,
        "database_connected": db_ok,
    }


@app.get("/ping")
async def ping():
    """Ultra-fast liveness probe — no DB call."""
    return {"ok": True}


app.include_router(papers.router, prefix="/api/papers", tags=["papers"])
app.include_router(related_router.router)
app.include_router(review.router, prefix="/api", tags=["review"])
app.include_router(auth.router)
app.include_router(stats.router)
app.include_router(profile.router)
app.include_router(finetune.router)
app.include_router(chat.router)
