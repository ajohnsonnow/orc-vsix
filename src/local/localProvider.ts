/**
 * ORC — Local Provider Detection
 *
 * Lightweight health checks for the on-machine inference servers ORC can route
 * to: LM Studio (OpenAI-compatible, default :1234) and ComfyUI (image gen,
 * default :8188). Used by the pipeline to decide whether hybrid routing can
 * safely send a task to a local model, and by the image command.
 *
 * Everything is best-effort with a short timeout — a down server must never
 * block the UI; hybrid routing simply falls back to Claude.
 */

export interface LocalServerStatus {
  reachable: boolean;
  /** Model ids served by the endpoint (LM Studio /v1/models). */
  models: string[];
  error?: string;
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Pings LM Studio's /v1/models and returns reachability + served model ids. */
export async function checkLMStudio(endpoint: string, timeoutMs = 2500): Promise<LocalServerStatus> {
  try {
    const resp = await fetchWithTimeout(`${trimSlash(endpoint)}/v1/models`, timeoutMs);
    if (!resp.ok) {
      return { reachable: false, models: [], error: `HTTP ${resp.status}` };
    }
    const json = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models = (json.data ?? []).map(m => m.id).filter((id): id is string => typeof id === 'string');
    return { reachable: true, models };
  } catch (err) {
    return { reachable: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** True if `modelId` is currently served by the LM Studio endpoint. */
export function isModelAvailable(status: LocalServerStatus, modelId: string): boolean {
  return status.reachable && status.models.includes(modelId);
}

/** Pings ComfyUI's /system_stats to confirm it is up. */
export async function checkComfyUI(endpoint: string, timeoutMs = 2500): Promise<{ reachable: boolean; error?: string }> {
  try {
    const resp = await fetchWithTimeout(`${trimSlash(endpoint)}/system_stats`, timeoutMs);
    return resp.ok ? { reachable: true } : { reachable: false, error: `HTTP ${resp.status}` };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}
