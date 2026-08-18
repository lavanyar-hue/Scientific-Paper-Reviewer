/**
 * Typed API client for PaperLens backend.
 * Uses VITE_API_BASE environment variable.
 * In production (Vercel), set VITE_API_BASE to your Render backend URL.
 * Example: https://your-service.onrender.com
 */
import axios from 'axios';

// Detect if we're running on Vercel (production) with no backend configured
const PROD_BACKEND = 'https://scientific-paper-reviewer.onrender.com';
const BASE = import.meta.env.VITE_API_BASE ||
  (typeof window !== 'undefined' && window.location.hostname !== 'localhost'
    ? PROD_BACKEND
    : 'http://localhost:8000');

const api = axios.create({ baseURL: BASE });

// Inject Bearer token on every request if present
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Types ───────────────────────────────────────────────────────────────────────

export interface Paper {
  id: string;
  title: string | null;
  authors: string | null;
  arxiv_id?: string | null;
  abstract: string | null;
  research_field: string | null;
  created_at: string;
}

export interface Scores {
  novelty: number;
  technical_soundness: number;
  methodology: number;
  clarity: number;
  impact: number;
  overall: number;
}

export interface FinalReview {
  consolidated_summary: string;
  key_strengths: string[];
  key_weaknesses: string[];
  final_scores: Scores;
  final_recommendation: string;
  synthesis_rationale: string;
  detailed_final_feedback: string;
  confidence: 'High' | 'Medium' | 'Low';
}

export interface AgentReview {
  paper_summary?: string;
  scores?: Scores;
  recommendation?: string;
  strengths?: string[];
  weaknesses?: string[];
  detailed_feedback?: string;
  questions_for_authors?: string[];
  improvements_over_initial?: string[];
  new_concerns?: string[];
}

export interface AgentResponse {
  id: string;
  group: 'A' | 'B' | 'FINAL';
  agent_role: 'primary' | 'critic' | 'synthesizer';
  model_name: string | null;
  round_num: number;
  response: any | null;
  status: 'completed' | 'failed';
  error_message: string | null;
  created_at: string;
}

export interface ReviewJob {
  id: string;
  paper_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  final_review: FinalReview | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  agent_responses: AgentResponse[];
  paper: Paper | null;
}

