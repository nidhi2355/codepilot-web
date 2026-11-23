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

const PIPELINE: { id: AgentNode; label: string }[] = [
  { id: "retriever", label: "Retriever" },
  { id: "planner", label: "Planner" },
  { id: "coding", label: "Coding" },
  { id: "testing", label: "Testing" },
  { id: "pr_creator", label: "PR Creator" },
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

function CodePilotLogo() {
  return (
    <div className="flex items-center gap-3.5">
      <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-emerald-400/30 bg-gradient-to-br from-emerald-500/20 via-cyan-500/15 to-blue-600/20 shadow-[0_0_25px_-5px_rgba(16,185,129,0.4)]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="h-6 w-6 text-emerald-300"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="8 9 4 12 8 15" />
          <polyline points="16 9 20 12 16 15" />
          <line x1="13.5" y1="7" x2="10.5" y2="17" />
        </svg>
        <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
        </span>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="text-zinc-50">Code</span>
            <span className="bg-gradient-to-r from-emerald-300 via-cyan-300 to-blue-400 bg-clip-text text-transparent">
              Pilot
            </span>
          </h1>
          <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-emerald-300">
            Agent
          </span>
        </div>
        <p className="mt-0.5 text-sm text-zinc-400">
          Repository-grounded planning, autonomous code generation,{" "}
          <span className="font-mono text-xs text-zinc-300">pytest</span>{" "}
          verification &amp; PR delivery
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

  // Validate stored JWT session in the background
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
      .catch(() => {
        // Keep cached session on transient network failure
      });

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

  const hasPending = repos.some((r) => IN_PROGRESS_STATUSES.has(r.status));

  // Poll while any repository is cloning, indexing, or embedding
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
      } catch {
        // Retry on next tick
      }
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
      <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6 text-zinc-100">
        <div className="w-full max-w-lg space-y-8 rounded-2xl border border-zinc-800/90 bg-zinc-900/60 p-8 shadow-2xl">
          <CodePilotLogo />

          <div className="space-y-3 border-t border-zinc-800/80 pt-6 text-sm text-zinc-300">
            <p className="leading-relaxed">
              Sign in with your GitHub account to ingest your private or public
              repositories, run isolated autonomous coding agents, and open pull
              requests directly under your GitHub identity.
            </p>
            <ul className="space-y-1.5 text-xs text-zinc-400">
              <li>• Per-user isolated repository workspaces and vector indexes</li>
              <li>• Encrypted OAuth credentials — never exposed in browser storage</li>
              <li>• Automated AST diff auditing, pytest verification &amp; PR linking</li>
            </ul>
          </div>

          {authError && (
            <p className="rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {authError}
            </p>
          )}

          <button
            type="button"
            onClick={handleGitHubLogin}
            disabled={loginLoading}
            className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            <GitHubIcon />
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
    <main className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-8">
        <header className="flex flex-col justify-between gap-4 border-b border-zinc-800/90 pb-6 sm:flex-row sm:items-center">
          <CodePilotLogo />

          <div className="flex flex-wrap items-center gap-3 self-start sm:self-auto">
            {state.activeNode === "reflection" && state.isRunning && (
              <span className="rounded-full border border-amber-500/40 bg-amber-950/50 px-3 py-1 text-xs font-medium text-amber-300">
                Reflecting…
              </span>
            )}
            <span
              className={`rounded-full border px-3 py-1 font-mono text-xs font-medium uppercase tracking-wider ${
                state.isRunning
                  ? "border-blue-500/40 bg-blue-950/40 text-blue-300"
                  : state.status === "completed" || state.status === "pr_created"
                  ? "border-emerald-500/40 bg-emerald-950/40 text-emerald-300"
                  : state.status === "error"
                  ? "border-red-500/40 bg-red-950/40 text-red-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300"
              }`}
            >
              {state.status}
            </span>

            <div className="flex items-center gap-2.5 rounded-full border border-zinc-800 bg-zinc-900/90 py-1 pl-1.5 pr-3">
              {user.avatar_url ? (
                <Image
                  src={user.avatar_url}
                  alt={user.username}
                  width={24}
                  height={24}
                  unoptimized
                  className="h-6 w-6 rounded-full border border-zinc-700"
                />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 font-mono text-xs text-zinc-300">
                  {user.username[0]?.toUpperCase()}
                </span>
              )}
              <span className="font-mono text-xs text-zinc-200">
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
          className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5"
        >
          <label className="block text-xs font-medium uppercase tracking-wider text-zinc-400">
            Connect GitHub Repository
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="url"
              value={githubUrl}
              onChange={(e) => setGithubUrl(e.target.value)}
              placeholder="https://github.com/owner/repository"
              disabled={ingesting}
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500/60 focus:outline-none"
            />
            <button
              type="submit"
              disabled={ingesting || !githubUrl.trim()}
              className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ingesting ? "Ingesting..." : "Ingest Repo"}
            </button>
          </div>
          {repoError && <p className="text-xs text-red-400">{repoError}</p>}
        </form>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="sm:col-span-3">
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Target Repository
              </label>
              <div className="flex items-center gap-3">
                <select
                  value={selectedRepoId}
                  onChange={(e) => setSelectedRepoId(Number(e.target.value))}
                  disabled={state.isRunning || repos.length === 0}
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500/60 focus:outline-none"
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
                    className={`rounded-full px-2.5 py-1 text-xs font-medium uppercase ${
                      selectedRepo.status === "ready"
                        ? "bg-emerald-950 text-emerald-300"
                        : selectedRepo.status === "error"
                        ? "bg-red-950 text-red-300"
                        : "bg-amber-950 text-amber-300"
                    }`}
                  >
                    {selectedRepo.status}
                  </span>
                )}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Issue # <span className="text-zinc-500">(optional)</span>
              </label>
              <input
                type="number"
                min={1}
                value={issueNumber}
                onChange={(e) => setIssueNumber(e.target.value)}
                disabled={state.isRunning}
                placeholder="e.g. 5"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm focus:border-emerald-500/60 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Engineering Task
            </label>
            <textarea
              rows={3}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              disabled={state.isRunning}
              placeholder="Paste the GitHub issue title and description..."
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-emerald-500/60 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!canRun}
              className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.isRunning ? "Running Agent..." : "Run Agent"}
            </button>
            {state.isRunning && (
              <button
                type="button"
                onClick={stopAgent}
                className="rounded-lg border border-red-800 bg-red-950/60 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-900/60"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={reset}
              disabled={state.isRunning}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Reset
            </button>
            {state.retryCount > 0 && (
              <span className="ml-auto rounded-md border border-amber-500/30 bg-amber-950/40 px-2.5 py-1 font-mono text-xs text-amber-300">
                Retries: {state.retryCount}
              </span>
            )}
          </div>
        </form>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {PIPELINE.map((step, index) => {
            const done = state.completedNodes.includes(step.id);
            const active = state.activeNode === step.id && state.isRunning;
            return (
              <div
                key={step.id}
                className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium transition ${
                  active
                    ? "border-blue-500 bg-blue-950/40 text-blue-300"
                    : done
                    ? "border-emerald-700/70 bg-emerald-950/30 text-emerald-300"
                    : "border-zinc-800 bg-zinc-900/40 text-zinc-500"
                }`}
              >
                <span className="font-mono text-[10px] opacity-70">
                  0{index + 1}
                </span>
                <span>{step.label}</span>
              </div>
            );
          })}
        </section>

        {state.errors.length > 0 && (
          <section className="rounded-xl border border-red-900/70 bg-red-950/30 p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-400">
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
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Execution Plan
            </h2>
            {state.plan.length === 0 ? (
              <p className="text-sm text-zinc-500">No plan generated yet.</p>
            ) : (
              <ol className="space-y-2.5 text-sm text-zinc-200">
                {state.plan.map((step, i) => {
                  const cleanText = step.replace(/^\d+[\.\)]\s*/, "");
                  return (
                    <li
                      key={i}
                      className="flex items-start gap-2.5 rounded-lg border border-zinc-800/80 bg-zinc-950/70 px-3 py-2 leading-relaxed"
                    >
                      <span className="mt-0.5 shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300">
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
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Modified Files
              </h2>
              {state.modifiedFiles.length === 0 ? (
                <p className="text-sm text-zinc-500">No files modified yet.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {state.modifiedFiles.map((file) => (
                    <span
                      key={file}
                      className="rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1 font-mono text-xs text-zinc-200"
                    >
                      {file}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
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
                      className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs"
                    >
                      <span className="truncate font-mono text-zinc-200">
                        {chunk.file_path}
                      </span>
                      <span className="ml-3 shrink-0 font-mono text-zinc-400">
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
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Test Output &amp; Pull Request
              </h2>
              {state.testResults.passed !== undefined && (
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    state.testResults.passed
                      ? "bg-emerald-950 text-emerald-300"
                      : "bg-red-950 text-red-300"
                  }`}
                >
                  {state.testResults.passed ? "Tests Passed" : "Tests Failed"}
                </span>
              )}
            </div>
            {state.testResults.output && (
              <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs text-zinc-300">
                {state.testResults.output}
              </pre>
            )}
            {prUrl && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-800/50 bg-emerald-950/20 px-4 py-3 text-xs">
                <span className="font-medium text-zinc-300">Pull Request:</span>
                {isClickablePr ? (
                  <a
                    href={prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-mono font-medium text-emerald-300 underline decoration-emerald-500/50 underline-offset-4 hover:text-emerald-200"
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