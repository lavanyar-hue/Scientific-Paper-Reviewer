import { CheckCircle2, Circle, XCircle, Loader2 } from 'lucide-react'
import type { AgentResponse, AgentReview } from '../api'
import RecommendationBadge from './RecommendationBadge'

const STAGES = [
  { group: 'A',     role: 'primary',     label: 'Group A — Primary Review',    num: 1 },
  { group: 'A',     role: 'critic',      label: 'Group A — Critic Refinement', num: 2 },
  { group: 'B',     role: 'primary',     label: 'Group B — Primary Review',    num: 3 },
  { group: 'B',     role: 'critic',      label: 'Group B — Critic Refinement', num: 4 },
  { group: 'FINAL', role: 'synthesizer', label: 'Synthesizer — Final Verdict', num: 5 },
] as const

type Status = 'pending' | 'running' | 'done' | 'failed'

function getStatus(group: string, role: string, responses: AgentResponse[], jobStatus: string): Status {
  const found = responses.find(r => r.group === group && r.agent_role === role)
  if (found) return found.status === 'failed' ? 'failed' : 'done'
  if (jobStatus === 'processing') {
    const done = new Set(responses.map(r => `${r.group}:${r.agent_role}`))
    const firstPending = STAGES.findIndex(s => !done.has(`${s.group}:${s.role}`))
    if (STAGES.findIndex(s => s.group === group && s.role === role) === firstPending) return 'running'
  }
  return 'pending'
}

export default function ProgressTracker({ responses, jobStatus }: { responses: AgentResponse[]; jobStatus: string }) {
  const doneN = STAGES.filter(s =>
    responses.some(r => r.group === s.group && r.agent_role === s.role && r.status === 'completed')
  ).length
  const pct = Math.round((doneN / STAGES.length) * 100)

  return (
    <div className="rounded-2xl overflow-hidden animate-fade-in"
      style={{ background: 'rgba(13,15,26,0.8)', border: '1px solid rgba(99,102,241,0.18)' }}>

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4"
        style={{ borderBottom: '1px solid rgba(99,102,241,0.12)' }}>
        <h3 className="text-sm font-bold text-white tracking-tight">Review Progress</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-indigo-400/60">{doneN} / {STAGES.length} agents</span>
          <span className="text-xs font-bold" style={{ color: pct === 100 ? '#6ee7b7' : '#818cf8' }}>{pct}%</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-0.5" style={{ background: 'rgba(99,102,241,0.1)' }}>
        <div className="h-full transition-all duration-700"
          style={{
            width: `${pct}%`,
            background: pct === 100
              ? 'linear-gradient(90deg,#10b981,#6ee7b7)'
              : 'linear-gradient(90deg,#6366f1,#a78bfa)',
          }} />
      </div>

      {/* Stage rows */}
      <div>
        {STAGES.map((stage, i) => {
          const status = getStatus(stage.group, stage.role, responses, jobStatus)
          const ar     = responses.find(r => r.group === stage.group && r.agent_role === stage.role)
          const review = ar?.response as AgentReview | null

          const rowBg = status === 'running' ? 'rgba(99,102,241,0.08)'
                      : status === 'failed'  ? 'rgba(239,68,68,0.06)'
                      : status === 'done'    ? 'rgba(16,185,129,0.04)'
                      : 'transparent'

          return (
            <div key={i}
              className="px-5 py-3.5 transition-all duration-300"
              style={{
                background: rowBg,
                borderBottom: i < STAGES.length - 1 ? '1px solid rgba(99,102,241,0.08)' : 'none',
              }}>
              <div className="flex items-center gap-3">

                {/* Status icon */}
                <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
                  {status === 'done'    && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                  {status === 'running' && <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />}
                  {status === 'failed'  && <XCircle className="w-5 h-5 text-red-400" />}
                  {status === 'pending' && <Circle className="w-5 h-5 text-indigo-400/20" />}
                </div>

                {/* Number badge */}
                <div className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-black flex-shrink-0"
                  style={{
                    background: status === 'done'    ? 'rgba(16,185,129,0.2)'
                              : status === 'running' ? 'rgba(99,102,241,0.2)'
                              : status === 'failed'  ? 'rgba(239,68,68,0.2)'
                              : 'rgba(99,102,241,0.06)',
                    color: status === 'done'    ? '#6ee7b7'
                         : status === 'running' ? '#a5b4fc'
                         : status === 'failed'  ? '#fca5a5'
                         : '#4f46e5',
                  }}>
                  {i + 1}
                </div>

                {/* Label */}
                <span className="flex-1 text-sm font-medium"
                  style={{
                    color: status === 'running' ? '#a5b4fc'
                         : status === 'done'    ? '#e2e4f0'
                         : status === 'failed'  ? '#fca5a5'
                         : 'rgba(99,102,241,0.35)',
                  }}>
                  {stage.label}
                  {status === 'running' && (
                    <span className="ml-2 text-xs text-indigo-400/60 font-normal animate-pulse">processing…</span>
                  )}
                </span>

                {/* Right: model name hidden + score + badge */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {status === 'done' && review?.scores?.overall != null && (
                    <span className="text-sm font-black tabular-nums text-indigo-200">
                      {review.scores.overall.toFixed(1)}
                      <span className="text-[10px] text-indigo-400/50 font-normal">/10</span>
                    </span>
                  )}
                  {status === 'done' && review?.scores?.overall == null && (
                    <span className="text-[11px] text-indigo-400/30">—/10</span>
                  )}
                  {status === 'done' && review?.recommendation && (
                    <RecommendationBadge rec={review.recommendation} size="sm" />
                  )}
                  {status === 'pending' && (
                    <span className="text-[10px] text-indigo-400/30">waiting</span>
                  )}
                </div>
              </div>

              {/* Summary */}
              {status === 'done' && review?.paper_summary && (
                <p className="mt-2 ml-14 text-xs leading-relaxed line-clamp-2 animate-fade-in"
                  style={{ color: 'rgba(165,180,252,0.5)' }}>
                  {review.paper_summary}
                </p>
              )}

              {/* Error */}
              {status === 'failed' && ar?.error_message && (
                <p className="mt-1.5 ml-14 text-xs text-red-400/80 leading-relaxed animate-fade-in">
                  {ar.error_message.includes('LLM call failed')
                    ? 'AI service temporarily unavailable — try again'
                    : ar.error_message.includes('rate') || ar.error_message.includes('429')
                    ? 'Rate limit hit — the AI provider was overloaded'
                    : ar.error_message.includes('timeout') || ar.error_message.includes('timed out')
                    ? 'Request timed out — paper may be too large or service is slow'
                    : ar.error_message.length > 80
                    ? 'Review failed — please try submitting the paper again'
                    : ar.error_message}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
