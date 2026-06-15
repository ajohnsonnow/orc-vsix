/**
 * ORC — ComfyUI Client
 *
 * Local image generation against a running ComfyUI server (default :8188).
 *
 * Two modes:
 *   1. Custom workflow (recommended, architecture-agnostic) — the user exports
 *      their tuned workflow from ComfyUI (Save → API Format) and puts the token
 *      %ORC_PROMPT% in the positive-prompt text field. ORC injects the prompt,
 *      randomizes seeds, and submits. Works for SDXL, Flux, HiDream, SD3, etc.
 *   2. Built-in fallback — if no workflow is configured, ORC discovers a
 *      checkpoint via CheckpointLoaderSimple and builds a standard txt2img graph.
 *      Only works for installs that have a classic checkpoint.
 *
 * Dependency-free (global fetch). All calls are bounded so a missing/idle server
 * surfaces a clear error instead of hanging.
 */

export const PROMPT_TOKEN = '%ORC_PROMPT%';

export interface ImageGenOptions {
  /** Raw API-format workflow JSON containing the %ORC_PROMPT% placeholder. */
  workflowJson?: string;
  /** Checkpoint name for the built-in fallback graph (auto-discovered if omitted). */
  checkpoint?: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
}

export interface GeneratedImage {
  bytes: Uint8Array;
  filename: string;
  /** Checkpoint name or "custom workflow" — for display. */
  source: string;
}

type WorkflowGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

async function fetchJson(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    if (!resp.ok) { throw new Error(`HTTP ${resp.status} for ${url}`); }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Lists checkpoint model names registered with CheckpointLoaderSimple. */
export async function listCheckpoints(endpoint: string, timeoutMs = 5000): Promise<string[]> {
  const info = (await fetchJson(`${trimSlash(endpoint)}/object_info/CheckpointLoaderSimple`, undefined, timeoutMs)) as Record<string, unknown>;
  const loader = info['CheckpointLoaderSimple'] as { input?: { required?: { ckpt_name?: unknown[] } } } | undefined;
  const names = loader?.input?.required?.ckpt_name?.[0];
  return Array.isArray(names) ? (names as string[]) : [];
}

/**
 * Injects `prompt` into every input containing %ORC_PROMPT% and randomizes any
 * `seed`/`noise_seed` inputs so each run differs. Throws if the placeholder is
 * absent (otherwise the user's prompt would be silently ignored).
 */
export function applyWorkflowTemplate(workflowJson: string, prompt: string): WorkflowGraph {
  const graph = JSON.parse(workflowJson) as WorkflowGraph;
  let replaced = 0;
  for (const node of Object.values(graph)) {
    const inputs = node?.inputs;
    if (!inputs || typeof inputs !== 'object') { continue; }
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value === 'string' && value.includes(PROMPT_TOKEN)) {
        inputs[key] = value.replaceAll(PROMPT_TOKEN, prompt);
        replaced++;
      } else if ((key === 'seed' || key === 'noise_seed') && typeof value === 'number') {
        inputs[key] = randomSeed();
      }
    }
  }
  if (replaced === 0) {
    throw new Error(`Workflow has no ${PROMPT_TOKEN} placeholder — add it to your positive-prompt text field, re-export (Save → API Format), and retry.`);
  }
  return graph;
}

function buildTxt2ImgGraph(prompt: string, checkpoint: string, opts: ImageGenOptions): WorkflowGraph {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: randomSeed(),
        steps: opts.steps ?? 25,
        cfg: opts.cfg ?? 7,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: opts.width ?? 1024, height: opts.height ?? 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: opts.negativePrompt ?? 'low quality, blurry, watermark, text', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ORC', images: ['8', 0] } },
  };
}

interface HistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
}

/** Queues a graph, polls history until an image appears, and downloads it. */
async function runWorkflow(
  base: string,
  graph: WorkflowGraph,
  onProgress?: (message: string) => void,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const clientId = `orc-${Date.now()}`;
  const queued = (await fetchJson(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
  }, 15_000)) as { prompt_id?: string; node_errors?: Record<string, unknown> };

  if (queued.node_errors && Object.keys(queued.node_errors).length > 0) {
    throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(queued.node_errors)}`);
  }
  const promptId = queued.prompt_id;
  if (!promptId) { throw new Error('ComfyUI did not return a prompt_id.'); }

  const startMs = Date.now();
  const deadline = startMs + 180_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    attempt++;
    if (attempt % 4 === 0) { onProgress?.(`Rendering... (${Math.round((Date.now() - startMs) / 1000)}s)`); }

    let history: Record<string, HistoryEntry>;
    try {
      history = (await fetchJson(`${base}/history/${promptId}`, undefined, 8000)) as Record<string, HistoryEntry>;
    } catch {
      continue; // transient — keep polling
    }
    const entry = history[promptId];
    const image = entry?.outputs && Object.values(entry.outputs).flatMap(o => o.images ?? [])[0];
    if (image) {
      onProgress?.('Downloading image...');
      const url = `${base}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) { throw new Error(`HTTP ${resp.status} downloading image`); }
        return { bytes: new Uint8Array(await resp.arrayBuffer()), filename: image.filename };
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error('ComfyUI render timed out after 180s.');
}

/**
 * Generates an image from a text prompt. Uses a custom workflow template when
 * provided (any architecture); otherwise falls back to a discovered checkpoint.
 */
export async function generateImage(
  endpoint: string,
  prompt: string,
  opts: ImageGenOptions = {},
  onProgress?: (message: string) => void,
): Promise<GeneratedImage> {
  const base = trimSlash(endpoint);

  if (opts.workflowJson) {
    const graph = applyWorkflowTemplate(opts.workflowJson, prompt);
    onProgress?.('Queuing your ComfyUI workflow...');
    const img = await runWorkflow(base, graph, onProgress);
    return { ...img, source: 'custom workflow' };
  }

  let checkpoint = opts.checkpoint;
  if (!checkpoint) {
    const cks = await listCheckpoints(base);
    if (cks.length === 0) {
      throw new Error(
        `No ComfyUI checkpoints found at ${base}. This install may use Flux/HiDream/SD3 ` +
        `(UNETLoader) rather than a classic checkpoint. Export your working workflow ` +
        `(Save → API Format), put ${PROMPT_TOKEN} in the prompt field, and set ` +
        `"orc.comfyWorkflowPath" to that file.`,
      );
    }
    checkpoint = cks[0];
  }
  onProgress?.(`Queuing with checkpoint "${checkpoint}"...`);
  const img = await runWorkflow(base, buildTxt2ImgGraph(prompt, checkpoint, opts), onProgress);
  return { ...img, source: checkpoint };
}
