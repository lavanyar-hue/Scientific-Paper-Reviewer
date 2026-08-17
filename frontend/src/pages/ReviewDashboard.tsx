import { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, FileText, Users, Tag, Calendar, ExternalLink,
  BookOpen, ChevronDown, ChevronUp, Cpu, Zap, CheckCircle2,
  AlertTriangle, Clock, Loader2, Timer, Square,
} from 'lucide-react'
import { getReview, cancelReview, type ReviewJob, type AgentResponse, type FinalReview } from '../api'
import ProgressTracker from '../components/ProgressTracker'
import GroupReviewPanel from '../components/GroupReviewPanel'
import FinalVerdict from '../components/FinalVerdict'
import { SkeletonCard } from '../components/Skeleton'
import RecommendationBadge from '../components/RecommendationBadge'

type WSMessage = { event: string; job_id: string; data: Record<string, unknown> }

// Agent pipeline — used only for the avatar row in the AI Analysis header
const AGENT_PIPELINE = [
  { id: 'a-primary', group: 'A', role: 'primary',     label: 'C',  color: '#6366f1' },
  { id: 'a-critic',  group: 'A', role: 'critic',      label: 'G',  color: '#10b981' },
  { id: 'b-primary', group: 'B', role: 'primary',     label: 'G4', color: '#3b82f6' },
  { id: 'b-critic',  group: 'B', role: 'critic',      label: 'M',  color: '#8b5cf6' },
  { id: 'synth',     group: 'S', role: 'synthesizer', label: 'S',  color: '#f59e0b' },
]

