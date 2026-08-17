import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, ArrowRight, Clock, FileText, SlidersHorizontal, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { getHistory, type ReviewJobSummary } from '../api'
import { useAuth } from '../components/ui/Layout'

function timeAgo(isoDate: string): string {
  if (!isoDate) return '—'
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
return new Date(isoDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })
}

type Filter = 'all' | 'Accept' | 'Minor Revision' | 'Major Revision' | 'Reject' | 'processing'
const FILTERS: Filter[] = ['all', 'Accept', 'Minor Revision', 'Major Revision', 'Reject', 'processing']
function recStyle(rec: string) {
  switch (rec) {
    case 'Accept':         return { bg: 'rgba(16,185,129,0.12)', color: '#6ee7b7', border: 'rgba(16,185,129,0.3)' }
    case 'Minor Revision': return { bg: 'rgba(245,158,11,0.12)', color: '#fcd34d', border: 'rgba(245,158,11,0.3)' }
    case 'Major Revision': return { bg: 'rgba(249,115,22,0.12)', color: '#fdba74', border: 'rgba(249,115,22,0.3)' }
    case 'Reject':         return { bg: 'rgba(239,68,68,0.12)',  color: '#fca5a5', border: 'rgba(239,68,68,0.3)'  }
    default:               return { bg: 'rgba(99,102,241,0.1)',  color: '#a5b4fc', border: 'rgba(99,102,241,0.2)' }
  }
}

function statusDot(status: string) {
  switch (status) {
    case 'completed':  return 'bg-emerald-400'
    case 'processing': return 'bg-indigo-400 animate-pulse'
    case 'queued':     return 'bg-indigo-400/50 animate-pulse'
    case 'failed':     return 'bg-red-400'
    default:           return 'bg-indigo-400/30'
  }
}

