"use client";

import Image from "next/image";
import {
  FormEvent,
  ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAgentStream } from "@/hooks/useAgentStream";
import {
  clearStoredAuth,
  getAuthHeaders,
  getServerUserSnapshot,
  getStoredToken,
  getUserSnapshot,
  setStoredAuth,
  subscribeAuth,
} from "@/lib/auth";
import {
  AgentRunPayload,
  PipelineStepId,
  Repository,
  RunStatus,
} from "@/types/agent";
import { UserProfile } from "@/types/auth";

const PIPELINE: {
  id: PipelineStepId;
  label: string;
  sectionId: string;
}[] = [
  { id: "retriever", label: "Retriever", sectionId: "section-retrieved" },
  { id: "planner", label: "Planner", sectionId: "section-plan" },
  { id: "coding", label: "Coding", sectionId: "section-files" },
  { id: "testing", label: "Testing", sectionId: "section-tests" },
  { id: "pr_creator", label: "PR Creator", sectionId: "section-pr" },
];

const IN_PROGRESS_STATUSES = new Set([
  "pending",
  "cloned",
  "indexing",
  "embedding",
]);

function parseUser(raw: string | null): UserProfile | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins === 0) return `${(ms / 1000).toFixed(1)}s`;
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

function parsePytestSummary(output: string | undefined): {
  passed: number;
  failed: number;
  errors: number;
  duration: string | null;
  collected: number | null;
} {
  if (!output) {
    return { passed: 0, failed: 0, errors: 0, duration: null, collected: null };
  }
  const passedMatch = output.match(/(\d+)\s+passed\b/i);
  const failedMatch = output.match(/(\d+)\s+failed\b/i);
  const errorMatch = output.match(/(\d+)\s+errors?\b/i);
  const durationMatch = output.match(/\bin\s+([0-9.]+s)\b/i);
  const collectedMatch = output.match(/collected\s+(\d+)\s+items?/i);

  const passed = passedMatch ? Number(passedMatch[1]) : 0;
  const failed = failedMatch ? Number(failedMatch[1]) : 0;
  const errors = errorMatch ? Number(errorMatch[1]) : 0;
  const collected = collectedMatch
    ? Number(collectedMatch[1])
    : passed + failed + errors > 0
    ? passed + failed + errors
    : null;

  return {
    passed,
    failed: failed + errors,
    errors,
    duration: durationMatch ? durationMatch[1] : null,
    collected,
  };
}

function parsePrMeta(
  prUrl: string | undefined,
  explicitTitle: string | null,
  explicitNumber: number | null,
  task: string
): { number: string | null; title: string } {
  let numStr = explicitNumber ? `#${explicitNumber}` : null;
  if (!numStr && prUrl) {
    const m = prUrl.match(/\/pull\/(\d+)/i);
    if (m) numStr = `#${m[1]}`;
  }
  const cleanTask = task.trim().split("\n")[0].replace(/^#+\s*/, "");
  const fallbackTitle =
    cleanTask.length > 72
      ? `${cleanTask.slice(0, 69)}…`
      : cleanTask || "Automated fix pull request";
  return {
    number: numStr,
    title: explicitTitle?.trim() || fallbackTitle,
  };
}

function splitPlanStep(rawStep: string): { title: string; detail: string } {
  const clean = rawStep.replace(/^\d+[\.\)]\s*/, "").trim();
  const colonIdx = clean.indexOf(":");
  if (colonIdx > 8 && colonIdx < 75) {
    return {
      title: clean.slice(0, colonIdx).trim(),
      detail: clean.slice(colonIdx + 1).trim(),
    };
  }
  const periodIdx = clean.indexOf(". ");
  if (periodIdx > 8 && periodIdx < 80) {
    return {
      title: clean.slice(0, periodIdx + 1).trim(),
      detail: clean.slice(periodIdx + 2).trim(),
    };
  }
  if (clean.length <= 76) {
    return { title: clean, detail: "" };
  }
  return {
    title: `${clean.slice(0, 73)}…`,
    detail: clean,
  };
}

function formatCodeIdentifiers(text: string): ReactNode[] {
  const tokenRegex =
    /(`[^`]+`|\b(?:src|tests)\/[\w./-]+\.py\b|\b[\w-]+\.py\b|\b[a-zA-Z_][a-zA-Z0-9_]*\(\)|\b[A-Z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+\b|\b[a-z]+_[a-z0-9_]+\b|\b[A-Z][A-Z0-9_]{2,}\b)/g;
  const parts = text.split(tokenRegex);
  return parts.map((part, idx) => {
    if (!part) return null;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={idx}
          className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--text)]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (
      /^(?:src|tests)\/|^[\w-]+\.py$|\(\)$|^[A-Z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+$|^[a-z]+_[a-z0-9_]+$|^[A-Z][A-Z0-9_]{2,}$/.test(
        part
      )
    ) {
      return (
        <code
          key={idx}
          className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[12px] font-medium text-[var(--text)]"
        >
          {part}
        </code>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}

function SpinnerIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`animate-spin ${className}`}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        className="opacity-25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GitHubIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

function CodePilotLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3.5">
      <div
        className={`relative flex shrink-0 items-center justify-center rounded-xl border border-[var(--brand-border)] bg-[var(--brand-tint)] ${
          compact ? "h-10 w-10" : "h-12 w-12"
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className={
            compact
              ? "h-5 w-5 text-[var(--brand)]"
              : "h-6 w-6 text-[var(--brand)]"
          }
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="7.5 8.5 3.5 12 7.5 15.5" />
          <polyline points="16.5 8.5 20.5 12 16.5 15.5" />
          <line x1="14" y1="6.5" x2="10" y2="17.5" />
        </svg>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <span
            className={`font-extrabold tracking-tight ${
              compact ? "text-xl sm:text-2xl" : "text-3xl sm:text-4xl"
            }`}
          >
            <span className="text-[var(--text)]">Code</span>
            <span className="bg-gradient-to-r from-[#2DD4BF] to-[#5EEAD4] bg-clip-text text-transparent">
              Pilot
            </span>
          </span>
        </div>
        <p className="text-xs font-medium text-[var(--text-muted)]">
          From Issue to Pull Request
        </p>
      </div>
    </div>
  );
}

