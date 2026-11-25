"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { clearStoredAuth, getAuthHeaders } from "@/lib/auth";
import {
  ActivityLogEntry,
  AgentNode,
  AgentRunPayload,
  AgentRunState,
  AgentStreamEvent,
  ModifiedFileStat,
  PipelineStepId,
  RunStatus,
} from "@/types/agent";

const PIPELINE_STEPS: Set<PipelineStepId> = new Set([
  "retriever",
  "planner",
  "coding",
  "testing",
  "pr_creator",
]);

const NEXT_STEP_MAP: Partial<Record<AgentNode, PipelineStepId>> = {
  retriever: "planner",
  planner: "coding",
  coding: "testing",
  testing: "pr_creator",
  reflection: "coding",
};

const NODE_LABELS: Record<AgentNode, string> = {
  retriever: "Retriever",
  planner: "Planner",
  coding: "Coding",
  testing: "Testing",
  reflection: "Reflection",
  pr_creator: "PR Creator",
  end: "Finished",
};

const initialState: AgentRunState = {
  isRunning: false,
  activeNode: null,
  completedNodes: [],
  failedNode: null,
  stepStartTimes: {},
  stepDurationsMs: {},
  stepRetries: {},
  runStartedAt: null,
  runFinishedAt: null,
  plan: [],
  retrievedContext: [],
  modifiedFiles: [],
  explanation: "",
  branchName: null,
  prTitle: null,
  prNumber: null,
  testResults: {},
  retryCount: 0,
  status: "idle",
  errors: [],
  activityLog: [],
  rawEvents: [],
};

function normalizeModifiedFiles(
  rawList: Array<string | ModifiedFileStat> | undefined,
  plan: string[]
): ModifiedFileStat[] {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const planText = plan.join("\n").toLowerCase();
  const seen = new Set<string>();
  const normalized: ModifiedFileStat[] = [];

  for (const item of rawList) {
    if (typeof item === "string") {
      const clean = item.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      const base = clean.split("/").pop()?.toLowerCase() ?? "";
      const isAdded =
        planText.includes(`create ${clean.toLowerCase()}`) ||
        planText.includes(`create ${base}`) ||
        planText.includes(`new file ${base}`);
      normalized.push({
        path: clean,
        status: isAdded ? "added" : "modified",
      });
    } else if (item && typeof item === "object" && item.path) {
      const clean = item.path.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      normalized.push({
        path: clean,
        additions: item.additions,
        deletions: item.deletions,
        status: item.status ?? "modified",
      });
    }
  }
  return normalized;
}

function parseBranchFromEvents(events: AgentStreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const upd = events[i].state_update;
    if (upd?.branch_name) return upd.branch_name;
    if (upd?.test_results?.branch_name) return upd.test_results.branch_name;
    const serialized = JSON.stringify(upd ?? "");
    const match = serialized.match(/codepilot-fix-[a-f0-9]{6,12}/i);
    if (match) return match[0];
  }
  return null;
}

export function deriveRunStatus(state: AgentRunState): RunStatus {
  if (state.isRunning) {
    if (state.activeNode === "reflection" || state.retryCount > 0) {
      return "retrying";
    }
    return "running";
  }

  if (
    state.status === "idle" &&
    state.completedNodes.length === 0 &&
    state.errors.length === 0 &&
    !state.testResults.pr_url
  ) {
    return "idle";
  }

  if (
    Boolean(state.testResults.pr_url) ||
    state.status === "pr_created" ||
    (state.status === "completed" &&
      state.testResults.passed === true &&
      state.errors.length === 0)
  ) {
    return "completed";
  }

  return "failed";
}

interface UseAgentStreamOptions {
  onUnauthorized?: () => void;
}

