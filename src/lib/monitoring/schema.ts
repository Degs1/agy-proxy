import { ObjectId } from 'mongodb';
import {
  UsageLogDocument,
  PreauthRejectionLogDocument,
  PreauthRejectionCounterDocument,
} from '@/lib/db/schema';

export type {
  UsageLogDocument,
  PreauthRejectionLogDocument,
  PreauthRejectionCounterDocument,
};

export interface RecordUsageLogParams {
  requestId?: string | null;
  projectId: ObjectId;
  apiKeyId?: ObjectId | null;
  model?: string | null;
  provider?: string | null;
  statusCode: number;
  durationMs: number;
  result: 'success' | 'error' | 'cancelled' | 'timeout';
  errorCode?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  streaming: boolean;
  createdAt?: Date;
}

export interface RecordPreauthRejectionParams {
  requestId?: string | null;
  startTime: Date;
  durationMs: number;
  statusCode: number;
  errorCode?: string | null;
  overrideMinute?: Date;
}

export interface PreauthRejectionResult {
  recorded: boolean;
  error?: unknown;
}

export interface MonitoringQueryOptions {
  projectId?: string;
  provider?: string;
  status?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
  type?: 'all' | 'preauth';
}

export interface MonitoringProjectSummary {
  projectId: string;
  projectName: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface MonitoringProviderSummary {
  provider: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface MonitoringSummaryResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageDurationMs: number;
  totalTokens: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  projects: MonitoringProjectSummary[];
  providers: MonitoringProviderSummary[];
  preauthRejections: {
    total: number;
  };
}

export interface MonitoringDetailsLogItem {
  id: string;
  requestId?: string | null;
  projectId: string | null;
  projectName?: string | null;
  model: string | null;
  provider: string | null;
  statusCode: number;
  durationMs: number;
  result: string;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  streaming: boolean;
  createdAt: string;
}

export interface MonitoringDetailsResult {
  logs: MonitoringDetailsLogItem[];
  total: number;
  limit: number;
  offset: number;
}