export interface ReviewJobSummary {
  id: string;
  paper_id: string;
  status: string;
  paper_title: string | null;
  final_recommendation: string | null;
  overall_score: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface ModelConfig {
  group_a_primary?: string;
  group_a_critic?: string;
  group_b_primary?: string;
  group_b_critic?: string;
  synthesizer?: string;
}

export interface UserStats {
  total_reviews: number;
  total_papers: number;
  completed_reviews: number;
  average_score: number;
  average_time: string;
  username: string;
  email: string;
  is_admin: boolean;
  member_since: string;
}

export interface DashboardPaper {
  id: string;
  title: string;
  authors: string;
  tag: string;
  version: string;
  status: string;
  progress: number;
  agent: string;
  confidence: number | null;
  score: number | null;
  job_id: string | null;
  last_updated: string;
}

export interface ActivityEvent {
  id: string;
  type: string;
  icon: string;
  color: string;
  title: string;
  subtitle: string;
  user: string;
  timestamp: string;
  job_id?:string | null;
}

export interface ActivityGroup {
  date: string;
  events: ActivityEvent[];
}

export interface AdminStats {
  total_reviews: number;
  total_users: number;
  total_papers: number;
  completed_reviews: number;
  failed_reviews: number;
  processing_reviews: number;
  success_rate: number;
  average_score: number;
  active_models: string[];
  active_model_count: number;
}

// ── Auth ────────────────────────────────────────────────────────────────────────

export async function register(email: string, password: string, username?: string) {
  return api.post('/api/auth/register', { email, password, username });
}

export async function login(usernameOrEmail: string, password: string): Promise<string> {
  const form = new FormData();
  form.append('username', usernameOrEmail);
  form.append('password', password);
  const res = await api.post<{ access_token: string }>('/api/auth/login', form);
  const token = res.data.access_token;
  localStorage.setItem('token', token);
  return token;
}

export async function verifyOtp(email: string, otp: string): Promise<string> {
  const res = await api.post<{ access_token: string }>('/api/auth/verify-otp', { email, otp });
  const token = res.data.access_token;
  localStorage.setItem('token', token);
  return token;
}

export async function resendOtp(email: string): Promise<void> {
  await api.post('/api/auth/resend-otp', { email });
}

export async function ensureLoggedIn(): Promise<boolean> {
  // Check if user already has valid token
  if (getToken()) return true;
  // User must login manually - no auto-login for security
  return false;
}

export async function getMe() {
  const res = await api.get('/api/auth/me');
  return res.data;
}

export function logout() {
  localStorage.removeItem('token');
}

export function getToken(): string | null {
  return localStorage.getItem('token');
}

// ── Profile ────────────────────────────────────────────────────────────────────────

export async function updateProfileEmail(email: string) {
  const res = await api.put('/api/profile/email', null, {
    params: { new_email: email },
  });
  return res.data;
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const res = await api.post('/api/profile/change-password', null, {
    params: {
      current_password: currentPassword,
      new_password: newPassword,
    },
  });
  return res.data;
}

export async function deleteAccount(password: string) {
  const res = await api.delete('/api/profile/', {
    params: { password },
  });
  return res.data;
}

// ── Stats ───────────────────────────────────────────────────────────────────────

export async function getUserStats(): Promise<UserStats> {
  const res = await api.get<UserStats>('/api/stats/user');
  return res.data;
}

export async function getAdminStats(): Promise<AdminStats> {
  const res = await api.get<AdminStats>('/api/stats/admin');
  return res.data;
}

export async function getChartData(): Promise<{ score_trend: { name: string; score: number }[] }> {
  const res = await api.get('/api/stats/charts');
  return res.data;
}

export async function getActivity(): Promise<{ groups: ActivityGroup[] }> {
  const res = await api.get('/api/stats/activity');
  return res.data;
}

export async function getDashboardPapers(): Promise<{ papers: DashboardPaper[] }> {
  const res = await api.get('/api/stats/papers');
  return res.data;
}

// ── Papers ──────────────────────────────────────────────────────────────────────

export async function uploadPdf(file: File): Promise<Paper> {
  const form = new FormData();
  form.append('file', file);
  const res = await api.post<Paper>('/api/papers/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function fetchArxiv(arxivId: string): Promise<Paper> {
  const res = await api.post<Paper>('/api/papers/arxiv', { arxiv_id: arxivId });
  return res.data;
}

// ── Reviews ─────────────────────────────────────────────────────────────────────

export async function startReview(paperId: string, modelConfig?: ModelConfig): Promise<ReviewJob> {
  const res = await api.post<ReviewJob>('/api/review', {
    paper_id: paperId,
    model_config: modelConfig,
  });
  return res.data;
}

export async function cancelReview(jobId: string): Promise<void> {
  await api.post(`/api/review/${jobId}/cancel`);
}

export async function deletePaper(paperId: string): Promise<void> {
  await api.delete(`/api/papers/${paperId}`);
}

export async function getReview(jobId: string): Promise<ReviewJob> {
  const res = await api.get<ReviewJob>(`/api/review/${jobId}`);
  return res.data;
}

export async function getHistory(): Promise<ReviewJobSummary[]> {
  const res = await api.get<ReviewJobSummary[]>('/api/history');
  return res.data;
}

// ── Related Papers (OpenAlex) ────────────────────────────────────────────────

export interface RelatedPaper {
  title: string;
  authors: string;
  year: number | null;
  citations: number;
  url: string;
  open_access: boolean;
}

export async function getRelatedPapers(paperId: string, limit = 5): Promise<RelatedPaper[]> {
  try {
    const res = await api.get(`/api/papers/${paperId}/related`, { params: { limit } });
    return res.data.related || [];
  } catch {
    return [];
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────────────

export function openReviewSocket(
  jobId: string,
  onMessage: (data: any) => void,
  onClose?: () => void,
): WebSocket {
  const wsBase = BASE.replace('http', 'ws');
  const ws = new WebSocket(`${wsBase}/ws/review/${jobId}`);
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch { }
  };
  ws.onclose = onClose || (() => { });
  return ws;
}

// ── Fine-Tuning Guide ────────────────────────────────────────────────────────

export async function getFineTuneGuide(): Promise<any> {
  const res = await api.get('/api/finetune/guide');
  return res.data;
}

export async function exportTrainingData(limit = 500): Promise<any> {
  const res = await api.get('/api/finetune/export', { params: { limit } });
  return res.data;
}

// ── AI Research Assistant Chat ────────────────────────────────────────────────

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Stream a chat response via SSE.
 * Calls onToken for each streamed token, onDone when finished, onError on failure.
 * Returns an AbortController so the caller can cancel mid-stream.
 */
export function streamChat(
  message: string,
  history: ChatMsg[],
  paperId: string | null,
  jobId: string | null,
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
): AbortController {
  const controller = new AbortController();
  const token = localStorage.getItem('token');

  fetch(`${BASE}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      message,
      history: history.slice(-10),
      paper_id: paperId,
      job_id: jobId,
    }),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        // Try to read a JSON error body from the server
        let detail = `Server error ${res.status}`;
        try {
          const errBody = await res.json();
          if (errBody?.detail) detail = errBody.detail;
        } catch { /* ignore */ }
        onError(detail);
        onDone();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE lines: "data: {...}\n\n"
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const data = line.replace(/^data: /, '').trim();
          if (data === '[DONE]') { onDone(); return; }
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) { onError(parsed.error); onDone(); return; }
            if (parsed.token) onToken(parsed.token);
          } catch { /* partial chunk, ignore */ }
        }
      }
      onDone();
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        const msg = (err.message ?? 'Connection failed').toLowerCase().includes('fetch')
          ? 'Cannot reach backend. Make sure it is running on port 8000.'
          : (err.message ?? 'Connection failed');
        onError(msg);
      }
      onDone();
    });

  return controller;
}