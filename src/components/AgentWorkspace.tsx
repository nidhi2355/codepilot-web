"use client";

import Image from "next/image";
import { FormEvent, useEffect, useState, useSyncExternalStore } from "react";
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
import { AgentNode, Repository } from "@/types/agent";
import { UserProfile } from "@/types/auth";

const PIPELINE: { id: AgentNode; label: string; hint: string }[] = [
  { id: "retriever", label: "Retriever", hint: "Context" },
  { id: "planner", label: "Planner", hint: "Blueprint" },
  { id: "coding", label: "Coding", hint: "Patch" },
  { id: "testing", label: "Testing", hint: "Verify" },
  { id: "pr_creator", label: "PR Creator", hint: "Ship" },
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

function CodePilotLogo({ size = "header" }: { size?: "header" | "hero" }) {
  const isHero = size === "hero";

  return (
    <div className="flex items-start gap-4 sm:items-center sm:gap-5">
      <div
        className={`relative flex shrink-0 items-center justify-center rounded-2xl border border-emerald-400/40 bg-gradient-to-br from-emerald-500/25 via-cyan-500/15 to-blue-600/25 ring-1 ring-white/10 shadow-[0_0_40px_-6px_rgba(16,185,129,0.55)] ${
          isHero ? "h-16 w-16" : "h-14 w-14"
        }`}
      >
        <div className="absolute inset-1 rounded-xl bg-zinc-950/60" />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className={`relative text-emerald-300 drop-shadow-[0_0_8px_rgba(52,211,153,0.6)] ${
            isHero ? "h-9 w-9" : "h-8 w-8"
          }`}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="7.5 8.5 3.5 12 7.5 15.5" />
          <polyline points="16.5 8.5 20.5 12 16.5 15.5" />
          <line x1="14" y1="6.5" x2="10" y2="17.5" />
        </svg>
        <span className="absolute -right-1 -top-1 flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
          <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-zinc-950 bg-emerald-400" />
        </span>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1
            className={`font-extrabold tracking-tight ${
              isHero ? "text-4xl sm:text-5xl" : "text-3xl sm:text-4xl"
            }`}
          >
            <span className="text-white">Code</span>
            <span className="bg-gradient-to-r from-emerald-300 via-cyan-300 to-blue-400 bg-clip-text text-transparent">
              Pilot
            </span>
          </h1>
          <span className="rounded-full border border-emerald-400/35 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-widest text-emerald-300">
            AI Agent
          </span>
        </div>

        <p
          className={`font-semibold tracking-tight text-emerald-300 ${
            isHero ? "text-base sm:text-lg" : "text-sm sm:text-base"
          }`}
        >
          From Issue to Pull Request
        </p>

        <p className="max-w-xl text-xs leading-relaxed text-zinc-300 sm:text-sm">
          Describe any GitHub issue—CodePilot indexes your codebase, writes the
          fix, verifies it with{" "}
          <span className="rounded bg-zinc-800/90 px-1.5 py-0.5 font-mono text-xs text-zinc-100">
            pytest
          </span>
          , and opens a clean PR.
        </p>
      </div>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  );
}

function AmbientBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 overflow-hidden"
    >
      <div className="absolute -top-40 left-1/2 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-gradient-to-r from-emerald-500/15 via-cyan-500/10 to-blue-600/15 blur-3xl" />
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff06_1px,transparent_1px),linear-gradient(to_bottom,#ffffff06_1px,transparent_1px)] bg-[size:36px_36px] [mask-image:radial-gradient(ellipse_75%_55%_at_50%_0%,#000_70%,transparent_100%)]" />
    </div>
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

  const [loginLoading, setLoginLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<number | "">("");
  const [githubUrl, setGithubUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [issueNumber, setIssueNumber] = useState("");
  const [task, setTask] = useState("");

  const { state, runAgent, stopAgent, reset } = useAgentStream();

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;

  const signOutUser = () => {
    clearStoredAuth();
    setRepos([]);
    setSelectedRepoId("");
  };

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

  const hasPending = repos.some((r) => IN_PROGRESS_STATUSES.has(r.status));

  useEffect(() => {
    if (!hasPending || !apiUrl || !userId) return;

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
  }, [hasPending, apiUrl, userId]);

  const handleGitHubLogin = async () => {
    if (!apiUrl || loginLoading) return;
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
          data.message || data.detail || "Failed to initialize GitHub login"
        );
      }
      window.location.href = data.url;
    } catch (err) {
      setAuthError((err as Error).message);
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    reset();
    signOutUser();
  };

  const handleIngest = async (e: FormEvent) => {
    e.preventDefault();
    if (!githubUrl.trim() || !apiUrl || ingesting) return;
    setIngesting(true);
    setRepoError(null);
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

  if (!user) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6 py-12 text-zinc-100">
        <AmbientBackdrop />

        <div className="relative z-10 w-full max-w-2xl space-y-8 rounded-3xl border border-zinc-800/90 bg-zinc-900/75 p-8 ring-1 ring-white/5 backdrop-blur-xl shadow-[0_25px_80px_-20px_rgba(0,0,0,0.85)] sm:p-10">
          <CodePilotLogo size="hero" />

          <div className="grid grid-cols-2 gap-3 border-y border-zinc-800/80 py-6 sm:grid-cols-4">
            {[
              { step: "01", title: "Ingest Repo", desc: "AST & vector index" },
              { step: "02", title: "Plan Fix", desc: "Codebase-grounded" },
              { step: "03", title: "Run Pytest", desc: "Self-healing loop" },
              { step: "04", title: "Open PR", desc: "Auto-linked issue" },
            ].map((item) => (
              <div
                key={item.step}
                className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-3.5"
              >
                <span className="font-mono text-[11px] font-semibold text-emerald-400">
                  {item.step}
                </span>
                <p className="mt-1 text-xs font-semibold text-zinc-100">
                  {item.title}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-400">{item.desc}</p>
              </div>
            ))}
          </div>

          <div className="space-y-4">
            {authError && (
              <p className="rounded-xl border border-red-900/70 bg-red-950/40 px-4 py-2.5 text-xs text-red-300">
                {authError}
              </p>
            )}

            <button
              type="button"
              onClick={handleGitHubLogin}
              disabled={loginLoading}
              className="flex w-full items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 px-5 py-3.5 text-sm font-bold text-zinc-950 shadow-[0_0_30px_-5px_rgba(16,185,129,0.5)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <GitHubIcon />
              <span>
                {loginLoading
                  ? "Redirecting to GitHub…"
                  : "Continue with GitHub"}
              </span>
            </button>

            <p className="text-center text-xs text-zinc-400">
              Your repositories and OAuth tokens are encrypted and isolated to
              your account.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);
  const canRun =
    !state.isRunning &&
    !!selectedRepo &&
    selectedRepo.status === "ready" &&
    !!task.trim();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canRun || !selectedRepo) return;
    const parsedIssue = Number(issueNumber);
    runAgent({
      repo_id: selectedRepo.id,
      task: task.trim(),
      ...(parsedIssue > 0 ? { issue_number: parsedIssue } : {}),
    });
  };

  const prUrl = state.testResults.pr_url;
  const isClickablePr = Boolean(prUrl && /^https?:\/\//i.test(prUrl));

  return (
    <main className="relative min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <AmbientBackdrop />

      <div className="relative z-10 mx-auto max-w-5xl space-y-8">
        <header className="flex flex-col justify-between gap-5 border-b border-zinc-800/80 pb-7 lg:flex-row lg:items-center">
          <CodePilotLogo size="header" />

          <div className="flex flex-wrap items-center gap-3 self-start lg:self-auto">
            {state.activeNode === "reflection" && state.isRunning && (
              <span className="animate-pulse rounded-full border border-amber-500/40 bg-amber-950/60 px-3 py-1 text-xs font-medium text-amber-300">
                Reflecting…
              </span>
            )}
            <span
              className={`rounded-full border px-3 py-1 font-mono text-xs font-semibold uppercase tracking-wider ${
                state.isRunning
                  ? "border-blue-500/40 bg-blue-950/50 text-blue-300"
                  : state.status === "completed" || state.status === "pr_created"
                  ? "border-emerald-500/40 bg-emerald-950/50 text-emerald-300"
                  : state.status === "error"
                  ? "border-red-500/40 bg-red-950/50 text-red-300"
                  : "border-zinc-700/80 bg-zinc-900/90 text-zinc-300"
              }`}
            >
              {state.status}
            </span>

            <div className="flex items-center gap-2.5 rounded-full border border-zinc-800 bg-zinc-900/90 py-1.5 pl-2 pr-3.5 ring-1 ring-white/5">
              {user.avatar_url ? (
                <Image
                  src={user.avatar_url}
                  alt={user.username}
                  width={26}
                  height={26}
                  unoptimized
                  className="h-6 w-6 rounded-full border border-zinc-700"
                />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 font-mono text-xs text-zinc-300">
                  {user.username[0]?.toUpperCase()}
                </span>
              )}
              <span className="font-mono text-xs font-medium text-zinc-200">
                @{user.username}
              </span>
              <button
                type="button"
                onClick={handleLogout}
                disabled={state.isRunning}
                className="ml-1 border-l border-zinc-800 pl-2.5 text-xs text-zinc-400 transition hover:text-zinc-100 disabled:opacity-50"
              >
                Sign out
              </button>
            </div>
          </div>
        </header>

        <form
          onSubmit={handleIngest}
          className="space-y-3 rounded-2xl border border-zinc-800/90 bg-zinc-900/65 p-5 ring-1 ring-white/5 backdrop-blur-md"
        >
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              01 · Connect GitHub Repository
            </label>
            <span className="text-xs text-zinc-500">
              Public or private repos you own
            </span>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="url"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              placeholder="https://github.com/owner/repository"
              disabled={ingesting}
              className="flex-1 rounded-xl border border-zinc-700/90 bg-zinc-950/90 px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
            <button
              type="submit"
              disabled={ingesting || !githubUrl.trim()}
              className="rounded-xl bg-zinc-100 px-5 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ingesting ? "Ingesting..." : "Ingest Repo"}
            </button>
          </div>
          {repoError && <p className="text-xs text-red-400">{repoError}</p>}
        </form>

        <form
          onSubmit={handleSubmit}
          className="space-y-5 rounded-2xl border border-zinc-800/90 bg-zinc-900/65 p-6 ring-1 ring-white/5 backdrop-blur-md"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
              02 · Launch Autonomous Task
            </span>
            <span className="font-mono text-[11px] text-zinc-500">
              Auto-syncs latest main before run
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="sm:col-span-3">
              <label className="mb-1.5 block text-xs font-medium text-zinc-300">
                Target Repository
              </label>
              <div className="flex items-center gap-3">
                <select
                  value={selectedRepoId}
                  onChange={(e) => setSelectedRepoId(Number(e.target.value))}
                  disabled={state.isRunning || repos.length === 0}
                  className="flex-1 rounded-xl border border-zinc-700/90 bg-zinc-950/90 px-3.5 py-2.5 text-sm text-zinc-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                >
                  {repos.length === 0 ? (
                    <option value="">No repositories ingested yet</option>
                  ) : (
                    repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name} — {r.status}
                      </option>
                    ))
                  )}
                </select>
                {selectedRepo && (
                  <span
                    className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase ${
                      selectedRepo.status === "ready"
                        ? "border-emerald-500/30 bg-emerald-950/70 text-emerald-300"
                        : selectedRepo.status === "error"
                        ? "border-red-500/30 bg-red-950/70 text-red-300"
                        : "border-amber-500/30 bg-amber-950/70 text-amber-300"
                    }`}
                  >
                    {selectedRepo.status}
                  </span>
                )}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-zinc-300">
                Issue # <span className="text-zinc-500">(optional)</span>
              </label>
              <input
                type="number"
                min={1}
                value={issueNumber}
                onChange={(e) => setIssueNumber(e.target.value)}
                disabled={state.isRunning}
                placeholder="e.g. 5"
                className="w-full rounded-xl border border-zinc-700/90 bg-zinc-950/90 px-3.5 py-2.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-zinc-300">
              Engineering Task
            </label>
            <textarea
              rows={3}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              disabled={state.isRunning}
              placeholder="Paste the GitHub issue title and description..."
              className="w-full rounded-xl border border-zinc-700/90 bg-zinc-950/90 px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={!canRun}
              className="rounded-xl bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 px-5 py-2.5 text-sm font-bold text-zinc-950 shadow-[0_0_25px_-5px_rgba(16,185,129,0.45)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {state.isRunning ? "Running Agent..." : "Run Agent →"}
            </button>
            {state.isRunning && (
              <button
                type="button"
                onClick={stopAgent}
                className="rounded-xl border border-red-800 bg-red-950/60 px-4 py-2.5 text-sm font-medium text-red-300 hover:bg-red-900/60"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              disabled={state.isRunning}
              className="rounded-xl border border-zinc-700/90 bg-zinc-950/50 px-4 py-2.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
            >
              Reset
            </button>
            {state.retryCount > 0 && (
              <span className="ml-auto rounded-lg border border-amber-500/30 bg-amber-950/50 px-3 py-1.5 font-mono text-xs text-amber-300">
                Self-Heal Retries: {state.retryCount}
              </span>
            )}
          </div>
        </form>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {PIPELINE.map((step, index) => {
            const done = state.completedNodes.includes(step.id);
            const active = state.activeNode === step.id && state.isRunning;
            return (
              <div
                key={step.id}
                className={`relative flex flex-col justify-between rounded-xl border p-3.5 transition ${
                  active
                    ? "border-blue-400/70 bg-blue-950/40 text-blue-200 shadow-[0_0_25px_-8px_rgba(59,130,246,0.6)]"
                    : done
                    ? "border-emerald-500/40 bg-emerald-950/30 text-emerald-200"
                    : "border-zinc-800/90 bg-zinc-900/45 text-zinc-500"
                }`}
              >
                <div className="flex items-center justify-between font-mono text-[10px]">
                  <span>0{index + 1}</span>
                  <span>
                    {active ? "ACTIVE" : done ? "✓ DONE" : step.hint.toUpperCase()}
                  </span>
                </div>
                <span className="mt-2 text-xs font-semibold tracking-tight">
                  {step.label}
                </span>
              </div>
            );
          })}
        </section>

        {state.errors.length > 0 && (
          <section className="rounded-2xl border border-red-900/70 bg-red-950/30 p-5 backdrop-blur-md">
            <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-red-400">
              Errors &amp; Reflection
            </h2>
            <ul className="space-y-1.5 text-xs text-red-200">
              {state.errors.map((err, i) => (
                <li key={i} className="whitespace-pre-wrap font-mono">
                  {err}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-zinc-800/90 bg-zinc-900/55 p-6 ring-1 ring-white/5 backdrop-blur-md">
            <h2 className="mb-3.5 text-xs font-semibold uppercase tracking-wider text-zinc-300">
              Execution Plan
            </h2>
            {state.plan.length === 0 ? (
              <p className="text-sm text-zinc-500">
                Select a ready repository and enter an issue to generate a
                grounded plan.
              </p>
            ) : (
              <ol className="space-y-2.5 text-sm text-zinc-200">
                {state.plan.map((step, i) => {
                  const cleanText = step.replace(/^\d+[\.\)]\s*/, "");
                  return (
                    <li
                      key={i}
                      className="flex items-start gap-3 rounded-xl border border-zinc-800/90 bg-zinc-950/80 px-3.5 py-2.5 leading-relaxed"
                    >
                      <span className="mt-0.5 shrink-0 rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-emerald-300">
                        {i + 1}
                      </span>
                      <span>{cleanText}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          <section className="space-y-6">
            <div className="rounded-2xl border border-zinc-800/90 bg-zinc-900/55 p-6 ring-1 ring-white/5 backdrop-blur-md">
              <h2 className="mb-3.5 text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Modified Files
              </h2>
              {state.modifiedFiles.length === 0 ? (
                <p className="text-sm text-zinc-500">No files modified yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {state.modifiedFiles.map((file) => (
                    <span
                      key={file}
                      className="rounded-lg border border-emerald-500/30 bg-emerald-950/25 px-3 py-1.5 font-mono text-xs text-emerald-200"
                    >
                      {file}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-zinc-800/90 bg-zinc-900/55 p-6 ring-1 ring-white/5 backdrop-blur-md">
              <h2 className="mb-3.5 text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Retrieved Context ({state.retrievedContext.length})
              </h2>
              {state.retrievedContext.length === 0 ? (
                <p className="text-sm text-zinc-500">
                  No context retrieved yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {state.retrievedContext.map((chunk, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between rounded-xl border border-zinc-800/90 bg-zinc-950/80 px-3.5 py-2 text-xs"
                    >
                      <span className="truncate font-mono text-zinc-200">
                        {chunk.file_path}
                      </span>
                      <span className="ml-3 shrink-0 rounded bg-zinc-900 px-2 py-0.5 font-mono text-zinc-400">
                        {chunk.score.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        {(state.testResults.output || prUrl) && (
          <section className="rounded-2xl border border-zinc-800/90 bg-zinc-900/55 p-6 ring-1 ring-white/5 backdrop-blur-md">
            <div className="mb-3.5 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                Test Output &amp; Pull Request
              </h2>
              {state.testResults.passed !== undefined && (
                <span
                  className={`rounded-full border px-3 py-0.5 text-xs font-semibold ${
                    state.testResults.passed
                      ? "border-emerald-500/30 bg-emerald-950/70 text-emerald-300"
                      : "border-red-500/30 bg-red-950/70 text-red-300"
                  }`}
                >
                  {state.testResults.passed ? "Tests Passed" : "Tests Failed"}
                </span>
              )}
            </div>
            {state.testResults.output && (
              <pre className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs text-zinc-300">
                {state.testResults.output}
              </pre>
            )}
            {prUrl && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/40 bg-emerald-950/30 px-4 py-3.5 text-xs shadow-[0_0_25px_-8px_rgba(16,185,129,0.4)]">
                <span className="font-semibold text-emerald-200">
                  Pull Request Created:
                </span>
                {isClickablePr ? (
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-mono font-semibold text-emerald-300 underline decoration-emerald-400/60 underline-offset-4 hover:text-emerald-200"
                  >
                    <span>{prUrl}</span>
                    <span aria-hidden="true">↗</span>
                  </a>
                ) : (
                  <span className="font-mono text-zinc-200">{prUrl}</span>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}