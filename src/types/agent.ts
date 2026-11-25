export type AgentNode =
  | "retriever"
  | "planner"
  | "coding"
  | "testing"
  | "reflection"
  | "pr_creator"
  | "end";

export type PipelineStepId =
  | "retriever"
  | "planner"
  | "coding"
  | "testing"
  | "pr_creator";

export type RunStatus =
  | "idle"
  | "running"
  | "retrying"
  | "completed"
  | "failed";

export interface Repository {
  id: number;
  github_url: string;
  name: string;
  status: string;
  created_at?: string;
}

export interface RetrievedChunk {
  file_path: string;
  score: number;
  content?: string;
}

export interface ModifiedFileStat {
  path: string;
  additions?: number;
  deletions?: number;
  status?: "added" | "modified";
}

export interface TestResults {
  passed?: boolean;
  output?: string;
  pr_url?: string;
  pr_title?: string;
  pr_number?: number;
  branch_name?: string;
}

export interface AgentRunPayload {
  repo_id: number;
  task: string;
  issue_number?: number;
}

export interface AgentStateUpdate {
  plan?: string[];
  retrieved_context?: RetrievedChunk[];
  modified_files?: Array<string | ModifiedFileStat>;
  test_results?: TestResults;
  retry_count?: number;
  status?: string;
  errors?: string[];
  explanation?: string;
  branch_name?: string;
  pr_title?: string;
  pr_number?: number;
}

export interface AgentStreamEvent {
  node: AgentNode;
  state_update?: AgentStateUpdate;
  status?: string;
  error?: string;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  node: AgentNode;
  label: string;
  detail: string;
  tone: "running" | "success" | "warning" | "danger" | "idle";
}

export interface AgentRunState {
  isRunning: boolean;
  activeNode: AgentNode | null;
  completedNodes: AgentNode[];
  failedNode: PipelineStepId | null;
  stepStartTimes: Partial<Record<PipelineStepId, number>>;
  stepDurationsMs: Partial<Record<PipelineStepId, number>>;
  stepRetries: Partial<Record<PipelineStepId, number>>;
  runStartedAt: number | null;
  runFinishedAt: number | null;
  plan: string[];
  retrievedContext: RetrievedChunk[];
  modifiedFiles: ModifiedFileStat[];
  explanation: string;
  branchName: string | null;
  prTitle: string | null;
  prNumber: number | null;
  testResults: TestResults;
  retryCount: number;
  status: string;
  errors: string[];
  activityLog: ActivityLogEntry[];
  rawEvents: AgentStreamEvent[];
}