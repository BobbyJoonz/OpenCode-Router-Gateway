export interface ActiveConnection {
  id: number;
  protocol: string;
  address: string;
  port: number;
  remark: string;
  security: string;
  network: string;
  latency_ms?: number;
  egress_ip?: string;
  reason?: string;
  connected_at: string;
}

export interface OpenCodeInfo {
  installed: boolean;
  version?: string;
  binaryPath: string;
  configPath?: string;
  defaultModel?: string;
}

export interface SystemStatus {
  phase: 'idle' | 'discovering' | 'testing' | 'success' | 'rate_limited' | 'auth_error' | 'failed' | 'exhausted' | 'stopped';
  isRunning: boolean;
  message: string;
  activeConnection: ActiveConnection | null;
  opencode: OpenCodeInfo;
  normalIp: string;
  socksPort: string;
  httpPort: string;
  stats: {
    totalConfigs: number;
    workingCount: number;
    failedCount: number;
    untestedCount: number;
  };
}

export interface CandidateItem {
  id: number;
  protocol: 'vless' | 'vmess' | 'trojan' | 'ss';
  address: string;
  port: number;
  remark: string;
  security: string;
  network: string;
  last_tested_at?: string;
  last_latency_ms?: number;
  last_status: 'untested' | 'working' | 'failed' | 'rate_limited';
  consecutive_failures: number;
  success_count: number;
  is_active: number;
  created_at: string;
}

export interface SourceItem {
  id: number;
  name: string;
  url: string;
  enabled: number;
  last_fetched_at: string | null;
  fetch_status: string | null;
  config_count: number;
}
