export type Mode = 'production' | 'development';
export type ServiceState = 'stopped' | 'starting' | 'running' | 'error';
export type LogSource = 'app' | 'database' | 'launcher';
export type Command = 'start' | 'stop' | 'restart' | 'mode' | 'build' | 'shutdown' | 'detach';
export interface ProcessIdentity {
  pid: number;
  parentPid: number;
  created: string;
  command: string;
  cpuSeconds: number;
  memory: number;
}
export interface LogLine { id: number; time: number; source: LogSource; level: 'info' | 'error'; text: string }
export interface Sample { time: number; appCpu: number | null; appMemory: number | null; dbCpu: number | null; dbMemory: number | null; rx: number | null; tx: number | null }
export interface DatabaseStats {
  size: number;
  connections: number;
  papers: Record<string, number>;
  sessions: Record<string, number>;
  counts: Record<string, number>;
}
export interface Snapshot {
  mode: Mode;
  port: number;
  app: ServiceState;
  database: ServiceState;
  docker: ServiceState;
  startedAt: number | null;
  phase: string;
  phaseAt: number;
  busy: boolean;
  error: string | null;
  logs: LogLine[];
  samples: Sample[];
  stats: DatabaseStats | null;
  processes: Array<{ pid: number; parentPid: number; memory: number }>;
  detached: boolean;
}
export interface Config {
  root: string;
  runtime: string;
  envFile: string;
  composeFile: string;
  project: string;
  port: number;
  mode: Mode;
}
export type ClientMessage = { type: 'hello'; token: string } | { type: 'command'; command: Command } | { type: 'ping' };
export type ServerMessage = { type: 'snapshot'; snapshot: Snapshot } | { type: 'exit'; detached: boolean };
