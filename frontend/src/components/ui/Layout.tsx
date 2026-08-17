import React, { useState, useEffect, useCallback, useRef, createContext, useContext } from 'react';
import { Outlet, useNavigate, useLocation, Link, useParams } from 'react-router-dom';
import {
  Settings, ChevronDown,
  FileText, BookOpen, Bot, CheckCircle, AlertCircle, Clock,
  Loader2, LogOut, User, Home, History, LayoutDashboard,
  ShieldCheck, X, Send, Sparkles,
  MessageSquare, Trash2,
} from 'lucide-react';
import { getActivity, getToken, logout, getMe, streamChat, type ChatMsg, type ActivityGroup } from '../../api';
import AuthModal from './AuthModal';

// ── Contexts ──────────────────────────────────────────────────────────────────
export const AuthContext = createContext<{
  user: any;
  refresh: () => void;
  openAuth: (tab?: 'login' | 'register') => void;
}>({
  user: null,
  refresh: () => {},
  openAuth: () => {}
});
export function useAuth() { return useContext(AuthContext); }

export default function Layout() {
  const [activityGroups, setActivityGroups] = useState<ActivityGroup[]>([]);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [authOpen, setAuthOpen] = useState(false);
  const [authTab, setAuthTab] = useState<'login' | 'register'>('login');
  const navigate = useNavigate();
  const location = useLocation();

  const openAuth = useCallback((tab: 'login' | 'register' = 'login') => {
    setAuthTab(tab);
    setAuthOpen(true);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      logout();
      return;
    }
    try {
      setUser(await getMe());
    } catch (err: any) {
      setUser(null);
      if (err?.response?.status === 401) {
        logout();
      }
    }
  }, []);

  const fetchActivity = useCallback(async () => {
    if (!getToken()) {
      setLoadingActivity(false);
      setActivityGroups([]);
      return;
    }
    try {
      const { getActivity: ga } = await import('../../api');
      const data = await ga();
      setActivityGroups(data.groups);
    } catch (err: any) {
      if (err?.response?.status === 401) {
        logout();
        setUser(null);
        setActivityGroups([]);
      }
    } finally {
      setLoadingActivity(false);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      await refreshUser();
      if (getToken()) {
        await fetchActivity();
      }
    };
    init();

    const iv = setInterval(() => {
      if (getToken()) {
        fetchActivity();
      }
    }, 30_000);

    return () => clearInterval(iv);
  }, [fetchActivity, refreshUser]);

  useEffect(() => {
    if (getToken()) fetchActivity();
  }, [location.pathname, fetchActivity]);

  const initials = user?.username ? user.username.slice(0, 2).toUpperCase() : '?';

  // Extract job_id from review page; also check localStorage for last uploaded paper
  const jobIdMatch = location.pathname.match(/\/review\/([^/]+)/);
  const chatJobId = jobIdMatch?.[1] ?? null;

  // Get paper_id: from review job's paper, or from last uploaded paper stored in localStorage
  const [lastPaperId, setLastPaperId] = React.useState<string | null>(
    () => localStorage.getItem('spr_last_paper_id')
  );

  // Listen for paper uploads via custom event
  React.useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail?.paperId) {
        localStorage.setItem('spr_last_paper_id', e.detail.paperId);
        setLastPaperId(e.detail.paperId);
      }
    };
    window.addEventListener('spr:paper_uploaded', handler as EventListener);
    return () => window.removeEventListener('spr:paper_uploaded', handler as EventListener);
  }, []);

  return (
    <AuthContext.Provider value={{ user, refresh: refreshUser, openAuth }}>
        <div className="flex flex-col h-screen bg-[#0d0f1a] font-sans overflow-hidden">

          {/* ── Top Nav ───────────────────────────────────────────────── */}
          <TopNav user={user} showUserMenu={showUserMenu}
            onToggleUserMenu={() => setShowUserMenu(v => !v)}
            onCloseUserMenu={() => setShowUserMenu(false)}
            onLogout={() => { logout(); setUser(null); setActivityGroups([]); navigate('/'); setShowUserMenu(false); }}
            initials={initials}
            chatOpen={chatOpen} onToggleChat={() => setChatOpen(v => !v)}
            onOpenAuth={() => openAuth('login')} />

          {/* ── 3-Column Workspace ─────────────────────────────────────── */}
          <div className="flex-1 flex overflow-hidden">

            {/* LEFT: Activity + Nav — hidden on mobile */}
            <aside className="hidden md:flex w-[240px] bg-[#13151f] flex-col shrink-0 text-slate-300 border-r border-[#252840]">
              <div className="px-4 pt-4 pb-3 border-b border-[#252840]">
                <h2 className="font-bold text-white text-sm tracking-tight">Activity History</h2>
                <p className="text-[10px] text-indigo-400/60 mt-0.5">Your project timeline</p>
              </div>
              <nav className="px-2 py-2 border-b border-[#252840] flex flex-col gap-0.5">
                <SideNavLink to="/" label="Home" icon={<Home size={14} />} current={location.pathname} />
                <SideNavLink to="/dashboard" label="Dashboard" icon={<LayoutDashboard size={14} />} current={location.pathname} />
                <SideNavLink to="/history" label="Review History" icon={<History size={14} />} current={location.pathname} />
                {user?.is_admin && <SideNavLink to="/admin" label="Control Center" icon={<ShieldCheck size={14} />} current={location.pathname} />}
              </nav>
              <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
                {!getToken() ? (
                  <EmptyState icon={<User size={20} className="text-slate-600" />} title="Not signed in" sub="Log in to see your activity timeline." />
                ) : loadingActivity ? (
                  <div className="flex justify-center py-10"><Loader2 size={16} className="animate-spin text-slate-500" /></div>
                ) : activityGroups.length === 0 ? (
                  <EmptyState icon={<Clock size={20} className="text-slate-600" />} title="No activity yet" sub="Upload a paper to see your timeline." />
                ) : (
                  activityGroups.map((group, gi) => (
                    <TimelineGroup key={gi} date={group.date}>
                      {group.events.map((event, ei) => {
                        const isLast = ei === group.events.length - 1 && gi === activityGroups.length - 1;
                        const iconMap: Record<string, React.ReactNode> = {
                          file: <FileText size={11} />, bot: <Bot size={11} />,
                          check: <CheckCircle size={11} />, check_circle: <CheckCircle size={11} />,
                          alert: <AlertCircle size={11} />, book: <BookOpen size={11} />,
                        };
                        const colorMap: Record<string, string> = {
                          blue: 'bg-blue-500', indigo: 'bg-indigo-500', emerald: 'bg-emerald-500',
                          purple: 'bg-purple-500', amber: 'bg-amber-500', red: 'bg-red-500',
                        };
                        return (
                          <TimelineItem key={event.id}
                            time={new Date(event.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
                            icon={iconMap[event.icon] || <CheckCircle size={11} />}
                            iconBg={colorMap[event.color] || 'bg-slate-500'}
                            title={event.title} subtitle={event.subtitle} user={event.user}
                            isLast={isLast} jobId={event.job_id} />
                        );
                      })}
                    </TimelineGroup>
                  ))
                )}
              </div>
            </aside>

            {/* CENTER: Main content */}
            <main className="flex-1 overflow-y-auto bg-[#0d0f1a]">
              <div className="max-w-4xl mx-auto h-full p-6">
                <Outlet />
              </div>
            </main>

            {/* RIGHT: AI Chat Panel */}
            {chatOpen && (
              <div className="hidden lg:flex flex-shrink-0">
                <AIChatPanel jobId={chatJobId} paperId={lastPaperId} onClose={() => setChatOpen(false)} />
              </div>
            )}
          </div>

          <AuthModal
            isOpen={authOpen}
            initialTab={authTab}
            onClose={() => setAuthOpen(false)}
            onSuccess={refreshUser}
          />

          <style>{`
            .custom-scrollbar::-webkit-scrollbar { width: 3px; }
            .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
            .custom-scrollbar::-webkit-scrollbar-thumb { background: #252840; border-radius: 4px; }
          `}</style>
        </div>
    </AuthContext.Provider>
  );
}

// ── AI Chat Panel ─────────────────────────────────────────────────────────────
function AIChatPanel({ jobId, paperId, onClose }: { jobId: string | null; paperId: string | null; onClose: () => void }) {
  const storageKey = `spr_chat_${jobId || paperId || 'general'}`;
  const hasPaperContext = !!(jobId || paperId);
  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [input, setInput]       = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // Persist messages to localStorage on change
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(messages)); } catch {}
  }, [messages, storageKey]);

  // Greet only if no saved messages — but update greeting if paper context changes
  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    const savedMsgs = saved ? JSON.parse(saved) : [];
    // If only the greeting message exists (1 assistant msg, no user msgs), replace it
    const onlyGreeting = savedMsgs.length === 1 && savedMsgs[0].role === 'assistant';
    if (savedMsgs.length === 0 || onlyGreeting) {
      const greeting: ChatMsg = {
        role: 'assistant',
        content: hasPaperContext
          ? "I can see your paper is being reviewed. While the agents work, ask me anything — methodology, key findings, equations, related work, or a plain-English summary of what you submitted."
          : "Hi! I'm your Scientific Paper Reviewer assistant. Upload a paper first, then I can answer detailed questions about it. Or ask me general research questions.",
      };
      setMessages([greeting]);
    }
  }, [hasPaperContext]);

  // Only auto-scroll if user is already near the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!userScrolledUp.current || isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamText]);

  // When user sends a message, always scroll to bottom
  const scrollToBottom = () => {
    userScrolledUp.current = false;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    userScrolledUp.current = !isNearBottom;
  };

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    scrollToBottom();

    const userMsg: ChatMsg = { role: 'user', content: text };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setStreaming(true);
    setStreamText('');

    let accumulated = '';
    abortRef.current = streamChat(
      text, newHistory.slice(-10), paperId, jobId,
      (token) => { accumulated += token; setStreamText(accumulated); },
      () => {
        setMessages(prev => [...prev, { role: 'assistant', content: accumulated }]);
        setStreamText('');
        setStreaming(false);
        abortRef.current = null;
      },
      (err) => {
        // Translate raw network errors into helpful messages
        let msg = err;
        if (err.toLowerCase().includes('fetch') || err.toLowerCase().includes('network') || err.toLowerCase().includes('failed to fetch')) {
          msg = 'Cannot reach the backend. Make sure the server is running on port 8000.';
        } else if (err.includes('503') || err.toLowerCase().includes('no llm') || err.toLowerCase().includes('api key')) {
          msg = 'No LLM API key is configured. Add OPENAI_API_KEY or ANTHROPIC_API_KEY to backend/.env and restart the server.';
        }
        setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${msg}` }]);
        setStreamText('');
        setStreaming(false);
      },
    );
  };

  const stop = () => { abortRef.current?.abort(); setStreaming(false); setStreamText(''); };
  const clear = () => {
    try { localStorage.removeItem(storageKey); } catch {}
    setMessages([]);
    stop();
  };

  const SUGGESTIONS = hasPaperContext
    ? ['Summarise this paper', 'Explain the methodology', 'What are the key findings?', 'What are the weaknesses?']
    : ['What makes a good paper?', 'Explain peer review', 'How does LangGraph work?'];

  return (
    <aside className="w-[320px] bg-[#13151f] border-l border-[#252840] flex flex-col shrink-0">

      {/* Header */}
      <div className="h-14 border-b border-[#252840] flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}>
              <Sparkles size={15} className="text-white" />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 border-2 border-[#13151f] rounded-full" />
          </div>
          <div>
            <p className="text-sm font-bold text-white">Research Assistant</p>
            {hasPaperContext && <p className="text-[10px] text-indigo-400 font-medium">Paper context loaded</p>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={clear} title="Clear chat"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-indigo-400/40 hover:bg-indigo-500/10 hover:text-indigo-300 transition-colors">
            <Trash2 size={13} />
          </button>
          <button onClick={onClose} title="Close chat"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-indigo-400/40 hover:bg-indigo-500/10 hover:text-indigo-300 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar" style={{ scrollbarColor: '#252840 transparent' }}>
        {messages.map((msg, i) => (
          <ChatBubble key={i} msg={msg} />
        ))}

        {streaming && streamText && (
          <ChatBubble msg={{ role: 'assistant', content: streamText }} streaming />
        )}
        {streaming && !streamText && (
          <div className="flex gap-1 px-3 py-2">
            {[0,1,2].map(i => (
              <div key={i} className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </div>
        )}

        {messages.filter(m => m.role === 'user').length === 0 && !streaming && (
          <div className="space-y-1.5 mt-2">
            <p className="text-[10px] font-bold text-indigo-400/50 uppercase tracking-wider px-1">Try asking</p>
            {SUGGESTIONS.map(s => (
              <button key={s} onClick={() => { setInput(s); }}
                className="w-full text-left text-xs text-indigo-200/70 hover:text-indigo-200
                  border rounded-lg px-3 py-2 transition-all hover:border-indigo-500/40"
                style={{ background: 'rgba(99,102,241,0.06)', borderColor: 'rgba(99,102,241,0.15)' }}>
                {s}
              </button>
            ))}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-[#252840] shrink-0">
        <div className="flex items-end gap-2 rounded-xl transition-all"
          style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.18)' }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask anything about your research…"
            rows={2}
            className="flex-1 bg-transparent px-3 py-2.5 text-[13px] text-indigo-100/80 placeholder:text-indigo-400/30
              resize-none focus:outline-none leading-relaxed"
          />
          <div className="flex items-center gap-1 p-2">
            {streaming ? (
              <button onClick={stop}
                className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)' }}>
                <div className="w-3 h-3 bg-red-400 rounded-sm" />
              </button>
            ) : (
              <button onClick={send} disabled={!input.trim()}
                className="w-8 h-8 flex items-center justify-center rounded-lg transition-all"
                style={input.trim() ? {
                  background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                  boxShadow: '0 2px 12px rgba(99,102,241,0.4)',
                } : {
                  background: 'rgba(99,102,241,0.08)',
                  cursor: 'not-allowed',
                }}>
                <Send size={14} className={input.trim() ? 'text-white' : 'text-indigo-500/30'} />
              </button>
            )}
          </div>
        </div>
        <p className="text-[10px] text-indigo-400/30 text-center mt-2">
          {hasPaperContext ? '📄 Paper context active' : 'Upload a paper for full context'} · Enter to send
        </p>
      </div>
    </aside>
  );
}

function ChatBubble({ msg, streaming = false }: { msg: ChatMsg; streaming?: boolean }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] text-white rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-[13px] leading-relaxed"
          style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}>
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5 items-start">
      <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}>
        <Sparkles size={12} className="text-white" />
      </div>
      <div className="max-w-[88%] rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-[13px] leading-relaxed"
        style={{
          background: 'rgba(99,102,241,0.08)',
          border: streaming ? '1px solid rgba(99,102,241,0.35)' : '1px solid rgba(99,102,241,0.15)',
          color: '#c7d2fe',
        }}>
        {msg.content}
        {streaming && <span className="inline-block w-1 h-3.5 bg-indigo-400 ml-0.5 animate-pulse rounded-sm" />}
      </div>
    </div>
  );
}

// ── Top Navigation ────────────────────────────────────────────────────────────
function TopNav({ user, showUserMenu, onToggleUserMenu,
  onCloseUserMenu, onLogout, initials, chatOpen, onToggleChat, onOpenAuth }: any) {
  return (
    <header className="h-14 bg-[#13151f] border-b border-[#252840] flex items-center justify-between px-5 shrink-0 z-10">
      {/* Logo */}
      <Link to="/" className="flex items-center gap-2.5 shrink-0 group">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center font-black select-none shadow-lg"
          style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
          <span className="text-white text-[10px] font-black tracking-tight">SPR</span>
        </div>
        <div className="flex flex-col leading-none">
          <span className="font-extrabold text-white text-[14px] tracking-tight group-hover:text-indigo-300 transition-colors">
            Scientific <span style={{ background: 'linear-gradient(90deg,#818cf8,#a78bfa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Paper Reviewer</span>
          </span>
          <span className="text-[9px] text-zinc-600 font-medium tracking-widest uppercase">AI Peer Review Platform</span>
        </div>
      </Link>

      {/* Right controls */}
      <div className="flex items-center gap-1.5">
        <Link to="/profile"
          className="w-8 h-8 flex items-center justify-center text-indigo-400/50 hover:text-indigo-300 hover:bg-indigo-500/10 rounded-lg transition-colors"
          title="Settings">
          <Settings size={16} />
        </Link>

        <button onClick={onToggleChat}
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
            chatOpen
              ? 'bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/30'
              : 'text-indigo-400/50 hover:text-indigo-300 hover:bg-indigo-500/10'
          }`}
          title="AI Research Assistant">
          <MessageSquare size={16} />
        </button>

        <div className="h-4 w-px bg-indigo-500/15 mx-1" />

        {user ? (
          <div className="relative">
            <button onClick={onToggleUserMenu}
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-indigo-500/10 transition-colors">
              <div className="w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs select-none text-white"
                style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}>
                {initials}
              </div>
              <ChevronDown size={12} className="text-indigo-400/50" />
            </button>
            {showUserMenu && (
              <div className="absolute right-0 mt-1.5 w-52 rounded-xl shadow-2xl z-50 overflow-hidden"
                style={{ background: '#13151f', border: '1px solid rgba(99,102,241,0.2)' }}>
                <div className="px-4 py-3" style={{ borderBottom: '1px solid rgba(99,102,241,0.12)' }}>
                  <p className="text-sm font-bold text-white">{user.username}</p>
                  <p className="text-xs text-indigo-300/50 truncate mt-0.5">{user.email}</p>
                  {user.is_admin && (
                    <span className="text-[10px] font-bold text-amber-400 mt-1.5 inline-block px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.25)' }}>
                      Admin
                    </span>
                  )}
                </div>
                <Link to="/profile"
                  className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-indigo-200/70 hover:bg-indigo-500/10 hover:text-indigo-200 transition-colors"
                  onClick={onCloseUserMenu}>
                  <User size={14} /> Profile & Settings
                </Link>
                {user.is_admin && (
                  <Link to="/admin"
                    className="flex items-center gap-2.5 px-4 py-2.5 text-sm text-indigo-200/70 hover:bg-indigo-500/10 hover:text-indigo-200 transition-colors"
                    onClick={onCloseUserMenu}>
                    <ShieldCheck size={14} /> Control Center
                  </Link>
                )}
                <div style={{ borderTop: '1px solid rgba(99,102,241,0.12)' }} />
                <button onClick={onLogout}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-400/80 hover:bg-red-500/10 hover:text-red-400 transition-colors">
                  <LogOut size={14} /> Logout
                </button>
              </div>
            )}
          </div>
        ) : (
          <button onClick={onOpenAuth}
            className="flex items-center gap-1.5 text-white px-4 py-1.5 rounded-lg font-semibold text-sm transition-all"
            style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', boxShadow: '0 2px 12px rgba(99,102,241,0.4)' }}>
            Sign In
          </button>
        )}
      </div>
    </header>
  );
}

