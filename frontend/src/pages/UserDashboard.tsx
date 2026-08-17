import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  FileText, MoreVertical, ChevronRight, Download, Share2, Trash2,
  Clock, Bot, Search, RefreshCw, AlertCircle, Loader2, Star, Folder, Users,
} from 'lucide-react';
import {
  getUserStats, getDashboardPapers, getHistory, getToken, deletePaper,
  type UserStats, type DashboardPaper, type ReviewJobSummary,
} from '../api';
import { useAuth } from '../components/ui/Layout';

// ── Card style constants ──────────────────────────────────────────────────────
const CARD = { background: 'rgba(13,15,26,0.7)', border: '1px solid rgba(99,102,241,0.18)' };
const DIVIDER = { borderTop: '1px solid rgba(99,102,241,0.1)' };

export default function UserDashboard() {
  const { user, openAuth } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats]     = useState<UserStats | null>(null);
  const [papers, setPapers]   = useState<DashboardPaper[]>([]);
  const [history, setHistory] = useState<ReviewJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [showAllPapers, setShowAllPapers] = useState(false);

  const fetchAll = useCallback(async (isManual = false) => {
    if (!getToken()) { setError('not_logged_in'); setLoading(false); return; }
    if (isManual) setRefreshing(true);
    try {
      const [statsRes, papersRes, histRes] = await Promise.all([
        getUserStats(), getDashboardPapers(), getHistory(),
      ]);
      setStats(statsRes);
      setPapers(papersRes.papers);
      setHistory(histRes);
      setIsConnected(true);
      setError(null);
      setLastRefreshed(new Date());
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) setError('not_logged_in');
      else setError(err?.response?.data?.detail || 'Failed to connect to backend.');
      setIsConnected(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(() => fetchAll(), 30_000);
    return () => clearInterval(iv);
  }, [fetchAll, user]);

  const username = stats?.username || user?.username || 'User';
  const displayName = username.charAt(0).toUpperCase() + username.slice(1);
  const visiblePapers = showAllPapers ? papers : papers.slice(0, 5);

  if (!loading && error === 'not_logged_in') {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center animate-fade-in">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
          style={{ background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.25)' }}>
          <Users className="w-8 h-8 text-indigo-400" />
        </div>
        <h2 className="text-xl font-bold text-white mb-2">Sign in to view your dashboard</h2>
        <p className="text-sm mb-6 max-w-xs" style={{ color: 'rgba(165,180,252,0.55)' }}>
          Log in to see your papers, review history, and statistics.
        </p>
        <button onClick={() => openAuth('login')}
          className="inline-flex items-center gap-2 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-all"
          style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 4px 16px rgba(99,102,241,0.35)' }}>
          Sign In / Sign Up
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-10 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white mb-1 flex items-center gap-2.5">
            Welcome back, {displayName}! 👋
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={isConnected
                ? { background: 'rgba(16,185,129,0.15)', color: '#6ee7b7', border: '1px solid rgba(16,185,129,0.3)' }
                : { background: 'rgba(239,68,68,0.12)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.25)' }}>
              ● {isConnected ? 'Live' : 'Offline'}
            </span>
          </h2>
          <p className="text-[13px]" style={{ color: 'rgba(165,180,252,0.5)' }}>
            Here's what's happening with your research today.
            {isConnected && (
              <span className="ml-2 text-[11px]" style={{ color: 'rgba(99,102,241,0.4)' }}>
                Last synced: {lastRefreshed.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <button onClick={() => fetchAll(true)} disabled={refreshing}
          className="p-2 rounded-xl transition-all disabled:opacity-50"
          style={{ border: '1px solid rgba(99,102,241,0.2)', background: 'rgba(99,102,241,0.06)', color: '#a5b4fc' }}
          title="Refresh data">
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Error banner */}
      {error && error !== 'not_logged_in' && (
        <div className="rounded-xl p-4 flex items-start gap-3 animate-slide-down"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <AlertCircle size={18} className="shrink-0 mt-0.5 text-red-400" />
          <div>
            <p className="font-semibold text-sm text-red-300">Connection Error</p>
            <p className="text-xs mt-0.5 text-red-400/70">{error}</p>
            <button onClick={() => fetchAll(true)} className="text-xs font-bold text-red-400 underline mt-1">Retry</button>
          </div>
        </div>
      )}

      {/* Stat Cards */}
      {loading ? (
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 rounded-2xl animate-pulse skeleton" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-4">
          {[
            { icon: <FileText size={20} />, color: '#818cf8', value: stats?.total_papers ?? 0, label: 'Total Papers', sub: `${stats?.completed_reviews ?? 0} reviews done` },
            { icon: <Folder size={20} />,   color: '#60a5fa', value: stats?.total_reviews ?? 0, label: 'Total Reviews', sub: `Avg: ${stats?.average_time ?? '—'}` },
            { icon: <Users size={20} />,    color: '#6ee7b7', value: stats?.completed_reviews ?? 0, label: 'Completed', sub: 'AI review cycles' },
            { icon: <Star size={20} />,     color: '#fbbf24', value: stats?.average_score ?? '—', label: 'Avg Score', sub: 'out of 10.0' },
          ].map((s, i) => (
            <div key={i} className="rounded-2xl p-5 flex flex-col gap-3 transition-all hover:scale-[1.02] animate-fade-in"
              style={{ ...CARD, animationDelay: `${i * 0.06}s` }}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: s.color + '18', border: `1px solid ${s.color}28`, color: s.color }}>
                {s.icon}
              </div>
              <div>
                <p className="text-3xl font-black text-white leading-none mb-1">{s.value}</p>
                <p className="text-xs font-semibold mb-0.5" style={{ color: 'rgba(165,180,252,0.6)' }}>{s.label}</p>
                <p className="text-[11px]" style={{ color: s.color + '90' }}>{s.sub}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Paper Review Table */}
      <section className="animate-fade-in" style={{ animationDelay: '0.15s' }}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-[15px] font-bold text-white">Paper Review</h3>
            <p className="text-[12px] mt-0.5" style={{ color: 'rgba(165,180,252,0.4)' }}>
              Live status of all your uploaded papers — updates every 30s.
            </p>
          </div>
          <button
            onClick={() => setShowAllPapers(v => !v)}
            className="text-xs font-semibold flex items-center gap-1 transition-colors"
            style={{ color: '#818cf8' }}>
            {showAllPapers ? 'Show Less' : `View All (${papers.length})`}
            <ChevronRight size={14} className={showAllPapers ? 'rotate-90 transition-transform' : 'transition-transform'} />
          </button>
        </div>

        <div className="rounded-2xl overflow-hidden" style={CARD}>
          {loading ? (
            <div className="p-8 text-center" style={{ color: 'rgba(165,180,252,0.4)' }}>
              <Loader2 size={24} className="animate-spin mx-auto mb-2 text-indigo-400" />
              <p className="text-sm">Loading papers…</p>
            </div>
          ) : papers.length === 0 ? (
            <div className="p-12 text-center">
              <FileText size={32} className="mx-auto mb-3 text-indigo-400/20" />
              <p className="text-sm font-semibold text-indigo-200/40">No papers yet</p>
              <p className="text-xs mt-1 text-indigo-300/25">Upload a PDF to get started</p>
            </div>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(99,102,241,0.15)' }}>
                  {['Paper Details', 'Version', 'Status & Progress', 'AI Confidence', 'Last Updated', ''].map((h, i) => (
                    <th key={i} className="px-5 py-3 text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: 'rgba(99,102,241,0.5)', background: 'rgba(99,102,241,0.05)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visiblePapers.map((paper, i) => (
                  <PaperRow key={paper.id} paper={paper} index={i} navigate={navigate} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Review History */}
      <section className="animate-fade-in" style={{ animationDelay: '0.2s' }}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-[15px] font-bold text-white">Review History</h3>
            <p className="text-[12px] mt-0.5" style={{ color: 'rgba(165,180,252,0.4)' }}>All past AI review jobs.</p>
          </div>
        </div>
        <div className="rounded-2xl overflow-hidden" style={CARD}>
          {loading ? (
            <div className="p-8 text-center">
              <Loader2 size={24} className="animate-spin mx-auto mb-2 text-indigo-400" />
            </div>
          ) : history.length === 0 ? (
            <div className="p-12 text-center">
              <Clock size={32} className="mx-auto mb-3 text-indigo-400/20" />
              <p className="text-sm font-semibold text-indigo-200/40">No review history yet</p>
            </div>
          ) : (
            <div>
              {history.slice(0, 10).map((job, i) => (
                <HistoryRow key={job.id} job={job} index={i} navigate={navigate} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  if (!iso) return '—';
  // Parse as UTC and convert to IST (UTC+5:30)
  const utcMs = new Date(iso).getTime();
  const istMs = utcMs + (5.5 * 60 * 60 * 1000);
  const diff = Date.now() - utcMs; // relative time uses actual elapsed time
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  // For older items show IST date
  const d = new Date(istMs);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function statusColors(status: string) {
  switch (status?.toLowerCase()) {
    case 'completed': return { bg: 'rgba(16,185,129,0.12)', text: '#6ee7b7', border: 'rgba(16,185,129,0.25)' };
    case 'processing':
    case 'reviewing':  return { bg: 'rgba(99,102,241,0.12)', text: '#a5b4fc', border: 'rgba(99,102,241,0.25)' };
    case 'failed':     return { bg: 'rgba(239,68,68,0.12)',  text: '#fca5a5', border: 'rgba(239,68,68,0.25)' };
    case 'queued':     return { bg: 'rgba(99,102,241,0.07)', text: '#818cf8', border: 'rgba(99,102,241,0.15)' };
    default:           return { bg: 'rgba(99,102,241,0.07)', text: '#a5b4fc', border: 'rgba(99,102,241,0.15)' };
  }
}

function progressGradient(status: string) {
  switch (status?.toLowerCase()) {
    case 'completed':  return 'linear-gradient(90deg,#10b981,#6ee7b7)';
    case 'processing': return 'linear-gradient(90deg,#6366f1,#a78bfa)';
    case 'failed':     return 'linear-gradient(90deg,#ef4444,#fca5a5)';
    default:           return 'linear-gradient(90deg,#6366f1,#8b5cf6)';
  }
}

// ── Paper Row ─────────────────────────────────────────────────────────────────

function PaperRow({ paper, index, navigate }: { paper: DashboardPaper; index: number; navigate: any }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const sc = statusColors(paper.status);

  const handleOpenDetails = () => {
    setMenuOpen(false);
    if (paper.job_id) navigate(`/review/${paper.job_id}`);
  };

  const handleDownloadPdf = () => {
    setMenuOpen(false);
    // Create a text export of the paper details as a downloadable file
    const content = `Title: ${paper.title}\nAuthors: ${paper.authors}\nField: ${paper.tag}\nStatus: ${paper.status}\nScore: ${paper.score ?? 'N/A'}/10\nLast Updated: ${paper.last_updated}`;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${paper.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    if (!window.confirm(`Delete "${paper.title}"? This will also remove all its reviews.`)) return;
    setDeleting(true);
    try {
      await deletePaper(paper.id);
      // Reload the page to refresh the list
      window.location.reload();
    } catch (e: any) {
      alert(`Failed to delete: ${e?.response?.data?.detail || e.message}`);
      setDeleting(false);
    }
  };

  return (
    <tr className="transition-all group animate-fade-in"
      style={{
        animationDelay: `${index * 0.05}s`,
        borderBottom: '1px solid rgba(99,102,241,0.08)',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.05)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>

      {/* Paper details */}
      <td className="px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
            style={{ background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.2)', color: '#818cf8' }}>
            <FileText size={14} />
          </div>
          <div className="min-w-0">
            <h4 className="text-[13px] font-bold text-indigo-100 truncate max-w-[180px]">{paper.title}</h4>
            <p className="text-[11px] truncate max-w-[180px]" style={{ color: 'rgba(165,180,252,0.45)' }}>{paper.authors}</p>
            <p className="text-[10px] mt-0.5" style={{ color: 'rgba(99,102,241,0.4)' }}>{paper.tag}</p>
          </div>
        </div>
      </td>

      {/* Version */}
      <td className="px-5 py-4">
        <span className="text-[11px] font-semibold px-2 py-1 rounded"
          style={{ background: 'rgba(99,102,241,0.1)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.2)' }}>
          {paper.version}
        </span>
      </td>

      {/* Status & Progress */}
      <td className="px-5 py-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide"
            style={{ background: sc.bg, color: sc.text, border: `1px solid ${sc.border}` }}>
            {paper.status}
          </span>
          <span className="text-[11px] font-bold text-indigo-200">{paper.progress}%</span>
        </div>
        <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(99,102,241,0.1)' }}>
          <div className="h-full rounded-full transition-all duration-700"
            style={{ width: `${paper.progress}%`, background: progressGradient(paper.status) }} />
        </div>
      </td>

      {/* AI Confidence */}
      <td className="px-5 py-4">
        {paper.confidence != null ? (
          <div className="w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold"
            style={{
              background: paper.confidence >= 90 ? 'rgba(16,185,129,0.15)'
                        : paper.confidence >= 75 ? 'rgba(99,102,241,0.15)'
                        : 'rgba(245,158,11,0.15)',
              color: paper.confidence >= 90 ? '#6ee7b7'
                   : paper.confidence >= 75 ? '#a5b4fc'
                   : '#fcd34d',
              border: `1px solid ${paper.confidence >= 90 ? 'rgba(16,185,129,0.3)'
                                  : paper.confidence >= 75 ? 'rgba(99,102,241,0.3)'
                                  : 'rgba(245,158,11,0.3)'}`,
            }}>
            {paper.confidence}
          </div>
        ) : (
          <span className="text-sm" style={{ color: 'rgba(99,102,241,0.3)' }}>—</span>
        )}
      </td>

      {/* Last Updated */}
      <td className="px-5 py-4">
        <span className="text-[11px]" style={{ color: 'rgba(165,180,252,0.45)' }}>
          {formatRelativeTime(paper.last_updated)}
        </span>
      </td>

      {/* Actions */}
      <td className="px-5 py-4 text-center relative">
        <button onClick={() => setMenuOpen(v => !v)}
          onBlur={() => setTimeout(() => setMenuOpen(false), 150)}
          className="w-8 h-8 rounded-lg flex items-center justify-center mx-auto transition-all"
          style={{ color: 'rgba(99,102,241,0.5)' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.12)'; (e.currentTarget as HTMLButtonElement).style.color = '#a5b4fc'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'rgba(99,102,241,0.5)'; }}>
          <MoreVertical size={16} />
        </button>
        {menuOpen && (
          <div className="absolute right-8 top-10 w-44 rounded-xl shadow-2xl z-20 py-1 text-left overflow-hidden"
            style={{ background: '#13151f', border: '1px solid rgba(99,102,241,0.2)' }}>
            {[
              { icon: <Search size={12}/>, label: 'Open Details', action: handleOpenDetails, disabled: !paper.job_id },
              { icon: <Download size={12}/>, label: 'Download PDF', action: handleDownloadPdf, disabled: false },
              { icon: <Share2 size={12}/>, label: 'Share', action: () => {
                navigator.clipboard?.writeText(window.location.origin + `/review/${paper.job_id}`);
                setMenuOpen(false);
              }, disabled: !paper.job_id },
            ].map(item => (
              <button key={item.label} onClick={item.action} disabled={item.disabled}
                className="w-full px-4 py-2 text-[12px] flex items-center gap-2 font-medium transition-colors disabled:opacity-40"
                style={{ color: 'rgba(165,180,252,0.7)' }}
                onMouseEnter={e => !item.disabled && (e.currentTarget.style.background = 'rgba(99,102,241,0.1)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                {item.icon} {item.label}
              </button>
            ))}
            <div style={{ borderTop: '1px solid rgba(99,102,241,0.12)', margin: '2px 0' }} />
            <button onClick={handleDelete} disabled={deleting}
              className="w-full px-4 py-2 text-[12px] flex items-center gap-2 font-medium text-red-400/80 transition-colors disabled:opacity-40"
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <Trash2 size={12} /> {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

// ── History Row ───────────────────────────────────────────────────────────────

function HistoryRow({ job, index, navigate }: { job: ReviewJobSummary; index: number; navigate: any }) {
  const sc = statusColors(job.status);
  return (
    <div className="flex items-center gap-4 px-5 py-4 transition-all cursor-pointer animate-fade-in"
      style={{ animationDelay: `${index * 0.04}s`, borderBottom: '1px solid rgba(99,102,241,0.08)' }}
      onClick={() => job.id && navigate(`/review/${job.id}`)}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.05)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', color: '#818cf8' }}>
        <FileText size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="text-[13px] font-bold text-indigo-100 truncate">{job.paper_title || 'Untitled Paper'}</h4>
        <p className="text-[11px]" style={{ color: 'rgba(165,180,252,0.4)' }}>{formatRelativeTime(job.created_at)}</p>
      </div>
      <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide shrink-0"
        style={{ background: sc.bg, color: sc.text, border: `1px solid ${sc.border}` }}>
        {job.status}
      </span>
      {job.overall_score != null ? (
        <div className="w-12 text-right shrink-0">
          <span className="text-sm font-bold text-indigo-200">{job.overall_score.toFixed(1)}</span>
          <span className="text-[10px] text-indigo-400/40">/10</span>
        </div>
      ) : (
        <div className="w-12 text-right shrink-0 text-indigo-400/30 text-[11px]">—</div>
      )}
      {job.final_recommendation ? (
        <span className="text-[10px] font-semibold px-2 py-1 rounded shrink-0 max-w-[120px] truncate"
          style={{ background: 'rgba(99,102,241,0.1)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.2)' }}>
          {job.final_recommendation}
        </span>
      ) : <div className="w-24" />}
      <div className="flex items-center gap-1 text-[11px] font-bold shrink-0" style={{ color: '#818cf8' }}>
        View <ChevronRight size={13} />
      </div>
    </div>
  );
}