import axios, { AxiosInstance } from "axios";
import { withRetry } from "./openai.js";

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (client) return client;
  const apiKey = process.env.PLUSVIBE_KEY;
  if (!apiKey) {
    throw new Error("PLUSVIBE_KEY not set; the startup gate should have caught this.");
  }
  const baseURL = process.env.PLUSVIBE_BASE_URL ?? "https://api.plusvibe.ai";
  client = axios.create({
    baseURL,
    timeout: 30_000,
    headers: {
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    }
  });
  return client;
}

export type PlusVibeLeadPayload = {
  email: string;
  first_name?: string;
  last_name?: string;
  notes?: string;
  address_line?: string;
  city?: string;
  country?: string;
  country_code?: string;
  phone_number?: string;
  company_name?: string;
  company_website?: string;
  linkedin_person_url?: string;
  linkedin_company_url?: string;
  custom_variables?: Record<string, string>;
};

export type UploadTarget = { workspaceId: string; campaignId: string };

export type UploadResult =
  | { ok: true; campaignId: string; workspaceId: string }
  | { ok: false; campaignId: string; workspaceId: string; error: string };

export async function uploadLead(
  payload: PlusVibeLeadPayload,
  target: UploadTarget
): Promise<UploadResult> {
  const batch = await uploadLeadsBatch([payload], target);
  return batch.ok
    ? { ok: true, campaignId: target.campaignId, workspaceId: target.workspaceId }
    : { ok: false, campaignId: target.campaignId, workspaceId: target.workspaceId, error: batch.error ?? "unknown error" };
}

export type BatchUploadResult =
  | { ok: true; campaignId: string; workspaceId: string; count: number }
  | { ok: false; campaignId: string; workspaceId: string; error: string; count: number };

export async function uploadLeadsBatch(
  payloads: PlusVibeLeadPayload[],
  target: UploadTarget,
  opts: { isOverwrite?: boolean } = {}
): Promise<BatchUploadResult> {
  if (payloads.length === 0) {
    return { ok: true, campaignId: target.campaignId, workspaceId: target.workspaceId, count: 0 };
  }
  const c = getClient();
  try {
    await withRetry(
      async () => {
        await c.post("/api/v1/lead/add", {
          workspace_id: target.workspaceId,
          campaign_id: target.campaignId,
          is_overwrite: opts.isOverwrite ?? true,
          leads: payloads
        });
      },
      { label: `plusvibe.uploadBatch ${target.campaignId} x${payloads.length}` }
    );
    return { ok: true, campaignId: target.campaignId, workspaceId: target.workspaceId, count: payloads.length };
  } catch (err: unknown) {
    let msg = "unknown error";
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? "n/a";
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0, 500) : err.message;
      msg = `status=${status} body=${body}`;
    } else if (err instanceof Error) {
      msg = err.message;
    }
    return { ok: false, campaignId: target.campaignId, workspaceId: target.workspaceId, error: msg, count: 0 };
  }
}
