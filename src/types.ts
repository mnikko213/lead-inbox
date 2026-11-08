export const SERVICES = ["cleaning", "repair", "consultation", "other"] as const;
export const CATEGORIES = ["booking", "question", "complaint", "other"] as const;
export const URGENCIES = ["high", "normal", "low"] as const;
export const STATUSES = ["new", "contacted", "won", "lost"] as const;

export type Service = (typeof SERVICES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Urgency = (typeof URGENCIES)[number];
export type Status = (typeof STATUSES)[number];

/** The public lead shape. Other teams build on this, so it must not drift. */
export interface Lead {
  id: number;
  name: string;
  email: string;
  phone: string;
  service: Service;
  message: string;
  category: Category;
  urgency: Urgency;
  status: Status;
  note: string;
  created_at: string;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Optional. Without it, the rule-based sorter handles every lead. */
  AI?: Ai;
  AI_MODEL?: string;
  API_TOKEN?: string;
  WEBHOOK_URL?: string;
  OWNER_USERNAME?: string;
  OWNER_PASSWORD?: string;
  SESSION_SECRET?: string;
}