function RunStatusPill({ runStatus }: { runStatus: RunStatus }) {
  const config: Record<
    RunStatus,
    {
      label: string;
      bg: string;
      border: string;
      text: string;
      dot: string;
      pulse: boolean;
    }
  > = {
    idle: {
      label: "Idle",
      bg: "var(--idle-tint)",
      border: "var(--idle-border)",
      text: "var(--text-muted)",
      dot: "var(--idle)",
      pulse: false,
    },
    running: {
      label: "Running",
      bg: "var(--running-tint)",
      border: "var(--running-border)",
      text: "var(--running)",
      dot: "var(--running)",
      pulse: true,
    },
    retrying: {
      label: "Retrying",
      bg: "var(--warning-tint)",
      border: "var(--warning-border)",
      text: "var(--warning)",
      dot: "var(--warning)",
      pulse: true,
    },
    completed: {
      label: "Completed",
      bg: "var(--success-tint)",
      border: "var(--success-border)",
      text: "var(--success)",
      dot: "var(--success)",
      pulse: false,
    },
    failed: {
      label: "Failed",
      bg: "var(--danger-tint)",
      border: "var(--danger-border)",
      text: "var(--danger)",
      dot: "var(--danger)",
      pulse: false,
    },
  };

  const current = config[runStatus];

  return (
    <span
      style={{
        backgroundColor: current.bg,
        borderColor: current.border,
        color: current.text,
      }}
      className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold"
    >
      <span
        style={{ backgroundColor: current.dot }}
        className={`h-2 w-2 rounded-full ${current.pulse ? "animate-pulse" : ""}`}
      />
      <span>{current.label}</span>
    </span>
  );
}

