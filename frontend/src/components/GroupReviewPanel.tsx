import { useState } from 'react'
import { ChevronDown, ChevronUp, MessageSquare, AlertTriangle } from 'lucide-react'
import type { AgentResponse, AgentReview } from '../api'
import ScoreBar from './ScoreBar'
import RecommendationBadge from './RecommendationBadge'

interface GroupProps {
  group: 'A' | 'B'
  responses: AgentResponse[]
}

const GROUP_META = {
  A: {
    label: 'Group A',
    accent: '#818cf8',
    border: 'rgba(99,102,241,0.25)',
    bg: 'rgba(99,102,241,0.06)',
    headerBg: 'rgba(99,102,241,0.1)',
    dot: '#6366f1',
  },
  B: {
    label: 'Group B',
    accent: '#a78bfa',
    border: 'rgba(139,92,246,0.25)',
    bg: 'rgba(139,92,246,0.06)',
    headerBg: 'rgba(139,92,246,0.1)',
    dot: '#8b5cf6',
  },
}

function AgentCard({ ar }: { ar: AgentResponse }) {
  const [open, setOpen] = useState(false)
  const review = ar.response as AgentReview | null

  if (ar.status === 'failed') {
    return (
      <div className="rounded-xl px-4 py-3 flex items-center gap-2.5 animate-fade-in"
        style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
        <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
        <div>
          <p className="text-xs font-semibold text-red-300">
            {ar.agent_role === 'primary' ? 'Primary Reviewer' : 'Critic / Refiner'} failed
          </p>
          <p className="text-[11px] text-red-400/70 mt-0.5">{ar.error_message}</p>
        </div>
      </div>
    )
  }
  if (!review) return null

  const roleLabel = ar.agent_role === 'primary' ? 'Primary Reviewer' : 'Critic / Refiner'

  return (
    <div className="rounded-xl overflow-hidden animate-slide-up"
      style={{ background: 'rgba(13,15,26,0.6)', border: '1px solid rgba(99,102,241,0.15)' }}>
      <button
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-all"
        style={{ background: open ? 'rgba(99,102,241,0.06)' : 'transparent' }}
        onClick={() => setOpen(v => !v)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-indigo-100">{roleLabel}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {review.recommendation && <RecommendationBadge rec={review.recommendation} size="sm" />}
          {review.scores?.overall != null && (
            <span className="text-sm font-bold tabular-nums text-indigo-200">
              {review.scores.overall.toFixed(1)}
              <span className="text-[10px] text-indigo-400/50">/10</span>
            </span>
          )}
          {open
            ? <ChevronUp className="w-4 h-4 text-indigo-400/50" />
            : <ChevronDown className="w-4 h-4 text-indigo-400/50" />}
        </div>
      </button>

      {open && (
        <div className="px-4 py-4 space-y-4 animate-fade-in"
          style={{ borderTop: '1px solid rgba(99,102,241,0.1)' }}>
          {review.paper_summary && (
            <p className="text-xs leading-relaxed italic"
              style={{ color: 'rgba(165,180,252,0.6)', borderLeft: '2px solid rgba(99,102,241,0.3)', paddingLeft: '0.75rem' }}>
              {review.paper_summary}
            </p>
          )}

          {review.scores && (
            <div className="space-y-2">
              <p className="text-[9px] font-black text-indigo-400/40 uppercase tracking-widest mb-2">Dimension Scores</p>
              {Object.entries(review.scores)
                .filter(([k]) => k !== 'overall')
                .map(([k, v]) => <ScoreBar key={k} label={k} value={v as number} />)}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3">
            {(review.strengths?.length ?? 0) > 0 && (
              <PointList title="Strengths" items={review.strengths ?? []} color="green" marker="+" />
            )}
            {(review.weaknesses?.length ?? 0) > 0 && (
              <PointList title="Weaknesses" items={review.weaknesses ?? []} color="red" marker="−" />
            )}
          </div>

          {review.detailed_feedback && (
            <div>
              <p className="text-[9px] font-black text-indigo-400/40 uppercase tracking-widest mb-1.5">Detailed Feedback</p>
              <p className="text-xs leading-relaxed" style={{ color: 'rgba(165,180,252,0.55)' }}>{review.detailed_feedback}</p>
            </div>
          )}

          {(review.questions_for_authors?.length ?? 0) > 0 && (
            <div>
              <p className="text-[9px] font-black text-indigo-400/40 uppercase tracking-widest mb-2">Questions for Authors</p>
              <ul className="space-y-1.5">
                {(review.questions_for_authors ?? []).map((q: string, i: number) => (
                  <li key={i} className="flex gap-2 text-xs" style={{ color: 'rgba(165,180,252,0.5)' }}>
                    <MessageSquare className="w-3.5 h-3.5 text-indigo-500/50 flex-shrink-0 mt-0.5" />
                    {q}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function GroupReviewPanel({ group, responses }: GroupProps) {
  const groupResponses = responses.filter(r => r.group === group)
  if (groupResponses.length === 0) return null
  const meta = GROUP_META[group]

  const critic  = groupResponses.find(r => r.agent_role === 'critic')
  const primary = groupResponses.find(r => r.agent_role === 'primary')
  const best = (critic?.response ?? primary?.response) as AgentReview | null
  const score = best?.scores?.overall

  return (
    <div className="rounded-2xl overflow-hidden animate-fade-in"
      style={{ background: meta.bg, border: `1px solid ${meta.border}` }}>
      <div className="px-5 py-4 flex items-center justify-between"
        style={{ background: meta.headerBg, borderBottom: `1px solid ${meta.border}` }}>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: meta.dot }} />
          <h3 className="font-bold text-base" style={{ color: meta.accent }}>{meta.label}</h3>
          <span className="text-xs" style={{ color: 'rgba(165,180,252,0.4)' }}>
            {groupResponses.length} agent{groupResponses.length > 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {best?.recommendation && <RecommendationBadge rec={best.recommendation} size="md" />}
          {score != null && (
            <span className="text-lg font-black tabular-nums text-indigo-100">
              {score.toFixed(1)}
            </span>
          )}
        </div>
      </div>

      <div className="p-4 space-y-3">
        {groupResponses.map(ar => <AgentCard key={ar.id} ar={ar} />)}
      </div>
    </div>
  )
}

function PointList({ title, items, color, marker }: { title: string; items: string[]; color: string; marker: string }) {
  const c: Record<string, string> = {
    green: '#6ee7b7', red: '#fca5a5', amber: '#fcd34d', orange: '#fdba74',
  }
  return (
    <div>
      <p className="text-[9px] font-black uppercase tracking-widest mb-1.5" style={{ color: c[color] + '80' }}>{title}</p>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 text-xs leading-relaxed" style={{ color: 'rgba(165,180,252,0.5)' }}>
            <span className="flex-shrink-0 font-bold mt-0.5 w-3" style={{ color: c[color] }}>{marker}</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
