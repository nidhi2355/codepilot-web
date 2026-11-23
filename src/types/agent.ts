export interface Repository {
  id: number;
  github_url: string;
  name: string;
  status: string;
  created_at: string;
}

export type AgentNode =
  | "retriever"
  | "planner"
  | "coding"
  | "testing"
  | "reflection"
  | "pr_creator"
  | "end";

export interface RetrievedChunk {
  score: number;
  file_path: string;
  content: string;
}

export interface TestResults {
  passed?: boolean;
  output?: string;
  pr_url?: string;
}

export interface AgentStateUpdate {
  plan?: string[];
  retrieved_context?: RetrievedChunk[];
  modified_files?: string[];
  test_results?: TestResults;
  retry_count?: number;
  status?: string;
  errors?: string[];
}

export interface AgentStreamEvent {
  node: AgentNode;
  state_update?: AgentStateUpdate;
  status?: string;
  error?: string;
}

export interface AgentRunPayload {
  repo_id: number;
  repo_path?: string;
  task: string;
  issue_number?: number;
}

export interface AgentRunState {
  isRunning: boolean;
  activeNode: AgentNode | null;
  completedNodes: AgentNode[];
  plan: string[];
  retrievedContext: RetrievedChunk[];
  modifiedFiles: string[];
  testResults: TestResults;
  retryCount: number;
  status: string;
  errors: string[];
  rawEvents: AgentStreamEvent[];
}