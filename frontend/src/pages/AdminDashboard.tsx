import React, { useState, useEffect } from 'react';
import { Activity, Users, BarChart3, CheckCircle, Clock, Server, Database, ShieldAlert, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { getAdminStats, getChartData, type AdminStats } from '../api';

const CARD = { background: 'rgba(13,15,26,0.7)', border: '1px solid rgba(99,102,241,0.18)' };

export default function AdminDashboard() {
  const [stats, setStats]       = useState<AdminStats | null>(null);
  const [chartData, setChartData] = useState<any>(null);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const fetchData = async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setError(null);
      const [statsRes] = await Promise.all([getAdminStats()]);
      setStats(statsRes);
      // Use real daily reviews from backend instead of fake data
      const weekly = (statsRes as any).daily_reviews || [];
      if (weekly.length === 0) {
        const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        weekly.push(...days.map(name => ({ name, reviews: 0 })));
      }
      setChartData(weekly);
    } catch (err: any) {
      setError(err?.response?.data?.detail || 'Failed to load stats');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="animate-spin text-indigo-400" size={32} />
    </div>
  );

  if (error || !stats) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center">
        <AlertCircle size={32} className="text-red-400 mx-auto mb-2" />
        <p className="text-red-300 text-sm">{error || 'Failed to load'}</p>
        <button onClick={() => fetchData(true)} className="mt-3 text-xs text-indigo-400 underline">Retry</button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6 pb-10 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Control Center</h2>
          <p className="text-sm mt-1" style={{ color: 'rgba(165,180,252,0.45)' }}>System monitoring and aggregate statistics.</p>
        </div>
        <button onClick={() => fetchData(true)} disabled={refreshing}
          className="p-2 rounded-xl transition-all disabled:opacity-50"
          style={{ border: '1px solid rgba(99,102,241,0.2)', background: 'rgba(99,102,241,0.06)', color: '#a5b4fc' }}>
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-6 gap-3">
        {[
          { icon: <Activity size={18} />, label: 'Total Reviews',  value: stats.total_reviews,    color: '#818cf8' },
          { icon: <Users size={18} />,    label: 'Total Users',    value: stats.total_users,      color: '#60a5fa' },
          { icon: <BarChart3 size={18} />,label: 'Avg Score',      value: stats.average_score,    color: '#6ee7b7' },
          { icon: <CheckCircle size={18} />,label: 'Completed',    value: stats.completed_reviews,color: '#34d399' },
          { icon: <ShieldAlert size={18} />,label: 'Failed',       value: stats.failed_reviews,   color: stats.failed_reviews > 0 ? '#fca5a5' : '#6ee7b7' },
          { icon: <Clock size={18} />,    label: 'Processing',     value: stats.processing_reviews,color: '#a78bfa' },
        ].map((m, i) => (
          <div key={i} className="rounded-2xl p-4 flex flex-col gap-3 transition-all hover:scale-[1.02] animate-fade-in"
            style={{ ...CARD, animationDelay: `${i * 0.05}s` }}>
            {/* Icon */}
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: m.color + '18', border: `1px solid ${m.color}28`, color: m.color }}>
              {m.icon}
            </div>
            {/* Value */}
            <div>
              <p className="text-3xl font-black text-white leading-none mb-1.5">{m.value}</p>
              <p className="text-[11px] font-semibold" style={{ color: 'rgba(165,180,252,0.5)' }}>{m.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-5">

        {/* Chart */}
        <div className="col-span-2 rounded-2xl p-6" style={CARD}>
          <h3 className="text-sm font-bold text-white mb-1">Reviews This Week</h3>
          <p className="text-[11px] mb-5" style={{ color: 'rgba(165,180,252,0.4)' }}>Daily review activity</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.1)" vertical={false} />
                <XAxis dataKey="name" axisLine={false} tickLine={false}
                  tick={{ fontSize: 11, fill: 'rgba(165,180,252,0.4)' }} dy={8} />
                <YAxis axisLine={false} tickLine={false}
                  tick={{ fontSize: 11, fill: 'rgba(165,180,252,0.4)' }} dx={-8} />
                <Tooltip
                  contentStyle={{ background: '#13151f', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '10px', color: '#a5b4fc' }}
                  labelStyle={{ color: '#e2e4f0' }} />
                <Line type="monotone" dataKey="reviews" stroke="#6366f1" strokeWidth={2.5}                  dot={{ r: 4, fill: '#6366f1', strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: '#a78bfa' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* System Health */}
        <div className="rounded-2xl p-6" style={CARD}>
          <h3 className="text-sm font-bold text-white mb-1">System Health</h3>
          <p className="text-[11px] mb-5" style={{ color: 'rgba(165,180,252,0.4)' }}>Live service status</p>
          <div className="space-y-4">
            {[
              { icon: <Server size={15} />, label: 'Backend API', status: 'Operational', ok: true },
              { icon: <Database size={15} />, label: 'Database', status: `${stats.total_papers} papers`, ok: true },
              { icon: <Activity size={15} />, label: 'Review Pipeline', status: `${stats.active_model_count} models`, ok: true },
              { icon: <ShieldAlert size={15} />, label: 'Failed Reviews', status: `${stats.failed_reviews} failed`, ok: stats.failed_reviews === 0 },
            ].map((item, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span style={{ color: 'rgba(165,180,252,0.5)' }}>{item.icon}</span>
                  <span className="text-sm text-indigo-200/70">{item.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${item.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  <span className="text-xs" style={{ color: 'rgba(165,180,252,0.4)' }}>{item.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Processing Status */}
      <div className="rounded-2xl p-6" style={CARD}>
        <h3 className="text-sm font-bold text-white mb-5">Processing Status</h3>
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: 'Completed',  value: stats.completed_reviews,  color: '#6ee7b7', bg: 'rgba(16,185,129,0.12)',  border: 'rgba(16,185,129,0.25)' },
            { label: 'Processing', value: stats.processing_reviews, color: '#a5b4fc', bg: 'rgba(99,102,241,0.12)',  border: 'rgba(99,102,241,0.25)' },
            { label: 'Failed',     value: stats.failed_reviews,     color: '#fca5a5', bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.25)'  },
            { label: 'Total Papers', value: stats.total_papers,     color: '#818cf8', bg: 'rgba(99,102,241,0.1)',   border: 'rgba(99,102,241,0.2)'  },
          ].map((s, i) => (
            <div key={i} className="rounded-xl p-4 animate-fade-in"
              style={{ background: s.bg, border: `1px solid ${s.border}`, animationDelay: `${i * 0.08}s` }}>
              <p className="text-2xl font-bold mb-1" style={{ color: s.color }}>{s.value}</p>
              <p className="text-xs font-semibold" style={{ color: s.color + '80' }}>{s.label}</p>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