export default function AgentWorkspace() {
  const rawUser = useSyncExternalStore(
    subscribeAuth,
    getUserSnapshot,
    getServerUserSnapshot
  );
  const user = parseUser(rawUser);
  const userId = user?.id ?? null;

  // All state hooks declared with pure initializers for Next.js 16 & React 19 Compiler safety
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [loginLoading, setLoginLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<number | "">("");
  const [githubUrl, setGithubUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestSuccess, setIngestSuccess] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [issueNumber, setIssueNumber] = useState("");
  const [task, setTask] = useState("");
  const [lastPayload, setLastPayload] = useState<AgentRunPayload | null>(null);
  const [setupExpanded, setSetupExpanded] = useState(true);
  const [copiedPrLink, setCopiedPrLink] = useState(false);
  const [copiedTestLog, setCopiedTestLog] = useState(false);
  const [testLogExpanded, setTestLogExpanded] = useState(true);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [expandedPlanSteps, setExpandedPlanSteps] = useState<
    Record<number, boolean>
  >({
    0: true,
  });
  const [nowTick, setNowTick] = useState<number>(0);
  const [runSequence, setRunSequence] = useState<number>(0);
  const [dismissedToastSeq, setDismissedToastSeq] = useState<number | null>(
    null
  );
  const [timedOutToastSeq, setTimedOutToastSeq] = useState<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const { state, runStatus, runAgent, stopAgent, reset } = useAgentStream();

  const apiUrl = (process.env.NEXT_PUBLIC_API_URL || "")
    .trim()
    .replace(/\/+$/, "");

  const isBusy = runStatus === "running" || runStatus === "retrying";

  const showToast =
    runSequence > 0 &&
    (runStatus === "completed" || runStatus === "failed") &&
    dismissedToastSeq !== runSequence &&
    timedOutToastSeq !== runSequence;

  // Sync light/dark theme attribute on <html>
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Live elapsed timer tick while running or retrying
  useEffect(() => {
    if (!isBusy) return;
    const id = setInterval(() => setNowTick(Date.now()), 500);
    return () => clearInterval(id);
  }, [isBusy]);

  // Update document.title when runStatus changes
  useEffect(() => {
    if (runStatus === "running") {
      document.title = "⏳ Running · CodePilot";
    } else if (runStatus === "retrying") {
      document.title = "↻ Retrying · CodePilot";
    } else if (runStatus === "completed") {
      document.title = "✓ PR ready · CodePilot";
    } else if (runStatus === "failed") {
      document.title = "✗ Failed · CodePilot";
    } else {
      document.title = "CodePilot — From Issue to Pull Request";
    }
  }, [runStatus]);

  // Auto-dismiss completion/failure toast after 5 seconds
  useEffect(() => {
    if (!showToast) return;
    const seq = runSequence;
    const id = setTimeout(() => setTimedOutToastSeq(seq), 5000);
    return () => clearTimeout(id);
  }, [showToast, runSequence]);

  // Auto-grow Engineering Task textarea up to 8 rows (~208px)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(Math.max(el.scrollHeight, 84), 208);
    el.style.height = `${nextHeight}px`;
  }, [task, setupExpanded]);

  // Verify stored JWT session on mount
  useEffect(() => {
    const token = getStoredToken();
    if (!token || !apiUrl || !userId) return;

    let cancelled = false;
    fetch(`${apiUrl}/auth/me`, {
      headers: { ...getAuthHeaders() },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          clearStoredAuth();
          setRepos([]);
          setSelectedRepoId("");
          return;
        }
        if (res.ok) {
          const freshUser: UserProfile = await res.json();
          const currentToken = getStoredToken();
          if (currentToken) {
            setStoredAuth({
              access_token: currentToken,
              token_type: "bearer",
              user: freshUser,
            });
          }
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [apiUrl, userId]);

  // Load authenticated user's repositories
  useEffect(() => {
    if (!apiUrl || !userId) return;

    let cancelled = false;

    async function loadUserRepos() {
      try {
        const res = await fetch(`${apiUrl}/repositories/`, {
          headers: { ...getAuthHeaders() },
        });
        if (cancelled) return;
        if (res.status === 401) {
          clearStoredAuth();
          setRepos([]);
          setSelectedRepoId("");
          return;
        }
        if (!res.ok) {
          throw new Error(`Failed to load repositories (${res.status})`);
        }
        const data: Repository[] = await res.json();
        if (cancelled) return;
        setRepos(data);
        setSelectedRepoId((prev) => {
          if (prev !== "" && data.some((r) => r.id === prev)) return prev;
          const firstReady = data.find((r) => r.status === "ready");
          return firstReady ? firstReady.id : data[0]?.id ?? "";
        });
      } catch (err) {
        if (!cancelled) {
          setRepoError((err as Error).message);
        }
      }
    }

    loadUserRepos();
    return () => {
      cancelled = true;
    };
  }, [apiUrl, userId]);

  const hasPendingRepos = repos.some((r) => IN_PROGRESS_STATUSES.has(r.status));

  // Poll repository status while ingestion is in progress
  useEffect(() => {
    if (!hasPendingRepos || !apiUrl || !userId) return;

    const id = setInterval(async () => {
      try {
        const res = await fetch(`${apiUrl}/repositories/`, {
          headers: { ...getAuthHeaders() },
        });
        if (res.status === 401) {
          clearStoredAuth();
          setRepos([]);
          setSelectedRepoId("");
          return;
        }
        if (res.ok) {
          const data: Repository[] = await res.json();
          setRepos(data);
        }
      } catch {}
    }, 3000);

    return () => clearInterval(id);
  }, [hasPendingRepos, apiUrl, userId]);

  const signOutUser = () => {
    clearStoredAuth();
    setRepos([]);
    setSelectedRepoId("");
  };

  const handleGitHubLogin = async () => {
    if (loginLoading) return;
    if (!apiUrl) {
      setAuthError("NEXT_PUBLIC_API_URL is not configured.");
      return;
    }
    setLoginLoading(true);
    setAuthError(null);
    try {
      const redirectUri = `${window.location.origin}/auth/callback`;
      const res = await fetch(
        `${apiUrl}/auth/github/login?redirect_uri=${encodeURIComponent(
          redirectUri
        )}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(
          data.message ||
            data.detail ||
            `Failed to initialize GitHub login (${res.status})`
        );
      }
      window.location.href = data.url;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "Failed to fetch") {
        setAuthError(
          `Cannot reach API at ${apiUrl}. Verify the backend is Active and ALLOWED_ORIGINS includes ${window.location.origin}.`
        );
      } else {
        setAuthError(msg);
      }
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    reset();
    setSetupExpanded(true);
    setRunSequence(0);
    signOutUser();
  };

  const handleIngest = async (e: FormEvent) => {
    e.preventDefault();
    if (!githubUrl.trim() || !apiUrl || ingesting) return;
    setIngesting(true);
    setRepoError(null);
    setIngestSuccess(null);
    try {
      const res = await fetch(`${apiUrl}/repositories/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ github_url: githubUrl.trim() }),
      });
      if (res.status === 401) {
        signOutUser();
        return;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(
          errBody.message || errBody.detail || `Failed (${res.status})`
        );
      }
      const created: Repository = await res.json();
      setGithubUrl("");
      setSelectedRepoId(created.id);
      setIngestSuccess(`Connected ${created.name} — indexing in background.`);

      const listRes = await fetch(`${apiUrl}/repositories/`, {
        headers: { ...getAuthHeaders() },
      });
      if (listRes.ok) {
        const updatedList: Repository[] = await listRes.json();
        setRepos(updatedList);
      }
    } catch (err) {
      setRepoError((err as Error).message);
    } finally {
      setIngesting(false);
    }
  };

  const handleCopyText = async (
    text: string,
    setter: (v: boolean) => void
  ) => {
    try {
      await navigator.clipboard.writeText(text);
      setter(true);
      setTimeout(() => setter(false), 2000);
    } catch {}
  };

  const scrollToSection = (sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  // Unauthenticated GitHub OAuth sign-in screen
  if (!user) {
    return (
      <main className="cp-grid-bg relative flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] px-6 py-12 text-[var(--text)]">
        <div
          aria-hidden="true"
          style={{
            background: `radial-gradient(circle, var(--logo-glow) 0%, transparent 70%)`,
          }}
          className="pointer-events-none fixed -left-24 -top-24 h-[420px] w-[420px] rounded-full blur-3xl"
        />

        <div className="relative z-10 w-full max-w-xl space-y-6 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-8">
          <CodePilotLogo />

          <p className="text-sm leading-relaxed text-[var(--text-muted)]">
            Sign in with GitHub to connect your repositories, generate
            AST-verified fixes, run isolated{" "}
            <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-xs text-[var(--text)]">
              pytest
            </code>{" "}
            suites, and open pull requests under your GitHub identity.
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { step: "01", title: "Ingest Repo", desc: "AST & vector index" },
              { step: "02", title: "Plan Fix", desc: "Codebase-grounded" },
              { step: "03", title: "Run Pytest", desc: "Isolated sandbox" },
              { step: "04", title: "Open PR", desc: "Auto-linked issue" },
            ].map((item) => (
              <div
                key={item.step}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3"
              >
                <span className="font-mono text-xs font-semibold text-[var(--brand)]">
                  {item.step}
                </span>
                <p className="mt-1 text-xs font-semibold text-[var(--text)]">
                  {item.title}
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>

          {authError && (
            <div
              role="alert"
              style={{
                backgroundColor: "var(--danger-tint)",
                borderColor: "var(--danger-border)",
                color: "var(--danger)",
              }}
              className="rounded-lg border px-4 py-3 text-xs leading-relaxed"
            >
              {authError}
            </div>
          )}

          <button
            type="button"
            onClick={handleGitHubLogin}
            disabled={loginLoading}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg bg-[var(--brand)] px-4 py-3 text-sm font-semibold text-[#0B0E14] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loginLoading ? (
              <SpinnerIcon className="h-4 w-4" />
            ) : (
              <GitHubIcon className="h-5 w-5" />
            )}
            <span>
              {loginLoading ? "Redirecting to GitHub…" : "Continue with GitHub"}
            </span>
          </button>
        </div>
      </main>
    );
  }

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);
  const canRun =
    !isBusy &&
    !!selectedRepo &&
    selectedRepo.status === "ready" &&
    !!task.trim();

  const triggerRun = (payload: AgentRunPayload) => {
    setLastPayload(payload);
    setSetupExpanded(false);
    setErrorsExpanded(false);
    setRunSequence((prev) => prev + 1);
    setNowTick(Date.now());
    runAgent(payload);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canRun || !selectedRepo) return;
    const parsedIssue = Number(issueNumber);
    triggerRun({
      repo_id: selectedRepo.id,
      task: task.trim(),
      ...(parsedIssue > 0 ? { issue_number: parsedIssue } : {}),
    });
  };

  const handleRetryRun = () => {
    if (isBusy) return;
    if (lastPayload) {
      triggerRun(lastPayload);
    } else if (canRun && selectedRepo) {
      const parsedIssue = Number(issueNumber);
      triggerRun({
        repo_id: selectedRepo.id,
        task: task.trim(),
        ...(parsedIssue > 0 ? { issue_number: parsedIssue } : {}),
      });
    }
  };

  const handleReset = () => {
    reset();
    setSetupExpanded(true);
    setErrorsExpanded(false);
    setRunSequence(0);
  };

  // Derived step index & active label for sticky banner
  const activeStepIndex = PIPELINE.findIndex((s) => s.id === state.activeNode);
  const currentStepNumber =
    activeStepIndex >= 0
      ? activeStepIndex + 1
      : Math.min(
          PIPELINE.length,
          PIPELINE.filter((s) => state.completedNodes.includes(s.id)).length + 1
        );
  const currentStepLabel =
    activeStepIndex >= 0
      ? PIPELINE[activeStepIndex].label
      : state.activeNode === "reflection"
      ? "Coding"
      : PIPELINE[currentStepNumber - 1]?.label ?? "Retriever";

  const totalElapsedMs = state.runStartedAt
    ? Math.max(
        0,
        (state.runFinishedAt ?? Math.max(nowTick, state.runStartedAt)) -
          state.runStartedAt
      )
    : 0;

  // Deduplicated errors & resolution state
  const uniqueErrors = Array.from(new Set(state.errors));
  const hasResolvedErrors =
    uniqueErrors.length > 0 && runStatus !== "failed" && !isBusy;

  // Unified PR and Test data
  const prUrl = state.testResults.pr_url;
  const isClickablePr = Boolean(prUrl && /^https?:\/\//i.test(prUrl));
  const prMeta = parsePrMeta(prUrl, state.prTitle, state.prNumber, task);
  const pytestStats = parsePytestSummary(state.testResults.output);
  const primaryButtonLabel = isBusy
    ? "Running…"
    : runStatus === "completed" || runStatus === "failed"
    ? "Run Again"
    : "Run Agent";

  const collapsedSummary = `${selectedRepo?.name ?? "No repo"} · Issue ${
    issueNumber.trim() ? `#${issueNumber.trim()}` : "—"
  } · "${
    task.trim().length > 36
      ? `${task.trim().slice(0, 36)}…`
      : task.trim() || "No task"
  }"`;

  return (
    <div className="cp-grid-bg relative min-h-screen bg-[var(--bg)] text-[var(--text)]">
      {/* Single soft top-left glow behind logo */}
      <div
        aria-hidden="true"
        style={{
          background: `radial-gradient(circle, var(--logo-glow) 0%, transparent 70%)`,
        }}
        className="pointer-events-none fixed -left-24 -top-24 h-[400px] w-[400px] rounded-full blur-3xl"
      />

      {/* Toast Notification on Completion / Failure */}
      {showToast && (
        <div
          role="status"
          style={{
            backgroundColor: "var(--surface-1)",
            borderColor:
              runStatus === "completed"
                ? "var(--success-border)"
                : "var(--danger-border)",
          }}
          className="fixed bottom-5 right-5 z-50 flex max-w-sm items-center gap-3 rounded-xl border px-4 py-3 shadow-xl"
        >
          <span
            style={{
              color:
                runStatus === "completed" ? "var(--success)" : "var(--danger)",
            }}
            className="text-sm font-bold"
          >
            {runStatus === "completed" ? "✓" : "✗"}
          </span>
          <p className="text-xs font-medium text-[var(--text)]">
            {runStatus === "completed"
              ? "Pull request created and linked to your repository."
              : "Agent run failed. Review the diagnostics below to retry."}
          </p>
          <button
            type="button"
            onClick={() => setDismissedToastSeq(runSequence)}
            aria-label="Dismiss notification"
            className="ml-auto text-xs text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            ✕
          </button>
        </div>
      )}

      {/* Top Application Header */}
      <header className="relative z-20 border-b border-[var(--border)] bg-[var(--bg)]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <CodePilotLogo compact />

          <div className="flex flex-wrap items-center gap-3">
            <RunStatusPill runStatus={runStatus} />

            <button
              type="button"
              onClick={() =>
                setTheme((prev) => (prev === "dark" ? "light" : "dark"))
              }
              aria-label={`Switch to ${
                theme === "dark" ? "light" : "dark"
              } theme`}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
            >
              {theme === "dark" ? "☀ Light" : "☾ Dark"}
            </button>

            <div className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-1)] py-1 pl-1.5 pr-3">
              {user.avatar_url ? (
                <Image
                  src={user.avatar_url}
                  alt={user.username}
                  width={24}
                  height={24}
                  unoptimized
                  className="h-6 w-6 rounded-full border border-[var(--border)]"
                />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface-2)] font-mono text-xs text-[var(--text)]">
                  {user.username[0]?.toUpperCase()}
                </span>
              )}
              <span className="font-mono text-xs font-medium text-[var(--text)]">
                @{user.username}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                disabled={isBusy}
                className="ml-1 border-l border-[var(--border)] pl-2.5 text-xs text-[var(--text-muted)] transition hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Sticky Status / PR Banner directly under Header */}
      <div
        aria-live="polite"
        className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface-1)]/95 backdrop-blur-md"
      >
        {runStatus === "idle" && (
          <div className="mx-auto flex max-w-[1280px] items-center justify-between px-4 py-2 text-xs text-[var(--text-muted)] sm:px-6">
            <span>
              Ready to run — select a repository and describe an engineering task.
            </span>
            <span className="hidden font-mono text-[11px] sm:inline">
              5-stage autonomous pipeline
            </span>
          </div>
        )}

        {runStatus === "running" && (
          <div
            style={{ backgroundColor: "var(--running-tint)" }}
            className="relative overflow-hidden"
          >
            <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
              <div className="flex items-center gap-2.5 text-xs font-medium text-[var(--running)]">
                <SpinnerIcon className="h-4 w-4 shrink-0" />
                <span>
                  Agent running · Step {currentStepNumber} of 5 ·{" "}
                  <strong className="font-semibold">{currentStepLabel}</strong>
                </span>
              </div>

              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-[var(--text-muted)]">
                  {formatDuration(totalElapsedMs)}
                </span>
                <button
                  type="button"
                  onClick={stopAgent}
                  style={{
                    borderColor: "var(--danger-border)",
                    color: "var(--danger)",
                  }}
                  className="rounded-lg border bg-[var(--surface-1)] px-2.5 py-1 text-xs font-semibold transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                >
                  Stop
                </button>
              </div>
            </div>
            <div className="h-0.5 w-full overflow-hidden bg-[var(--border)]">
              <div
                style={{ backgroundColor: "var(--running)" }}
                className="cp-progress-bar h-full w-1/3"
              />
            </div>
          </div>
        )}

        {runStatus === "retrying" && (
          <div
            style={{ backgroundColor: "var(--warning-tint)" }}
            className="relative overflow-hidden"
          >
            <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
              <div className="flex items-center gap-2.5 text-xs font-medium text-[var(--warning)]">
                <SpinnerIcon className="h-4 w-4 shrink-0" />
                <span>
                  Retrying {currentStepLabel} (attempt {state.retryCount + 1})…
                </span>
              </div>

              <div className="flex items-center gap-3">
                <span className="font-mono text-xs text-[var(--text-muted)]">
                  {formatDuration(totalElapsedMs)}
                </span>
                <button
                  type="button"
                  onClick={stopAgent}
                  style={{
                    borderColor: "var(--danger-border)",
                    color: "var(--danger)",
                  }}
                  className="rounded-lg border bg-[var(--surface-1)] px-2.5 py-1 text-xs font-semibold transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                >
                  Stop
                </button>
              </div>
            </div>
            <div className="h-0.5 w-full overflow-hidden bg-[var(--border)]">
              <div
                style={{ backgroundColor: "var(--warning)" }}
                className="cp-progress-bar h-full w-1/3"
              />
            </div>
          </div>
        )}

        {runStatus === "completed" && (
          <div style={{ backgroundColor: "var(--success-tint)" }}>
            <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-[var(--success)]">
                  ✓ Pull request created
                </span>
                <span className="text-[var(--text-muted)]">·</span>
                <span className="truncate font-medium text-[var(--text)]">
                  {prMeta.number ? `${prMeta.number} ` : ""}
                  {prMeta.title}
                </span>
                {prUrl && (
                  <span className="hidden truncate font-mono text-[11px] text-[var(--text-muted)] md:inline">
                    ({prUrl})
                  </span>
                )}
              </div>

              {prUrl && (
                <div className="flex shrink-0 items-center gap-2">
                  {isClickablePr && (
                    <a
                      href={prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg bg-[var(--brand)] px-3 py-1.5 text-xs font-semibold text-[#0B0E14] transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                    >
                      <span>Open PR</span>
                      <span aria-hidden="true">↗</span>
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => handleCopyText(prUrl, setCopiedPrLink)}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] transition hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                  >
                    {copiedPrLink ? "Copied!" : "Copy link"}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {runStatus === "failed" && (
          <div style={{ backgroundColor: "var(--danger-tint)" }}>
            <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span className="shrink-0 font-semibold text-[var(--danger)]">
                  ✗ Run failed
                </span>
                <span className="truncate font-mono text-[11px] text-[var(--text)]">
                  {uniqueErrors[uniqueErrors.length - 1]?.split("\n")[0] ||
                    "Agent execution did not complete."}
                </span>
              </div>

              <button
                type="button"
                onClick={handleRetryRun}
                style={{
                  borderColor: "var(--danger-border)",
                  color: "var(--danger)",
                }}
                className="shrink-0 rounded-lg border bg-[var(--surface-1)] px-3 py-1 text-xs font-semibold transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Main Two-Column Desktop Workspace */}
      <main className="relative z-10 mx-auto max-w-[1280px] px-4 py-6 sm:px-6">
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
          {/* LEFT COLUMN: Sticky Setup & Controls */}
          <aside className="space-y-4 lg:sticky lg:top-[64px]">
            {!setupExpanded ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      Active Configuration
                    </span>
                    <p className="mt-1 truncate font-mono text-xs text-[var(--text)]">
                      {collapsedSummary}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSetupExpanded(true)}
                    disabled={isBusy}
                    aria-label="Edit task configuration"
                    className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-medium text-[var(--text)] transition hover:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Edit
                  </button>
                </div>

                <div className="mt-3 flex items-center gap-2 border-t border-[var(--border)] pt-3">
                  <button
                    type="button"
                    onClick={handleRetryRun}
                    disabled={
                      isBusy ||
                      !selectedRepo ||
                      selectedRepo.status !== "ready" ||
                      !task.trim()
                    }
                    style={
                      isBusy
                        ? {
                            backgroundColor: "var(--running)",
                            color: "#0B0E14",
                          }
                        : {
                            backgroundColor: "var(--brand)",
                            color: "#0B0E14",
                          }
                    }
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isBusy && <SpinnerIcon className="h-3.5 w-3.5" />}
                    <span>{primaryButtonLabel}</span>
                  </button>

                  {isBusy && (
                    <button
                      type="button"
                      onClick={stopAgent}
                      style={{
                        borderColor: "var(--danger-border)",
                        color: "var(--danger)",
                      }}
                      className="rounded-lg border px-3 py-2 text-xs font-semibold transition hover:bg-[var(--danger-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                    >
                      Stop
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={isBusy}
                    className="rounded-lg px-3 py-2 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50"
                  >
                    Reset
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* 01 · Connect GitHub Repository */}
                <form
                  onSubmit={handleIngest}
                  className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4"
                >
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="repo-url-input"
                      className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]"
                    >
                      01 · Connect Repository
                    </label>
                    <span className="text-xs text-[var(--text-muted)]">
                      Public or private
                    </span>
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
                    <input
                      id="repo-url-input"
                      type="url"
                      value={githubUrl}
                      onChange={(e) => setGithubUrl(e.target.value)}
                      placeholder="https://github.com/owner/repository"
                      disabled={ingesting || isBusy}
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-xs text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--brand)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-tint)] disabled:opacity-60"
                    />
                    <button
                      type="submit"
                      disabled={ingesting || isBusy || !githubUrl.trim()}
                      style={{
                        borderColor: "var(--brand-border)",
                        color: "var(--brand)",
                      }}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg border bg-[var(--brand-tint)] px-4 py-2 text-xs font-semibold transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {ingesting && <SpinnerIcon className="h-3.5 w-3.5" />}
                      <span>{ingesting ? "Ingesting…" : "Ingest Repo"}</span>
                    </button>
                  </div>

                  {ingestSuccess && (
                    <p className="text-xs font-medium text-[var(--success)]">
                      ✓ {ingestSuccess}
                    </p>
                  )}
                  {repoError && (
                    <p role="alert" className="text-xs text-[var(--danger)]">
                      {repoError}
                    </p>
                  )}
                </form>

                {/* 02 · Launch Autonomous Task */}
                <form
                  onSubmit={handleSubmit}
                  className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      02 · Launch Task
                    </span>
                    {selectedRepo && (
                      <span
                        style={
                          selectedRepo.status === "ready"
                            ? {
                                backgroundColor: "var(--success-tint)",
                                borderColor: "var(--success-border)",
                                color: "var(--success)",
                              }
                            : selectedRepo.status === "error"
                            ? {
                                backgroundColor: "var(--danger-tint)",
                                borderColor: "var(--danger-border)",
                                color: "var(--danger)",
                              }
                            : {
                                backgroundColor: "var(--warning-tint)",
                                borderColor: "var(--warning-border)",
                                color: "var(--warning)",
                              }
                        }
                        className="rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase"
                      >
                        {selectedRepo.status}
                      </span>
                    )}
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label
                        htmlFor="target-repo-select"
                        className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]"
                      >
                        Target Repository
                      </label>
                      <select
                        id="target-repo-select"
                        value={selectedRepoId}
                        onChange={(e) =>
                          setSelectedRepoId(Number(e.target.value))
                        }
                        disabled={isBusy || repos.length === 0}
                        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium text-[var(--text)] focus:border-[var(--brand)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-tint)] disabled:opacity-60"
                      >
                        {repos.length === 0 ? (
                          <option value="">No repositories ingested yet</option>
                        ) : (
                          repos.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name} ({r.status})
                            </option>
                          ))
                        )}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="issue-number-input"
                        className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]"
                      >
                        Issue #{" "}
                        <span className="text-[var(--text-faint)]">
                          (optional)
                        </span>
                      </label>
                      <input
                        id="issue-number-input"
                        type="number"
                        min={1}
                        value={issueNumber}
                        onChange={(e) => setIssueNumber(e.target.value)}
                        disabled={isBusy}
                        placeholder="e.g. 5"
                        className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 font-mono text-xs text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--brand)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-tint)] disabled:opacity-60"
                      />
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <label
                          htmlFor="task-textarea"
                          className="text-xs font-medium text-[var(--text-muted)]"
                        >
                          Engineering Task
                        </label>
                        <span className="font-mono text-[11px] text-[var(--text-muted)]">
                          {task.length} chars
                        </span>
                      </div>
                      <textarea
                        ref={textareaRef}
                        id="task-textarea"
                        rows={3}
                        value={task}
                        onChange={(e) => setTask(e.target.value)}
                        disabled={isBusy}
                        placeholder="Describe the bug or paste the GitHub issue details..."
                        className="cp-scrollbar max-h-[208px] w-full resize-y overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs leading-relaxed text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--brand)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-tint)] disabled:opacity-60"
                      />
                    </div>
                  </div>

                  {/* Run / Stop / Reset Buttons */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={!canRun && !isBusy}
                      style={
                        isBusy
                          ? {
                              backgroundColor: "var(--running)",
                              color: "#0B0E14",
                            }
                          : {
                              backgroundColor: "var(--brand)",
                              color: "#0B0E14",
                            }
                      }
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isBusy && <SpinnerIcon className="h-3.5 w-3.5" />}
                      <span>{primaryButtonLabel}</span>
                    </button>

                    {isBusy && (
                      <button
                        type="button"
                        onClick={stopAgent}
                        style={{
                          borderColor: "var(--danger-border)",
                          color: "var(--danger)",
                        }}
                        className="rounded-lg border px-3.5 py-2.5 text-xs font-semibold transition hover:bg-[var(--danger-tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                      >
                        Stop
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={handleReset}
                      disabled={isBusy}
                      className="rounded-lg px-3 py-2.5 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] disabled:opacity-50"
                    >
                      Reset
                    </button>
                  </div>
                </form>
              </>
            )}
          </aside>

          {/* RIGHT COLUMN: Hero Stepper, PR Card & Output Panels */}
          <div className="min-w-0 space-y-4">
            {/* Hero 5-Step Connected Pipeline Stepper */}
            <section
              aria-label="Agent execution pipeline"
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Pipeline Execution
                </h2>
                {state.runStartedAt && (
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    Total {formatDuration(totalElapsedMs)}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-5 sm:gap-0">
                {PIPELINE.map((step, index) => {
                  const isDone = state.completedNodes.includes(step.id);
                  const isFailed =
                    runStatus === "failed" && state.failedNode === step.id;
                  const isActive =
                    isBusy &&
                    !isDone &&
                    (state.activeNode === step.id ||
                      (state.activeNode === "reflection" &&
                        step.id === "coding"));

                  const stepRetryCount =
                    state.stepRetries[step.id] ??
                    (step.id === "coding" && state.retryCount > 0
                      ? state.retryCount
                      : 0);

                  const elapsedForStep =
                    state.stepDurationsMs[step.id] !== undefined
                      ? state.stepDurationsMs[step.id]
                      : isActive && state.stepStartTimes[step.id]
                      ? Math.max(
                          0,
                          nowTick - (state.stepStartTimes[step.id] ?? nowTick)
                        )
                      : undefined;

                  const cardStyle = isFailed
                    ? {
                        backgroundColor: "var(--danger-tint)",
                        borderColor: "var(--danger-border)",
                      }
                    : isActive
                    ? {
                        backgroundColor: "var(--running-tint)",
                        borderColor: "var(--running)",
                      }
                    : isDone
                    ? {
                        backgroundColor: "var(--success-tint)",
                        borderColor: "var(--success-border)",
                      }
                    : {
                        backgroundColor: "var(--surface-2)",
                        borderColor: "var(--border)",
                      };

                  return (
                    <div
                      key={step.id}
                      className="flex items-center sm:min-w-0"
                    >
                      <button
                        type="button"
                        onClick={() => scrollToSection(step.sectionId)}
                        style={cardStyle}
                        className={`group flex w-full flex-col justify-between rounded-xl border p-3 text-left transition hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${
                          isActive ? "animate-pulse" : ""
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[11px] font-semibold text-[var(--text-muted)]">
                            0{index + 1}
                          </span>
                          {isFailed ? (
                            <span className="text-xs font-bold text-[var(--danger)]">
                              ✗
                            </span>
                          ) : isActive ? (
                            <SpinnerIcon className="h-3.5 w-3.5 text-[var(--running)]" />
                          ) : isDone ? (
                            <span className="text-xs font-bold text-[var(--success)]">
                              ✓
                            </span>
                          ) : (
                            <span className="h-2 w-2 rounded-full bg-[var(--idle)]" />
                          )}
                        </div>

                        <span className="mt-2 text-xs font-semibold text-[var(--text)]">
                          {step.label}
                        </span>

                        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-1">
                          <span className="font-mono text-[11px] text-[var(--text-muted)]">
                            {elapsedForStep !== undefined
                              ? formatDuration(elapsedForStep)
                              : isDone
                              ? "Done"
                              : "Pending"}
                          </span>

                          {stepRetryCount > 0 && (
                            <span
                              style={{
                                backgroundColor: "var(--warning-tint)",
                                borderColor: "var(--warning-border)",
                                color: "var(--warning)",
                              }}
                              className="rounded border px-1.5 py-0.5 text-[10px] font-semibold"
                            >
                              ↻ {stepRetryCount}{" "}
                              {stepRetryCount === 1 ? "retry" : "retries"}
                            </span>
                          )}
                        </div>
                      </button>

                      {/* Connector line between steps on desktop */}
                      {index < PIPELINE.length - 1 && (
                        <div
                          aria-hidden="true"
                          style={{
                            backgroundColor: isDone
                              ? "var(--success)"
                              : "var(--border)",
                          }}
                          className="hidden h-0.5 w-3 shrink-0 sm:block"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Prominent Pull Request Result Card directly under Stepper when Completed */}
            {runStatus === "completed" && prUrl && (
              <section
                id="section-pr"
                style={{
                  backgroundColor: "var(--success-tint)",
                  borderColor: "var(--success-border)",
                }}
                className="rounded-xl border p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-[var(--success)] px-2.5 py-0.5 text-[11px] font-bold text-[#0B0E14]">
                        ✓ PR Created
                      </span>
                      {prMeta.number && (
                        <span className="font-mono text-xs font-semibold text-[var(--success)]">
                          {prMeta.number}
                        </span>
                      )}
                      {state.branchName && (
                        <code className="rounded bg-[var(--surface-1)] px-2 py-0.5 font-mono text-[11px] text-[var(--text)]">
                          {state.branchName}
                        </code>
                      )}
                    </div>

                    <h2 className="text-base font-bold text-[var(--text)]">
                      {prMeta.title}
                    </h2>

                    <p className="text-xs leading-relaxed text-[var(--text-muted)]">
                      {state.explanation
                        ? state.explanation
                        : `Updated ${state.modifiedFiles.length} file(s) and verified changes with pytest.`}
                    </p>

                    <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-[var(--text-muted)]">
                      <span>
                        <strong className="font-semibold text-[var(--text)]">
                          {state.modifiedFiles.length}
                        </strong>{" "}
                        {state.modifiedFiles.length === 1
                          ? "file changed"
                          : "files changed"}
                      </span>
                      <span>·</span>
                      <span className="font-medium text-[var(--success)]">
                        {pytestStats.passed > 0
                          ? `✓ ${pytestStats.passed} tests passed`
                          : "✓ Tests passed"}
                      </span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {isClickablePr && (
                      <a
                        href={prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          backgroundColor: "var(--success)",
                          color: "#0B0E14",
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-bold transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                      >
                        <span>Open PR</span>
                        <span aria-hidden="true">↗</span>
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => handleCopyText(prUrl, setCopiedPrLink)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-xs font-semibold text-[var(--text)] transition hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                    >
                      {copiedPrLink ? "Copied!" : "Copy link"}
                    </button>
                  </div>
                </div>
              </section>
            )}

            {/* Errors & Reflection Panel */}
            {uniqueErrors.length > 0 && (
              <section
                style={
                  hasResolvedErrors
                    ? {
                        backgroundColor: "var(--warning-tint)",
                        borderColor: "var(--warning-border)",
                      }
                    : runStatus === "failed"
                    ? {
                        backgroundColor: "var(--danger-tint)",
                        borderColor: "var(--danger-border)",
                      }
                    : {
                        backgroundColor: "var(--warning-tint)",
                        borderColor: "var(--warning-border)",
                      }
                }
                className="rounded-xl border p-4"
              >
                {hasResolvedErrors && !errorsExpanded ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 text-xs">
                      <span
                        style={{
                          backgroundColor: "var(--warning)",
                          color: "#0B0E14",
                        }}
                        className="rounded-full px-2.5 py-0.5 font-semibold"
                      >
                        {Math.max(1, state.retryCount)}{" "}
                        {Math.max(1, state.retryCount) === 1
                          ? "retry resolved"
                          : "retries resolved"}
                      </span>
                      <span className="text-[var(--text-muted)]">
                        Intermediate errors were diagnosed and fixed automatically.
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setErrorsExpanded(true)}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1 text-xs font-medium text-[var(--text)] transition hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                    >
                      Show details
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <h2
                          style={{
                            color:
                              runStatus === "failed"
                                ? "var(--danger)"
                                : "var(--warning)",
                          }}
                          className="text-xs font-semibold uppercase tracking-wider"
                        >
                          Errors &amp; Reflection
                        </h2>
                        {hasResolvedErrors && (
                          <span
                            style={{
                              backgroundColor: "var(--success-tint)",
                              borderColor: "var(--success-border)",
                              color: "var(--success)",
                            }}
                            className="rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                          >
                            ✓ Resolved
                          </span>
                        )}
                      </div>

                      {hasResolvedErrors && (
                        <button
                          type="button"
                          onClick={() => setErrorsExpanded(false)}
                          className="text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                        >
                          Collapse
                        </button>
                      )}
                    </div>

                    <div className="space-y-2">
                      {uniqueErrors.map((rawErr, i) => {
                        const match = rawErr.match(
                          /^(Coding Error|Testing Error|PR Creation Error|Reflection Error|Retry \d+ (?:Guidance|Diagnosis|Feedback)):\s*([\s\S]*)$/
                        );
                        const label = match ? match[1] : "Agent Log";
                        const body = (match ? match[2] : rawErr).trim();
                        const isRetryChip =
                          label.startsWith("Retry ") || hasResolvedErrors;

                        return (
                          <div
                            key={i}
                            className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs"
                          >
                            <div className="mb-1.5 flex items-center justify-between gap-2">
                              <span
                                style={
                                  isRetryChip
                                    ? {
                                        backgroundColor: "var(--warning-tint)",
                                        color: "var(--warning)",
                                      }
                                    : {
                                        backgroundColor: "var(--danger-tint)",
                                        color: "var(--danger)",
                                      }
                                }
                                className="rounded px-2 py-0.5 text-[11px] font-semibold"
                              >
                                {label}
                              </span>
                              {hasResolvedErrors && (
                                <span className="text-[11px] font-medium text-[var(--success)]">
                                  ✓ Resolved
                                </span>
                              )}
                            </div>
                            <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-[var(--text)]">
                              {body}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Execution Plan (Collapsible Rows with Inline Code Formatting & Step Markers) */}
            <section
              id="section-plan"
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4"
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Execution Plan
                </h2>
                {state.plan.length > 0 && (
                  <span className="text-xs text-[var(--text-muted)]">
                    {state.plan.length} steps
                  </span>
                )}
              </div>

              {state.plan.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  Select a ready repository and run a task to generate a
                  grounded plan.
                </p>
              ) : (
                <ol className="space-y-2">
                  {state.plan.map((rawStep, idx) => {
                    const { title, detail } = splitPlanStep(rawStep);
                    const isOpen = Boolean(expandedPlanSteps[idx]);
                    const codingDone = state.completedNodes.includes("coding");
                    const codingActive =
                      isBusy &&
                      (state.activeNode === "coding" ||
                        state.activeNode === "reflection");

                    const stepMarker = codingDone
                      ? "done"
                      : codingActive && idx === 0
                      ? "active"
                      : "pending";

                    return (
                      <li
                        key={idx}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)]"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedPlanSteps((prev) => ({
                              ...prev,
                              [idx]: !prev[idx],
                            }))
                          }
                          aria-expanded={isOpen}
                          className="flex w-full items-start justify-between gap-3 px-3.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                        >
                          <div className="flex items-start gap-2.5">
                            <span
                              style={
                                stepMarker === "done"
                                  ? {
                                      backgroundColor: "var(--success-tint)",
                                      color: "var(--success)",
                                    }
                                  : stepMarker === "active"
                                  ? {
                                      backgroundColor: "var(--running-tint)",
                                      color: "var(--running)",
                                    }
                                  : {
                                      backgroundColor: "var(--surface-1)",
                                      color: "var(--text-muted)",
                                    }
                              }
                              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[11px] font-semibold"
                            >
                              {stepMarker === "done" ? "✓" : idx + 1}
                            </span>
                            <span className="text-xs font-semibold leading-relaxed text-[var(--text)]">
                              {formatCodeIdentifiers(title)}
                            </span>
                          </div>

                          {detail && (
                            <span className="shrink-0 text-xs text-[var(--text-muted)]">
                              {isOpen ? "▾" : "▸"}
                            </span>
                          )}
                        </button>

                        {isOpen && detail && (
                          <div className="border-t border-[var(--border)] px-3.5 py-2.5 pl-11 text-xs leading-relaxed text-[var(--text-muted)]">
                            {formatCodeIdentifiers(detail)}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {/* Modified Files + Retrieved Context */}
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
              {/* Modified Files */}
              <section
                id="section-files"
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Modified Files
                  </h2>
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    {state.modifiedFiles.length}
                  </span>
                </div>

                {state.modifiedFiles.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    No files modified yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {state.modifiedFiles.map((file) => {
                      const isAdded = file.status === "added";
                      return (
                        <li
                          key={file.path}
                          className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              style={
                                isAdded
                                  ? {
                                      backgroundColor: "var(--success-tint)",
                                      color: "var(--success)",
                                    }
                                  : {
                                      backgroundColor: "var(--running-tint)",
                                      color: "var(--running)",
                                    }
                              }
                              title={isAdded ? "Added file" : "Modified file"}
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[11px] font-bold"
                            >
                              {isAdded ? "+" : "M"}
                            </span>
                            <span className="truncate font-mono text-xs text-[var(--text)]">
                              {file.path}
                            </span>
                          </div>

                          <div className="flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
                            {file.additions !== undefined ||
                            file.deletions !== undefined ? (
                              <>
                                <span className="text-[var(--success)]">
                                  +{file.additions ?? 0}
                                </span>
                                <span className="text-[var(--danger)]">
                                  −{file.deletions ?? 0}
                                </span>
                              </>
                            ) : (
                              <span
                                className={
                                  isAdded
                                    ? "text-[var(--success)]"
                                    : "text-[var(--text-muted)]"
                                }
                              >
                                {isAdded ? "added" : "modified"}
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* Retrieved Context */}
              <section
                id="section-retrieved"
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Retrieved Context
                  </h2>
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    {state.retrievedContext.length} chunks
                  </span>
                </div>

                {state.retrievedContext.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    No context retrieved yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {state.retrievedContext.map((chunk, i) => {
                      const pct = Math.max(
                        0,
                        Math.min(100, Math.round(chunk.score * 100))
                      );
                      return (
                        <li
                          key={`${chunk.file_path}-${i}`}
                          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-mono text-xs text-[var(--text)]">
                              {chunk.file_path}
                            </span>
                            <span className="shrink-0 text-[11px] font-medium text-[var(--text-muted)]">
                              Relevance{" "}
                              <strong className="font-mono text-[var(--text)]">
                                {chunk.score.toFixed(2)}
                              </strong>
                            </span>
                          </div>
                          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-1)]">
                            <div
                              style={{
                                width: `${pct}%`,
                                backgroundColor: "var(--brand)",
                              }}
                              className="h-full rounded-full"
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>

            {/* Test Output (Stat Chips + Syntax-Colored Terminal Box) */}
            {(state.testResults.output ||
              state.testResults.passed !== undefined) && (
              <section
                id="section-tests"
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4"
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Test Output
                  </h2>

                  <div className="flex items-center gap-2">
                    {state.testResults.output && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopyText(
                              state.testResults.output ?? "",
                              setCopiedTestLog
                            )
                          }
                          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--text)] transition hover:border-[var(--brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                        >
                          {copiedTestLog ? "Copied!" : "Copy"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setTestLogExpanded((prev) => !prev)}
                          className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--text-muted)] transition hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                        >
                          {testLogExpanded ? "Collapse" : "Expand"}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Stat Chips Row */}
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  <span
                    style={{
                      backgroundColor: "var(--success-tint)",
                      borderColor: "var(--success-border)",
                      color: "var(--success)",
                    }}
                    className="rounded-full border px-2.5 py-0.5 font-semibold"
                  >
                    {pytestStats.passed} passed
                  </span>

                  <span
                    style={
                      pytestStats.failed > 0
                        ? {
                            backgroundColor: "var(--danger-tint)",
                            borderColor: "var(--danger-border)",
                            color: "var(--danger)",
                          }
                        : {
                            backgroundColor: "var(--surface-2)",
                            borderColor: "var(--border)",
                            color: "var(--text-muted)",
                          }
                    }
                    className="rounded-full border px-2.5 py-0.5 font-semibold"
                  >
                    {pytestStats.failed} failed
                  </span>

                  {pytestStats.duration && (
                    <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 font-mono text-[var(--text-muted)]">
                      {pytestStats.duration}
                    </span>
                  )}

                  {pytestStats.collected !== null && (
                    <span className="rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-0.5 text-[var(--text-muted)]">
                      {pytestStats.collected} collected
                    </span>
                  )}
                </div>

                {/* Terminal Output Box */}
                {testLogExpanded && state.testResults.output && (
                  <pre className="cp-scrollbar max-h-80 overflow-y-auto overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-xs leading-relaxed">
                    {state.testResults.output
                      .trimEnd()
                      .split("\n")
                      .map((line, idx) => {
                        const isPassLine =
                          /\bPASSED\b|\b\d+\s+passed\b/i.test(line);
                        const isFailLine =
                          /\bFAILED\b|\bERROR\b|\bAssertionError\b|\b\d+\s+failed\b/i.test(
                            line
                          );
                        const lineColor = isFailLine
                          ? "text-[var(--danger)]"
                          : isPassLine
                          ? "text-[var(--success)]"
                          : "text-[var(--text-muted)]";

                        return (
                          <div key={idx} className={lineColor}>
                            {line || " "}
                          </div>
                        );
                      })}
                  </pre>
                )}
              </section>
            )}

            {/* Collapsible Activity Log / Timeline Drawer */}
            {state.activityLog.length > 0 && (
              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
                <button
                  type="button"
                  onClick={() => setTimelineExpanded((prev) => !prev)}
                  aria-expanded={timelineExpanded}
                  className="flex w-full items-center justify-between text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                >
                  <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    Activity Timeline ({state.activityLog.length})
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {timelineExpanded ? "Hide ▾" : "Show ▸"}
                  </span>
                </button>

                {timelineExpanded && (
                  <ol className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
                    {state.activityLog.map((entry) => {
                      const dotColor =
                        entry.tone === "success"
                          ? "var(--success)"
                          : entry.tone === "warning"
                          ? "var(--warning)"
                          : entry.tone === "danger"
                          ? "var(--danger)"
                          : "var(--running)";
                      return (
                        <li
                          key={entry.id}
                          className="flex items-start justify-between gap-3 text-xs"
                        >
                          <div className="flex items-start gap-2.5">
                            <span
                              style={{ backgroundColor: dotColor }}
                              className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                            />
                            <div>
                              <span className="font-semibold text-[var(--text)]">
                                {entry.label}:{" "}
                              </span>
                              <span className="text-[var(--text-muted)]">
                                {entry.detail}
                              </span>
                            </div>
                          </div>
                          <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
                            {state.runStartedAt
                              ? `+${formatDuration(
                                  entry.timestamp - state.runStartedAt
                                )}`
                              : ""}
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}