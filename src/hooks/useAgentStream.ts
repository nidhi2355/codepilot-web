"use client";

import { useCallback, useRef, useState } from "react";
import {
  AgentRunPayload,
  AgentRunState,
  AgentStreamEvent,
} from "@/types/agent";

const initialState: AgentRunState = {
  isRunning: false,
  activeNode: null,
  completedNodes: [],
  plan: [],
  retrievedContext: [],
  modifiedFiles: [],
  testResults: {},
  retryCount: 0,
  status: "idle",
  errors: [],
  rawEvents: [],
};

export function useAgentStream() {
  const [state, setState] = useState<AgentRunState>(initialState);
  const controllerRef = useRef<AbortController | null>(null);

  const stopAgent = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState((prev) => ({
      ...prev,
      isRunning: false,
      status: prev.status === "completed" ? "completed" : "stopped",
    }));
  }, []);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(initialState);
  }, []);

  const runAgent = useCallback(async (payload: AgentRunPayload) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState({
      ...initialState,
      isRunning: true,
      status: "running",
    });

    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!apiUrl) {
      setState((prev) => ({
        ...prev,
        isRunning: false,
        status: "error",
        errors: ["NEXT_PUBLIC_API_URL is not configured."],
      }));
      return;
    }

    try {
      const res = await fetch(`${apiUrl}/agent/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed with status ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part
            .split("\n")
            .find((l) => l.startsWith("data: "));
          if (!line) continue;

          const event: AgentStreamEvent = JSON.parse(line.slice(6));
          const update = event.state_update;

          setState((prev) => ({
            ...prev,
            activeNode: event.node,
            completedNodes: prev.completedNodes.includes(event.node)
              ? prev.completedNodes
              : [...prev.completedNodes, event.node],
            plan: update?.plan ?? prev.plan,
            retrievedContext:
              update?.retrieved_context ?? prev.retrievedContext,
            modifiedFiles: update?.modified_files ?? prev.modifiedFiles,
            testResults: update?.test_results
              ? { ...prev.testResults, ...update.test_results }
              : prev.testResults,
            retryCount: update?.retry_count ?? prev.retryCount,
            status: event.status ?? update?.status ?? prev.status,
            errors: update?.errors
              ? [...prev.errors, ...update.errors]
              : prev.errors,
            isRunning: event.node === "end" ? false : prev.isRunning,
            rawEvents: [...prev.rawEvents, event],
          }));
        }
      }

      setState((prev) => ({
        ...prev,
        isRunning: false,
        status: prev.status === "running" ? "completed" : prev.status,
      }));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState((prev) => ({
        ...prev,
        isRunning: false,
        status: "error",
        errors: [...prev.errors, (err as Error).message],
      }));
    }
  }, []);

  return { state, runAgent, stopAgent, reset };
}