export default function History() {
  const { user, openAuth } = useAuth()
  const [jobs, setJobs]       = useState<ReviewJobSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [search, setSearch]   = useState('')
  const [filter, setFilter]   = useState<Filter>('all')
  const [minScore, setMinScore] = useState<number | null>(null)

  useEffect(() => {
    if (!user) { setLoading(false); return }
    setLoading(true)
    getHistory()
      .then(j => { setJobs(j); setLoading(false); setError(null) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [user])

  if (!user && !loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center animate-fade-in">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
          style={{ background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)' }}>
          <Clock className="w-8 h-8 text-indigo-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-2">Sign in to view your history</h2>
        <p className="text-sm mb-6 max-w-xs" style={{ color: 'rgba(165,180,252,0.5)' }}>
          Log in to see all your previous scientific paper reviews and reports.
        </p>
        <button onClick={() => openAuth('login')}
          className="inline-flex items-center gap-2 text-white px-6 py-2.5 rounded-xl font-semibold text-sm"
          style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 4px 16px rgba(99,102,241,0.35)' }}>
          Sign In / Sign Up
        </button>
      </div>
    )
  }

  const filtered = jobs.filter(j => {
    const matchSearch = !search.trim() || (j.paper_title ?? '').toLowerCase().includes(search.toLowerCase())
    const matchFilter = filter === 'all'
      || (filter === 'processing' && (j.status === 'processing' || j.status === 'queued'))
      || j.final_recommendation === filter
    const matchScore = minScore === null || (j.overall_score !== null && j.overall_score >= minScore)
    return matchSearch && matchFilter && matchScore
  })

  return (
    <div className="space-y-5 pb-8 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Review History</h1>
          {!loading && (
            <p className="text-sm mt-0.5" style={{ color: 'rgba(165,180,252,0.45)' }}>
              {jobs.length} review{jobs.length !== 1 ? 's' : ''} total
            </p>
          )}
        </div>
        <Link to="/" className="flex items-center gap-2 text-white px-4 py-2 rounded-xl text-sm font-semibold transition-all"
          style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 2px 12px rgba(99,102,241,0.35)' }}>
          + New Review
        </Link>
      </div>

      {/* Search + filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-indigo-400/50 pointer-events-none" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by paper title…"
            className="w-full pl-10 pr-4 py-2.5 rounded-xl text-sm focus:outline-none transition-all text-indigo-100 placeholder:text-indigo-400/30"
            style={{ background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.2)' }}
            onFocus={e => e.target.style.borderColor = 'rgba(99,102,241,0.5)'}
            onBlur={e => e.target.style.borderColor = 'rgba(99,102,241,0.2)'} />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <SlidersHorizontal className="w-4 h-4 text-indigo-400/40 flex-shrink-0" />
          {FILTERS.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-all"
              style={filter === f ? {
                background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                color: '#fff',
                boxShadow: '0 2px 8px rgba(99,102,241,0.35)',
              } : {
                background: 'rgba(99,102,241,0.07)',
                color: 'rgba(165,180,252,0.55)',
                border: '1px solid rgba(99,102,241,0.15)',
              }}>
              {f === 'all' ? 'All' : f === 'processing' ? 'In Progress' : f}
            </button>
          ))}
          {/* Score filter */}
          <select
            value={minScore ?? ''}
            onChange={e => setMinScore(e.target.value ? Number(e.target.value) : null)}
            className="text-[11px] font-semibold px-2 py-1.5 rounded-lg outline-none"
            style={{ background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.15)', color: 'rgba(165,180,252,0.55)' }}>
            <option value="">All Scores</option>
            <option value="7">≥ 7.0</option>
            <option value="6">≥ 6.0</option>
            <option value="5">≥ 5.0</option>
          </select>
          {(search || filter !== 'all' || minScore !== null) && (
            <button onClick={() => { setSearch(''); setFilter('all'); setMinScore(null); }}
              className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg transition-all"
              style={{ background: 'rgba(239,68,68,0.1)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.2)' }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
        </div>
      )}

      {error && (
        <div className="rounded-xl p-4 flex items-center gap-3"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {!loading && !error && jobs.length === 0 && (
        <div className="text-center py-24 rounded-2xl"
          style={{ background: 'rgba(13,15,26,0.7)', border: '1px solid rgba(99,102,241,0.18)' }}>
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)' }}>
            <FileText className="w-7 h-7 text-indigo-400/50" />
          </div>
          <p className="font-semibold text-indigo-200/50 mb-1">No reviews yet</p>
          <p className="text-sm mb-5" style={{ color: 'rgba(165,180,252,0.35)' }}>Submit your first paper to get started.</p>
          <Link to="/" className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-xl font-semibold text-sm"
            style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}>
            Start your first review <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {!loading && !error && jobs.length > 0 && filtered.length === 0 && (
        <div className="text-center py-12 rounded-2xl"
          style={{ background: 'rgba(13,15,26,0.7)', border: '1px solid rgba(99,102,241,0.18)' }}>
          <p className="font-medium" style={{ color: 'rgba(165,180,252,0.5)' }}>No reviews match your search.</p>
          <button onClick={() => { setSearch(''); setFilter('all') }}
            className="mt-2 text-sm font-medium underline" style={{ color: '#818cf8' }}>
            Clear filters
          </button>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="rounded-2xl overflow-hidden"
          style={{ background: 'rgba(13,15,26,0.7)', border: '1px solid rgba(99,102,241,0.18)' }}>
          {/* Table header */}
          <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 px-5 py-3"
            style={{ background: 'rgba(99,102,241,0.06)', borderBottom: '1px solid rgba(99,102,241,0.12)' }}>
            {['Paper', 'Score', 'Verdict', 'Submitted', ''].map((h, i) => (
              <span key={i} className="text-[10px] font-bold uppercase tracking-wider text-right first:text-left"
                style={{ color: 'rgba(99,102,241,0.4)' }}>{h}</span>
            ))}
          </div>
          <div>
            {filtered.map((job, i) => <HistoryRow key={job.id} job={job} index={i} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function HistoryRow({ job, index }: { job: ReviewJobSummary; index: number }) {
  const rs = job.final_recommendation ? recStyle(job.final_recommendation) : null
  return (
    <Link to={`/review/${job.id}`}
      className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto_auto] gap-3 sm:gap-4 items-center px-5 py-4 transition-all group animate-fade-in"
      style={{ animationDelay: `${index * 30}ms`, borderBottom: '1px solid rgba(99,102,241,0.07)' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.06)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>

      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', color: '#818cf8' }}>
          <FileText className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-indigo-100 text-sm truncate group-hover:text-white transition-colors">
            {job.paper_title ?? 'Untitled Paper'}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(job.status)}`} />
            <span className="text-xs capitalize" style={{ color: 'rgba(165,180,252,0.45)' }}>{job.status}</span>
            <Clock className="w-3 h-3 flex-shrink-0 ml-1" style={{ color: 'rgba(99,102,241,0.3)' }} />
            <span className="text-xs" style={{ color: 'rgba(165,180,252,0.35)' }}>{timeAgo(job.created_at)}</span>
          </div>
        </div>
      </div>

      <div className="sm:w-20 sm:text-right">
        {job.overall_score != null ? (
          <span className="text-base font-black tabular-nums text-indigo-200">
            {job.overall_score.toFixed(1)}
            <span className="text-xs font-normal ml-0.5" style={{ color: 'rgba(165,180,252,0.35)' }}>/10</span>
          </span>
        ) : <span className="text-xs" style={{ color: 'rgba(99,102,241,0.3)' }}>—</span>}
      </div>

      <div className="sm:w-36 sm:text-right">
        {rs ? (
          <span className="text-[11px] font-bold px-2.5 py-1 rounded-full"
            style={{ background: rs.bg, color: rs.color, border: `1px solid ${rs.border}` }}>
            {job.final_recommendation}
          </span>
        ) : <span className="text-xs" style={{ color: 'rgba(165,180,252,0.35)' }}>Pending</span>}
      </div>

      <div className="hidden sm:block sm:w-24 text-right">
        <span className="text-xs" style={{ color: 'rgba(165,180,252,0.35)' }}>
          {new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
        </span>
      </div>

      <ArrowRight className="hidden sm:block w-4 h-4 group-hover:translate-x-0.5 transition-all"
        style={{ color: 'rgba(99,102,241,0.35)' }} />
    </Link>
  )
}