export default function ReviewDashboard() {
  const { jobId } = useParams<{ jobId: string }>()
  const navigate = useNavigate()
  const [job, setJob]               = useState<ReviewJob | null>(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [showComparison, setShowComparison] = useState(false)
  const [abstractExpanded, setAbstractExpanded] = useState(false)
  const [timeEstimate, setTimeEstimate] = useState<{ display: string; estimated_seconds: number } | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const comparisonRef = useRef<HTMLDivElement>(null)
  const wsRef   = useRef<WebSocket | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<number>(Date.now())

  useEffect(() => {
    if (!jobId) return
    getReview(jobId)
      .then(j => {
        setJob(j)
        setLoading(false)
        // Tell chat panel about this paper so it can answer questions about it
        if (j.paper_id) {
          localStorage.setItem('spr_last_paper_id', j.paper_id)
          window.dispatchEvent(new CustomEvent('spr:paper_uploaded', { detail: { paperId: j.paper_id } }))
        }
      })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [jobId])

  // Elapsed timer — ticks every second while job is running
  useEffect(() => {
    startTimeRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [jobId])

  // Stop timer when job completes/fails
  useEffect(() => {
    if (job?.status === 'completed' || job?.status === 'failed') {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [job?.status])

  useEffect(() => {
    if (!jobId) return
    const wsBase = (import.meta.env.VITE_API_BASE || 'http://localhost:8000').replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsBase}/ws/review/${jobId}`)
    wsRef.current = ws
    ws.onmessage = evt => {
      try {
        const msg: WSMessage = JSON.parse(evt.data)
        if (msg.event === 'time_estimate') {
          setTimeEstimate(msg.data as any)
        }
        if (msg.event === 'agent_complete') {
          const ar = msg.data as unknown as AgentResponse
          setJob(prev => {
            if (!prev) return prev
            if (prev.agent_responses.find(r => r.id === ar.id)) return prev
            return { ...prev, agent_responses: [...prev.agent_responses, ar] }
          })
        }
        if (msg.event === 'job_complete') {
          setJob(prev => prev ? { ...prev, status: 'completed', final_review: msg.data.final_review as FinalReview, completed_at: new Date().toISOString() } : prev)
        }
        if (msg.event === 'job_failed') {
          setJob(prev => prev ? { ...prev, status: 'failed', error_message: msg.data.error_message as string } : prev)
        }
        if (msg.event === 'status') {
          setJob(prev => prev ? { ...prev, status: msg.data.status as ReviewJob['status'] } : prev)
        }
      } catch { /* ignore */ }
    }
    ws.onerror = () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(() => {
        getReview(jobId!).then(j => {
          setJob(j)
          if (j.status === 'completed' || j.status === 'failed') clearInterval(pollRef.current!)
        }).catch(() => {})
      }, 3000)
    }
    ws.onclose = () => {
      // Also poll on close to catch completion while WS was down
      if (!pollRef.current) {
        pollRef.current = setInterval(() => {
          getReview(jobId!).then(j => {
            setJob(j)
            if (j.status === 'completed' || j.status === 'failed') clearInterval(pollRef.current!)
          }).catch(() => {})
        }, 3000)
      }
    }
    return () => { ws.close(); if (pollRef.current) clearInterval(pollRef.current) }
  }, [jobId])

  const scrollToComparison = () => {
    setShowComparison(true)
    setTimeout(() => comparisonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  const handleCancel = async () => {
    if (!jobId || cancelling) return
    setCancelling(true)
    try {
      await cancelReview(jobId)
      setJob(prev => prev ? { ...prev, status: 'failed', error_message: 'Cancelled by user.' } : prev)
    } catch (e) {
      // job may have finished between click and request — just poll
      if (jobId) getReview(jobId).then(setJob).catch(() => {})
    } finally {
      setCancelling(false)
    }
  }

  if (loading) return (
    <div className="space-y-4">
      <div className="h-6 w-40 rounded" style={{ background: 'rgba(99,102,241,0.15)' }} />
      <div className="h-8 w-72 rounded" style={{ background: 'rgba(99,102,241,0.15)' }} />
      <SkeletonCard /><SkeletonCard />
    </div>
  )

  if (error || !job) return (
    <div className="text-center py-20 animate-fade-in">
      <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
      <p className="text-red-600 font-medium mb-4">{error ?? 'Review not found.'}</p>
      <Link to="/" className="inline-flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-xl font-semibold text-sm hover:bg-indigo-700 transition-colors">
        ← New Review
      </Link>
    </div>
  )

  const groupA = job.agent_responses.filter(r => r.group === 'A')
  const groupB = job.agent_responses.filter(r => r.group === 'B')
  const bothCriticsDone = groupA.some(r => r.agent_role === 'critic') && groupB.some(r => r.agent_role === 'critic')
  const doneCount = job.agent_responses.filter(r => r.status === 'completed').length

  return (
    <div className="space-y-5 pb-8 animate-fade-in">

      {/* Back */}
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-indigo-400/60 hover:text-indigo-300 transition-colors font-medium group">
        <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" /> New Review
      </Link>

      {/* ── SECTION 1: PAPER ─────────────────────────────────────────── */}
      <PaperSection job={job} abstractExpanded={abstractExpanded} onToggleAbstract={() => setAbstractExpanded(v => !v)} />

      {/* ── SECTION 2: AI ANALYSIS ───────────────────────────────────── */}
      <AiSection
        job={job} doneCount={doneCount} bothCriticsDone={bothCriticsDone}
        showComparison={showComparison} comparisonRef={comparisonRef}
        timeEstimate={timeEstimate} elapsedSeconds={elapsedSeconds}
        onShowComparison={scrollToComparison}
        onToggleComparison={() => setShowComparison(v => !v)}
        onCancel={handleCancel} cancelling={cancelling}
      />
    </div>
  )
}

// ── Paper Section ─────────────────────────────────────────────────────────────
function PaperSection({ job, abstractExpanded, onToggleAbstract }:
  { job: ReviewJob; abstractExpanded: boolean; onToggleAbstract: () => void }) {
  const p = job.paper

  const statusBadge: Record<string, string> = {
    queued:     'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
    processing: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    completed:  'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    failed:     'bg-red-500/10 text-red-300 border-red-500/20',
  }

  return (
    <section>
      {/* Section label */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-lg flex items-center justify-center"
          style={{ background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)' }}>
          <FileText className="w-3.5 h-3.5 text-indigo-400" />
        </div>
        <span className="text-xs font-bold text-indigo-400 uppercase tracking-widest">Paper</span>
        <div className="flex-1 h-px" style={{ background: 'rgba(99,102,241,0.15)' }} />
        <span className="text-[10px] text-indigo-400/40 font-mono">Submitted for review</span>
      </div>

      <div className="rounded-2xl overflow-hidden animate-fade-in"
        style={{ background: 'rgba(13,15,26,0.7)', border: '1px solid rgba(99,102,241,0.18)' }}>
        <div className="px-6 py-5">
          {/* Title + status */}
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-4">
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold text-white leading-snug">
                {p?.title ?? 'Untitled Paper'}
              </h1>
              {p?.authors && (
                <div className="flex items-center gap-2 mt-1.5">
                  <Users className="w-3.5 h-3.5 text-indigo-400/50 flex-shrink-0" />
                  <p className="text-sm text-indigo-200/60">{p.authors}</p>
                </div>
              )}
            </div>
            <div className="flex items-start gap-2 flex-shrink-0 flex-wrap">
              <span className={`text-xs font-bold px-2.5 py-1 rounded-full border capitalize ${statusBadge[job.status] ?? statusBadge.queued}`}>
                {job.status}
              </span>
              {job.final_review?.final_recommendation && (
                <RecommendationBadge rec={job.final_review.final_recommendation} size="md" />
              )}
            </div>
          </div>

          {/* Meta chips */}
          <div className="flex flex-wrap gap-2">
            {p?.research_field && <Chip icon={<Tag className="w-3 h-3" />} label={p.research_field} color="indigo" />}
            {p?.arxiv_id && (
              <a href={`https://arxiv.org/abs/${p.arxiv_id}`} target="_blank" rel="noopener noreferrer">
                <Chip icon={<ExternalLink className="w-3 h-3" />} label={`arXiv:${p.arxiv_id}`} color="sky" />
              </a>
            )}
            {p?.created_at && (
              <Chip icon={<Calendar className="w-3 h-3" />}
                label={new Date(p.created_at).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata' })}
                color="slate" />
            )}
            {job.completed_at && (
              <Chip icon={<Clock className="w-3 h-3" />}
                label={`Reviewed ${new Date(job.completed_at).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' })}`}
                color="green" />
            )}
          </div>
        </div>

        {/* Abstract collapsible */}
        {p?.abstract && (
          <div style={{ borderTop: '1px solid rgba(99,102,241,0.12)' }}>
            <button onClick={onToggleAbstract}
              className="w-full flex items-center justify-between px-6 py-3 transition-colors"
              style={{ background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.05)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <div className="flex items-center gap-2">
                <BookOpen className="w-3.5 h-3.5 text-indigo-400/50" />
                <span className="text-xs font-semibold text-indigo-300/60 uppercase tracking-wider">Abstract</span>
              </div>
              {abstractExpanded
                ? <ChevronUp className="w-4 h-4 text-indigo-400/40" />
                : <ChevronDown className="w-4 h-4 text-indigo-400/40" />}
            </button>
            {abstractExpanded && (
              <div className="px-6 pb-5 animate-fade-in">
                <p className="text-sm leading-relaxed" style={{ color: 'rgba(165,180,252,0.6)' }}>{p.abstract}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function Chip({ icon, label, color }: { icon: React.ReactNode; label: string; color: string }) {
  const cls: Record<string, string> = {
    indigo: 'text-indigo-300 border-indigo-500/25',
    sky:    'text-sky-300 border-sky-500/25 cursor-pointer',
    slate:  'text-indigo-300/50 border-indigo-500/15',
    green:  'text-emerald-300 border-emerald-500/25',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors ${cls[color] ?? cls.slate}`}
      style={{ background: 'rgba(99,102,241,0.06)' }}>
      {icon}{label}
    </span>
  )
}

// ── AI Analysis Section ───────────────────────────────────────────────────────
function AiSection({ job, doneCount, bothCriticsDone, showComparison, comparisonRef, onShowComparison, onToggleComparison, timeEstimate, elapsedSeconds, onCancel, cancelling }: {
  job: ReviewJob; doneCount: number; bothCriticsDone: boolean;
  showComparison: boolean; comparisonRef: React.RefObject<HTMLDivElement>;
  onShowComparison: () => void; onToggleComparison: () => void;
  timeEstimate: { display: string; estimated_seconds: number } | null;
  elapsedSeconds: number;
  onCancel: () => void; cancelling: boolean;
}) {
  const total     = 5
  const pct       = Math.round((doneCount / total) * 100)
  const isRunning = job.status === 'processing' || job.status === 'queued'
  const isFailed  = job.status === 'failed'
  const isDone    = job.status === 'completed'

  // Time remaining estimate
  const remaining = timeEstimate
    ? Math.max(0, timeEstimate.estimated_seconds - elapsedSeconds)
    : null

  const formatTime = (s: number) => {
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
  }

  return (
    <section>
      {/* Section label */}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-lg flex items-center justify-center"
          style={{ background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)' }}>
          <Cpu className="w-3.5 h-3.5 text-indigo-400" />
        </div>
        <span className="text-xs font-bold text-indigo-400 uppercase tracking-widest">AI Review</span>
        <div className="flex-1 h-px" style={{ background: 'rgba(99,102,241,0.15)' }} />

        {/* Agent avatar dots */}
        <div className="flex items-center gap-1">
          {AGENT_PIPELINE.map(a => {
            const done = job.agent_responses.some(r => r.group === a.group && r.agent_role === a.role && r.status === 'completed')
            return (
              <div key={a.id} title={`${a.label} (${a.role})`}
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[8px] font-black transition-all duration-300 ${
                  done ? 'text-white scale-110' : 'text-slate-300 bg-white'
                }`}
                style={{ borderColor: a.color, background: done ? a.color : undefined }}>
                {done ? <CheckCircle2 className="w-3 h-3" /> : <span style={{ color: a.color }}>{a.label[0]}</span>}
              </div>
            )
          })}
        </div>
      </div>

      <div className="space-y-4">
        {/* Pipeline status card */}
        <div className="rounded-2xl px-6 py-4 transition-all duration-500 animate-fade-in"
          style={{
            background: isFailed ? 'rgba(239,68,68,0.06)' : isDone ? 'rgba(16,185,129,0.06)' : 'rgba(99,102,241,0.06)',
            border: `1px solid ${isFailed ? 'rgba(239,68,68,0.2)' : isDone ? 'rgba(16,185,129,0.2)' : 'rgba(99,102,241,0.2)'}`,
          }}>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {isDone    && <CheckCircle2 className="w-6 h-6 text-emerald-500 flex-shrink-0 animate-count-up" />}
              {isRunning && <Loader2 className="w-6 h-6 text-indigo-500 animate-spin flex-shrink-0" />}
              {isFailed  && <AlertTriangle className="w-6 h-6 text-red-500 flex-shrink-0" />}
              {!isDone && !isRunning && !isFailed && <Zap className="w-6 h-6 text-slate-400 flex-shrink-0" />}
              <div>
                <p className="text-sm font-bold text-white">
                  {isDone ? 'Analysis Complete' : isRunning ? 'Running Multi-Agent Pipeline…' : isFailed ? 'Pipeline Failed' : 'Queued'}
                </p>
                <p className="text-xs text-indigo-300/50 mt-0.5">
                  {isDone
                    ? `All ${total} agents finished${job.completed_at ? ' · ' + new Date(job.completed_at).toLocaleTimeString() : ''}`
                    : `${doneCount} of ${total} agents complete`}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4 flex-shrink-0">
              {/* Stop button — only when running */}
              {isRunning && (
                <button
                  onClick={onCancel}
                  disabled={cancelling}
                  title="Stop review"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                  style={{
                    background: cancelling ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.15)',
                    border: '1px solid rgba(239,68,68,0.4)',
                    color: cancelling ? 'rgba(252,165,165,0.5)' : '#fca5a5',
                    cursor: cancelling ? 'not-allowed' : 'pointer',
                  }}
                >
                  <Square size={11} className={cancelling ? 'opacity-50' : ''} />
                  {cancelling ? 'Stopping…' : 'Stop'}
                </button>
              )}
              {/* Time estimate / elapsed */}
              {isRunning && (
                <div className="text-right">
                  {remaining !== null && remaining > 0 ? (
                    <>
                      <div className="flex items-center gap-1 text-indigo-600">
                        <Timer className="w-3.5 h-3.5" />
                        <span className="text-sm font-bold tabular-nums">{formatTime(remaining)}</span>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-0.5">remaining (est.)</p>
                    </>
                  ) : timeEstimate ? (
                    <>
                      <div className="flex items-center gap-1 text-slate-500">
                        <Clock className="w-3.5 h-3.5" />
                        <span className="text-sm font-semibold tabular-nums">{formatTime(elapsedSeconds)}</span>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-0.5">elapsed · est. {timeEstimate.display}</p>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-1 text-slate-500">
                        <Clock className="w-3.5 h-3.5" />
                        <span className="text-sm font-semibold tabular-nums">{formatTime(elapsedSeconds)}</span>
                      </div>
                      <p className="text-[10px] text-slate-400 mt-0.5">elapsed</p>
                    </>
                  )}
                </div>
              )}

              {isDone && job.final_review?.final_scores?.overall != null && (
                <div className="text-right">
                  <p className="text-3xl font-black tabular-nums text-indigo-300 animate-count-up">
                    {job.final_review.final_scores.overall.toFixed(1)}
                  </p>
                  <p className="text-[10px] text-indigo-400/40 mt-0.5">out of 10</p>
                </div>
              )}
            </div>
          </div>

          {/* Progress bar */}
          <div className="mt-4 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(99,102,241,0.1)' }}>
            <div className="h-full rounded-full transition-all duration-700 ease-out"
              style={{
                width: `${pct}%`,
                background: isFailed ? '#ef4444' : isDone
                  ? 'linear-gradient(90deg,#10b981,#6ee7b7)'
                  : 'linear-gradient(90deg,#6366f1,#a78bfa)',
              }} />
          </div>

          {/* Stage labels */}
          {isRunning && timeEstimate && (
            <div className="mt-2 flex justify-between text-[9px] font-medium" style={{ color: 'rgba(99,102,241,0.4)' }}>
              <span>Reviewing…</span>
              <span>Est. {timeEstimate.display} total</span>
            </div>
          )}
        </div>

        {/* ProgressTracker */}
        <ProgressTracker responses={job.agent_responses} jobStatus={job.status} />

        {/* Final Verdict */}
        {job.final_review && (
          <FinalVerdict finalReview={job.final_review} jobId={job.id} paperId={job.paper_id} onShowComparison={onShowComparison} />
        )}

        {/* Group comparison */}
        {bothCriticsDone && (
          <div ref={comparisonRef}>
            {!showComparison && !job.final_review && (
              <button onClick={onToggleComparison}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-all"
                style={{ border: '1px solid rgba(99,102,241,0.2)', background: 'rgba(99,102,241,0.05)', color: '#a5b4fc' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.1)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.05)' }}>
                View Group A vs Group B Debate
              </button>
            )}
            {(showComparison || !job.final_review) && (
              <div className="space-y-4 animate-slide-up">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-bold text-slate-700">Group A vs Group B</h2>
                  <div className="flex-1 h-px bg-slate-200" />
                  <button onClick={onToggleComparison} className="text-xs text-slate-400 hover:text-indigo-500 transition-colors">
                    {showComparison ? 'Collapse' : 'Expand'}
                  </button>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <GroupReviewPanel group="A" responses={job.agent_responses} />
                  <GroupReviewPanel group="B" responses={job.agent_responses} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Failed state */}
        {isFailed && !job.final_review && (
          <div className="bg-red-50 border border-red-200 rounded-2xl px-6 py-5 animate-fade-in">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-red-800 text-sm">Review job failed</p>
                {job.error_message && (
                  <p className="text-sm mt-1 text-red-600 leading-relaxed">{job.error_message}</p>
                )}
                <Link to="/" className="inline-flex items-center gap-2 mt-3 bg-white border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-50 transition-colors">
                  ← Try again
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}