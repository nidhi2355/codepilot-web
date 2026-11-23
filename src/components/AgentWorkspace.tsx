"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useAgentStream } from "@/hooks/useAgentStream";
import { AgentNode, Repository } from "@/types/agent";

const PIPELINE: { id: AgentNode; label: string }[] = [
  { id: "planner", label: "Planner" },
  { id: "retriever", label: "Retriever" },
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

export default function AgentWorkspace() {
  const { state, runAgent, stopAgent, reset } = useAgentStream();
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<number | "">("");
  const [githubUrl, setGithubUrl] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [task, setTask] = useState("");

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;

  const loadRepos = useCallback(async () => {
    if (!apiUrl) return null;
    const res = await fetch(`${apiUrl}/repositories/`);
    if (!res.ok) throw new Error(`Failed to load repositories (${res.status})`);
    return (await res.json()) as Repository[];
  }, [apiUrl]);

  const syncRepos = useCallback((data: Repository[]) => {
    setRepos(data);
    setSelectedRepoId((prev) => {
      if (prev !== "" && data.some((r) => r.id === prev)) return prev;
      const firstReady = data.find((r) => r.status === "ready");
      return firstReady ? firstReady.id : data[0]?.id ?? "";
    });
  }, []);

  const fetchRepos = useCallback(async () => {
    try {
      const data = await loadRepos();
      if (data) syncRepos(data);
    } catch (err) {
      setRepoError((err as Error).message);
    }
  }, [loadRepos, syncRepos]);

  useEffect(() => {
    let cancelled = false;

    const loadInitialRepos = async () => {
      try {
        const data = await loadRepos();
        if (!cancelled && data) syncRepos(data);
      } catch (err) {
        if (!cancelled) setRepoError((err as Error).message);
      }
    };

    void loadInitialRepos();
    return () => {
      cancelled = true;
    };
  }, [loadRepos, syncRepos]);

  // Poll every 3s while any repository is still ingesting
  useEffect(() => {
    const hasPending = repos.some((r) => IN_PROGRESS_STATUSES.has(r.status));
    if (!hasPending) return;
    const id = setInterval(fetchRepos, 3000);
    return () => clearInterval(id);
  }, [repos, fetchRepos]);

  const handleIngest = async (e: FormEvent) => {
    e.preventDefault();
    if (!githubUrl.trim() || !apiUrl || ingesting) return;
    setIngesting(true);
    setRepoError(null);
    try {
      const res = await fetch(`${apiUrl}/repositories/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ github_url: githubUrl.trim() }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || errBody.detail || `Failed (${res.status})`);
      }
      const created: Repository = await res.json();
      setGithubUrl("");
      setSelectedRepoId(created.id);
      await fetchRepos();
    } catch (err) {
      setRepoError((err as Error).message);
    } finally {
      setIngesting(false);
    }
  };

  const selectedRepo = repos.find((r) => r.id === selectedRepoId);
  const canRun =
    !state.isRunning &&
    !!selectedRepo &&
    selectedRepo.status === "ready" &&
    !!task.trim();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canRun || !selectedRepo) return;
    runAgent({
      repo_id: selectedRepo.id,
      task: task.trim(),
    });
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-10">
      <div className="mx-auto max-w-5xl space-y-8">
        <header className="flex items-center justify-between border-b border-zinc-800 pb-5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">CodePilot</h1>
            <p className="text-sm text-zinc-400">
              Autonomous repository understanding and coding agent
            </p>
          </div>
          <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-medium uppercase tracking-wider text-zinc-300">
            {state.status}
          </span>
        </header>

        <form
          onSubmit={handleIngest}
          className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-3"
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
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
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
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Target Repository
            </label>
            <div className="flex items-center gap-3">
              <select
                value={selectedRepoId}
                onChange={(e) => setSelectedRepoId(Number(e.target.value))}
                disabled={state.isRunning || repos.length === 0}
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
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
              Engineering Task
            </label>
            <textarea
              rows={3}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              disabled={state.isRunning}
              placeholder="Describe the feature or bug fix for the selected repository..."
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!canRun}
              className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.isRunning ? "Running..." : "Run Agent"}
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
              <span className="ml-auto text-xs text-amber-400">
                Retries: {state.retryCount}
              </span>
            )}
          </div>
        </form>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {PIPELINE.map((step) => {
            const done = state.completedNodes.includes(step.id);
            const active = state.activeNode === step.id && state.isRunning;
            return (
              <div
                key={step.id}
                className={`rounded-lg border px-3 py-2.5 text-center text-xs font-medium transition ${
                  active
                    ? "border-blue-500 bg-blue-950/40 text-blue-300"
                    : done
                    ? "border-emerald-700/70 bg-emerald-950/30 text-emerald-300"
                    : "border-zinc-800 bg-zinc-900/40 text-zinc-500"
                }`}
              >
                {step.label}
              </div>
            );
          })}
        </section>

        {state.errors.length > 0 && (
          <section className="rounded-xl border border-red-900/70 bg-red-950/30 p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-400">
              Errors & Reflection
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
              <ol className="space-y-2 text-sm text-zinc-200">
                {state.plan.map((step, i) => (
                  <li key={i} className="leading-relaxed">
                    {step}
                  </li>
                ))}
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
                      <span className="ml-3 shrink-0 text-zinc-400">
                        {chunk.score.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        {(state.testResults.output || state.testResults.pr_url) && (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Test Output & Pull Request
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
            {state.testResults.pr_url && (
              <p className="mt-3 text-xs text-zinc-400">
                PR Status:{" "}
                <span className="font-mono text-zinc-200">
                  {state.testResults.pr_url}
                </span>
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}