// ── Sidebar nav link ──────────────────────────────────────────────────────────
function SideNavLink({ to, label, icon, current }: { to: string; label: string; icon: React.ReactNode; current: string }) {
  const active = current === to || (to !== '/' && current.startsWith(to));
  return (
    <Link to={to} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-all ${
      active
        ? 'text-indigo-300'
        : 'text-indigo-400/40 hover:text-indigo-300 hover:bg-indigo-500/8'
    }`}
    style={active ? {
      background: 'rgba(99,102,241,0.12)',
      border: '1px solid rgba(99,102,241,0.2)',
    } : {}}>
      {icon}{label}
    </Link>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function EmptyState({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center text-center py-10 px-2">
      <div className="mb-2 opacity-30">{icon}</div>
      <p className="text-[11px] font-semibold text-indigo-300/50">{title}</p>
      <p className="text-[10px] text-indigo-300/30 mt-1 leading-relaxed">{sub}</p>
    </div>
  );
}
function TimelineGroup({ date, children }: { date: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <p className="text-[9px] font-bold text-indigo-400/40 uppercase tracking-wider mb-2">{date}</p>
      <div className="relative">{children}</div>
    </div>
  );
}
function TimelineItem({ time, icon, iconBg, title, subtitle, user, isLast, jobId }: any) {
  const navigate = useNavigate();
  return (
    <div className={`relative pl-6 pb-4 ${jobId ? 'cursor-pointer' : ''}`}
      onClick={() => jobId && navigate(`/review/${jobId}`)}>
      {!isLast && <div className="absolute left-[10px] top-5 bottom-0 w-px" style={{ background: 'rgba(99,102,241,0.15)' }} />}
      <div className="absolute left-0 top-1 w-5 h-5 rounded-full flex items-center justify-center z-10"
        style={{ background: '#13151f', border: '1px solid rgba(99,102,241,0.2)' }}>
        <div className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(99,102,241,0.5)' }} />
      </div>
      <div className="rounded-lg p-2 transition-colors"
        style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.1)' }}
        onMouseEnter={e => (e.currentTarget.style.background = jobId ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.1)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.05)')}>
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-md ${iconBg} text-white flex items-center justify-center flex-shrink-0 opacity-80`}>{icon}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold text-indigo-100/80 truncate">{title}</p>
              <span className="text-[9px] text-indigo-400/40 ml-1 shrink-0">{time}</span>
            </div>
            <p className="text-[10px] text-indigo-300/40 truncate">{subtitle}</p>
          </div>
        </div>
      </div>
    </div>
  );
}