export function useAgentStream(options?: UseAgentStreamOptions) {
  const [state, setState] = useState<AgentRunState>(initialState);
  const controllerRef = useRef<AbortController | null>(null);

  const stopAgent = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    const now = Date.now();
    setState((prev) => ({
      ...prev,
      isRunning: false,
      runFinishedAt: now,
      status: prev.status === "completed" ? "completed" : "stopped",
      errors:
        prev.status === "completed"
          ? prev.errors
          : [...prev.errors, "Execution stopped by user."],
      activityLog: [
        ...prev.activityLog,
        {
          id: `stop-${now}`,
          timestamp: now,
          node: prev.activeNode ?? "end",
          label: "Run Stopped",
          detail: "Agent execution cancelled manually.",
          tone: "danger",
        },
      ],
    }));
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(initialState);
  }, []);

  const runAgent = useCallback(
    async (payload: AgentRunPayload) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const startedAt = Date.now();
      setState({
        ...initialState,
        isRunning: true,
        activeNode: "retriever",
        stepStartTimes: { retriever: startedAt },
        runStartedAt: startedAt,
        status: "running",
        activityLog: [
          {
            id: `start-${startedAt}`,
            timestamp: startedAt,
            node: "retriever",
            label: "Run Started",
            detail: "Syncing repository and retrieving relevant code chunks.",
            tone: "running",
          },
        ],
      });

      const apiUrl = (process.env.NEXT_PUBLIC_API_URL || "")
        .trim()
        .replace(/\/+$/, "");

      if (!apiUrl) {
        const now = Date.now();
        setState((prev) => ({
          ...prev,
          isRunning: false,
          runFinishedAt: now,
          status: "error",
          errors: ["NEXT_PUBLIC_API_URL is not configured."],
        }));
        return;
      }

      try {
        const res = await fetch(`${apiUrl}/agent/run`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (res.status === 401) {
          clearStoredAuth();
          options?.onUnauthorized?.();
          throw new Error(
            "Your session expired. Please sign in with GitHub again."
          );
        }

        if (!res.ok || !res.body) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(
            errBody.message ||
              errBody.detail ||
              `Request failed with status ${res.status}`
          );
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // Split on both LF and CRLF SSE frame boundaries
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const dataLines = part
              .split(/\r?\n/)
              .filter((l) => l.startsWith("data: "));

            for (const line of dataLines) {
              const event: AgentStreamEvent = JSON.parse(line.slice(6));
              const now = Date.now();

              if (event.error) {
                setState((prev) => ({
                  ...prev,
                  isRunning: false,
                  runFinishedAt: now,
                  status: "error",
                  errors: [...prev.errors, event.error as string],
                  activityLog: [
                    ...prev.activityLog,
                    {
                      id: `err-${now}-${prev.activityLog.length}`,
                      timestamp: now,
                      node: event.node ?? "end",
                      label: "Stream Error",
                      detail: event.error as string,
                      tone: "danger",
                    },
                  ],
                  rawEvents: [...prev.rawEvents, event],
                }));
                continue;
              }

              const update = event.state_update;

              setState((prev) => {
                const rawEvents = [...prev.rawEvents, event];
                const nextPlan = update?.plan ?? prev.plan;

                // Preserve non-empty modified files across subsequent nodes (testing, pr_creator)
                const incomingFiles = normalizeModifiedFiles(
                  update?.modified_files,
                  nextPlan
                );
                let nextModifiedFiles =
                  incomingFiles.length > 0 ? incomingFiles : prev.modifiedFiles;

                // Fallback recovery: scan rawEvents for any coding node modified_files
                if (nextModifiedFiles.length === 0) {
                  for (let i = rawEvents.length - 1; i >= 0; i--) {
                    const fallback = normalizeModifiedFiles(
                      rawEvents[i].state_update?.modified_files,
                      nextPlan
                    );
                    if (fallback.length > 0) {
                      nextModifiedFiles = fallback;
                      break;
                    }
                  }
                }

                // Track per-step duration when a pipeline step completes
                const stepDurationsMs = { ...prev.stepDurationsMs };
                const stepStartTimes = { ...prev.stepStartTimes };
                if (PIPELINE_STEPS.has(event.node as PipelineStepId)) {
                  const stepId = event.node as PipelineStepId;
                  const started =
                    stepStartTimes[stepId] ?? prev.runStartedAt ?? now;
                  stepDurationsMs[stepId] = Math.max(
                    100,
                    now - started
                  );
                }

                // Predict and start timer for next pipeline step
                const predictedNext = NEXT_STEP_MAP[event.node];
                if (predictedNext && event.node !== "end") {
                  stepStartTimes[predictedNext] = now;
                }

                // Track per-step retries (Coding / Testing)
                const stepRetries = { ...prev.stepRetries };
                const nextRetryCount = update?.retry_count ?? prev.retryCount;
                if (
                  event.node === "reflection" &&
                  nextRetryCount > prev.retryCount
                ) {
                  stepRetries.coding = (stepRetries.coding ?? 0) + 1;
                }

                const completedNodes = prev.completedNodes.includes(event.node)
                  ? prev.completedNodes
                  : [...prev.completedNodes, event.node];

                const nextTestResults = update?.test_results
                  ? { ...prev.testResults, ...update.test_results }
                  : prev.testResults;

                const nextStatus =
                  event.status ?? update?.status ?? prev.status;

                const nextErrors = update?.errors
                  ? [...prev.errors, ...update.errors]
                  : prev.errors;

                const isEnding = event.node === "end";
                let failedNode = prev.failedNode;
                if (isEnding && nextStatus === "error" && !nextTestResults.pr_url) {
                  const lastPipelineNode = [...completedNodes]
                    .reverse()
                    .find((n) => PIPELINE_STEPS.has(n as PipelineStepId)) as
                    | PipelineStepId
                    | undefined;
                  failedNode = lastPipelineNode ?? "coding";
                } else if (nextTestResults.pr_url) {
                  failedNode = null;
                }

                const logTone: ActivityLogEntry["tone"] =
                  event.node === "reflection"
                    ? "warning"
                    : nextStatus === "error"
                    ? "danger"
                    : event.node === "pr_creator" ||
                      nextStatus === "pr_created" ||
                      nextStatus === "completed"
                    ? "success"
                    : "running";

                const logDetail =
                  event.node === "retriever"
                    ? `Retrieved ${(update?.retrieved_context ?? prev.retrievedContext).length} code chunks.`
                    : event.node === "planner"
                    ? `Generated ${nextPlan.length}-step execution plan.`
                    : event.node === "coding"
                    ? nextModifiedFiles.length > 0
                      ? `Prepared edits across ${nextModifiedFiles.length} file(s).`
                      : "Coding step reported validation feedback."
                    : event.node === "testing"
                    ? update?.test_results?.passed
                      ? "Pytest suite passed."
                      : "Pytest suite failed; triggering reflection."
                    : event.node === "reflection"
                    ? `Diagnosed issue (retry ${nextRetryCount}).`
                    : event.node === "pr_creator"
                    ? nextTestResults.pr_url
                      ? `Opened PR: ${nextTestResults.pr_url}`
                      : "PR creation step finished."
                    : `Workflow finished (${nextStatus}).`;

                const nextActiveNode: AgentNode | null = isEnding
                  ? null
                  : predictedNext ?? event.node;

                return {
                  ...prev,
                  activeNode: nextActiveNode,
                  completedNodes,
                  failedNode,
                  stepStartTimes,
                  stepDurationsMs,
                  stepRetries,
                  runFinishedAt: isEnding ? now : prev.runFinishedAt,
                  plan: nextPlan,
                  retrievedContext:
                    update?.retrieved_context ?? prev.retrievedContext,
                  modifiedFiles: nextModifiedFiles,
                  explanation: update?.explanation ?? prev.explanation,
                  branchName:
                    update?.branch_name ??
                    nextTestResults.branch_name ??
                    prev.branchName ??
                    parseBranchFromEvents(rawEvents),
                  prTitle:
                    update?.pr_title ??
                    nextTestResults.pr_title ??
                    prev.prTitle,
                  prNumber:
                    update?.pr_number ??
                    nextTestResults.pr_number ??
                    prev.prNumber,
                  testResults: nextTestResults,
                  retryCount: nextRetryCount,
                  status: nextStatus,
                  errors: nextErrors,
                  isRunning: isEnding ? false : prev.isRunning,
                  activityLog: [
                    ...prev.activityLog,
                    {
                      id: `evt-${now}-${prev.activityLog.length}`,
                      timestamp: now,
                      node: event.node,
                      label: NODE_LABELS[event.node] ?? event.node,
                      detail: logDetail,
                      tone: logTone,
                    },
                  ],
                  rawEvents,
                };
              });
            }
          }
        }

        const finishedAt = Date.now();
        setState((prev) => ({
          ...prev,
          isRunning: false,
          activeNode: null,
          runFinishedAt: prev.runFinishedAt ?? finishedAt,
          status: prev.status === "running" ? "completed" : prev.status,
        }));
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        const now = Date.now();
        setState((prev) => ({
          ...prev,
          isRunning: false,
          activeNode: null,
          runFinishedAt: now,
          status: "error",
          errors: [...prev.errors, (err as Error).message],
          activityLog: [
            ...prev.activityLog,
            {
              id: `catch-${now}`,
              timestamp: now,
              node: prev.activeNode ?? "end",
              label: "Request Failed",
              detail: (err as Error).message,
              tone: "danger",
            },
          ],
        }));
      }
    },
    [options]
  );

  const runStatus = useMemo(() => deriveRunStatus(state), [state]);

  return { state, runStatus, runAgent, stopAgent, reset };
}