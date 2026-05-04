export type FeatureStatus = 'todo' | 'in_progress' | 'done' | 'archived';
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type EditType = 'created' | 'modified' | 'read';
export type LinkSource = 'manual' | 'auto' | 'confirmed';

export interface Project {
  id: string;
  name: string;
  tagline: string | null;
  goal: string | null;
  root_path: string;
  tech: string[];
  created_at: number;
  updated_at: number;
}

export interface Feature {
  id: string;
  project_id: string;
  name: string;
  goal: string | null;
  spec_md: string | null;
  status: FeatureStatus;
  priority: number;
  created_at: number;
  updated_at: number;
}

export interface Task {
  id: number;
  feature_id: string;
  name: string;
  status: TaskStatus;
  position: number;
  notes: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface Decision {
  id: string;
  project_id: string;
  feature_id: string | null;
  title: string;
  context: string | null;
  decision: string | null;
  alternatives: string | null;
  consequences: string | null;
  created_at: number;
}

export interface Session {
  id: string;
  project_id: string;
  feature_id: string | null;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  notes: string | null;
}

export interface SessionFile {
  session_id: string;
  file_path: string;
  edit_type: EditType;
}

export interface FeatureFile {
  feature_id: string;
  file_path: string;
  description: string | null;
  confidence: number;
  source: LinkSource;
  last_session_id: string | null;
  created_at: number;
}

export interface FileExplanation {
  project_id: string;
  file_path: string;
  content_hash: string;
  explanation: string;
  generated_at: number;
}

export interface ProjectStats {
  active_features: number;
  total_features: number;
  todo_tasks: number;
  done_tasks: number;
  sessions_this_week: number;
  decisions: number;
}

export interface FeatureContext {
  id: string;
  name: string;
  goal: string | null;
  status: FeatureStatus;
  progress: number;
  next_task: { id: number; name: string } | null;
}

export interface SessionStartContext {
  session_id: string;
  project: { id: string; name: string; goal: string | null };
  active_feature: FeatureContext | null;
  active_features: FeatureContext[];
  recent_decisions: Array<{ id: string; title: string; date: string }>;
  recent_sessions: Array<{ time: string; summary: string; feature: string | null }>;
  spec_md?: string | null;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}
