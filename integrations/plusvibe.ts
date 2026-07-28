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
    timeout: 60_000,
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
  | { ok: true; campaignId: string; workspaceId: string; count: number }
  | { ok: false; campaignId: string; workspaceId: string; error: string; count: number };

export type PlusVibeCampaignLead = {
  _id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  status?: string;
  campaign_id?: string;
};

export async function fetchCampaignLeads(
  target: UploadTarget,
  opts: { pageSize?: number; delayMs?: number } = {}
): Promise<PlusVibeCampaignLead[]> {
  const pageSize = opts.pageSize ?? 100;
  const delayMs = opts.delayMs ?? 250;
  const c = getClient();
  const leads: PlusVibeCampaignLead[] = [];
  let page = 1;
  let failures = 0;

  while (true) {
    try {
      const resp = await c.get("/api/v1/lead/workspace-leads", {
        params: {
          workspace_id: target.workspaceId,
          campaign_id: target.campaignId,
          page,
          limit: pageSize
        },
        validateStatus: () => true
      });
      if (resp.status === 403 || resp.status === 429) {
        failures++;
        await new Promise((r) => setTimeout(r, Math.min(45_000, 3000 * failures)));
        if (failures > 15) break;
        continue;
      }
      if (resp.status !== 200) break;
      failures = 0;
      const rows = Array.isArray(resp.data)
        ? resp.data
        : ((resp.data?.leads ?? resp.data?.data ?? []) as PlusVibeCampaignLead[]);
      if (!rows.length) break;
      leads.push(...rows);
      if (rows.length < pageSize) break;
      page++;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    } catch {
      failures++;
      if (failures > 15) break;
      await new Promise((r) => setTimeout(r, 3000 * failures));
    }
  }
  return leads;
}

export async function uploadLead(
  payload: PlusVibeLeadPayload,
  target: UploadTarget
): Promise<{ ok: boolean; campaignId: string; workspaceId: string; error?: string }> {
  const result = await uploadLeadsBatch([payload], target);
  return {
    ok: result.ok,
    campaignId: target.campaignId,
    workspaceId: target.workspaceId,
    error: result.ok ? undefined : result.error
  };
}

export async function uploadLeadsBatch(
  payloads: PlusVibeLeadPayload[],
  target: UploadTarget
): Promise<UploadResult> {
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
          skip_if_in_workspace: true,
          is_overwrite: true,
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
