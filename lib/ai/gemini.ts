import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HttpError } from '../http-error';

/**
 * Minimal Gemini client for a local tool. Auth, first configured wins:
 *   1. GEMINI_API_KEY — Google AI Studio.
 *   2. Vertex AI (VERTEX_PROJECT_ID) with VERTEX_ACCESS_TOKEN, or VERTEX_USE_ADC=1 for the
 *      local `gcloud auth application-default login`.
 */

const TOKEN_TIMEOUT_MS = 8_000;
const GENERATE_TIMEOUT_MS = 150_000;
/** Back-off before attempts 2–5; image-model capacity is often busy for tens of seconds. */
const RETRY_DELAYS_MS = [3_000, 8_000, 15_000, 25_000];
const NOT_CONFIGURED = 'AI is not configured';
const UNAVAILABLE = 'AI is temporarily unavailable';

export class GeminiError extends HttpError {
  constructor(logMessage: string, userMessage: string, status = 502) {
    super(status, userMessage, logMessage);
  }
}

/** Google's capacity is busy (429) or failing (5xx): worth asking again. */
const isTransient = (status: number) => status === 429 || status >= 500;

// ---- access token ------------------------------------------------------------

const g = globalThis as unknown as { geminiToken?: { token: string; expiresAt: number } };

function adcPath(): string {
  return process.env.APPDATA
    ? join(process.env.APPDATA, 'gcloud', 'application_default_credentials.json')
    : join(process.env.HOME ?? '', '.config', 'gcloud', 'application_default_credentials.json');
}

/** Refreshes the gcloud application-default login; reused until 5 minutes before expiry. */
async function adcToken(): Promise<string> {
  if (g.geminiToken && g.geminiToken.expiresAt > Date.now()) return g.geminiToken.token;

  const path = adcPath();
  if (!existsSync(path)) throw new GeminiError('No gcloud login — run `gcloud auth application-default login`', NOT_CONFIGURED);
  const cred = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string | undefined>;
  if (cred.type !== 'authorized_user' || !cred.refresh_token) {
    throw new GeminiError(`Unsupported ADC credential type "${cred.type}"`, NOT_CONFIGURED);
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cred.client_id ?? '',
      client_secret: cred.client_secret ?? '',
      refresh_token: cred.refresh_token,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !json.access_token) {
    throw new GeminiError(
      `gcloud login refresh failed (HTTP ${res.status}): ${json.error ?? ''}`,
      json.error === 'invalid_grant' ? 'Google login expired — run `gcloud auth application-default login`' : UNAVAILABLE
    );
  }
  g.geminiToken = { token: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 3600) - 300) * 1000 };
  return json.access_token;
}

async function endpoint(model: string): Promise<{ url: string; headers: Record<string, string> }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'x-goog-api-key': apiKey },
    };
  }

  const project = process.env.VERTEX_PROJECT_ID;
  if (!project) throw new GeminiError('Set GEMINI_API_KEY or VERTEX_PROJECT_ID', NOT_CONFIGURED);
  const location = process.env.VERTEX_LOCATION || 'global';
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;

  let token = process.env.VERTEX_ACCESS_TOKEN;
  if (!token && process.env.VERTEX_USE_ADC === '1') token = await adcToken();
  if (!token) throw new GeminiError('No Vertex credential configured', NOT_CONFIGURED);

  return {
    url: `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

// ---- request -------------------------------------------------------------------

export interface InlineImage {
  data: Buffer;
  mimeType: string;
}

interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface Envelope {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string; finishMessage?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: unknown;
  error?: { message?: string };
}

/** Called before each retry, so a run can show "AI busy, retrying 2/5". */
export type OnRetry = (attempt: number, of: number, status: number) => void;

async function call(model: string, images: InlineImage[], prompt: string, generationConfig: object, onRetry?: OnRetry): Promise<Envelope> {
  const { url, headers } = await endpoint(model);
  const started = Date.now();
  const deadline = started + GENERATE_TIMEOUT_MS;
  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data.toString('base64') } })), { text: prompt }],
      },
    ],
    generationConfig,
  });

  let res: Response;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1_000)),
      });
    } catch (err) {
      const timedOut = (err as { name?: string }).name === 'TimeoutError';
      throw new GeminiError(timedOut ? `${model} timed out` : `${model} unreachable: ${err}`, timedOut ? 'The AI took too long' : UNAVAILABLE, 504);
    }
    const wait = RETRY_DELAYS_MS[attempt - 1];
    // Retry only while there's time left for a full generation afterwards.
    if (!isTransient(res.status) || wait === undefined || deadline - Date.now() < wait + 20_000) break;
    console.warn(`[gemini] ${model} HTTP ${res.status} on attempt ${attempt}, retrying in ${wait}ms`);
    onRetry?.(attempt + 1, RETRY_DELAYS_MS.length + 1, res.status);
    await new Promise((r) => setTimeout(r, wait));
  }

  const env = (await res.json().catch(() => ({}))) as Envelope;
  console.log(`[gemini] ${model} ${res.status} ${Date.now() - started}ms usage=${JSON.stringify(env.usageMetadata ?? null)}`);
  if (!res.ok) {
    const busy = isTransient(res.status);
    throw new GeminiError(
      `${model} HTTP ${res.status}: ${env.error?.message ?? 'no body'}`,
      busy ? 'The AI is busy — try again in a moment' : `The AI refused the request: ${env.error?.message ?? res.status}`,
      busy ? 503 : 502
    );
  }
  return env;
}

function noOutput(model: string, env: Envelope, what: string): GeminiError {
  const cand = env.candidates?.[0];
  const reason = env.promptFeedback?.blockReason ?? cand?.finishReason ?? 'EMPTY';
  return new GeminiError(
    `${model} returned no ${what} (reason ${reason})${cand?.finishMessage ? `: ${cand.finishMessage}` : ''}`,
    /SAFETY|PROHIBITED|BLOCK|IMAGE_OTHER/.test(reason)
      ? `Google's safety filter blocked this (${reason}). Try another photo or soften the prompt.`
      : `The AI returned no ${what} (${reason}) — try again`,
    422
  );
}

/** Images + instruction in, one image out. */
export async function generateImage(
  images: InlineImage[],
  prompt: string,
  opts: { aspectRatio?: string; onRetry?: OnRetry } = {}
): Promise<Buffer> {
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image';
  const env = await call(
    model,
    images,
    prompt,
    {
      responseModalities: ['IMAGE'],
      imageConfig: { imageSize: '2K', ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}) },
    },
    opts.onRetry
  );
  for (const part of env.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64');
  }
  throw noOutput(model, env, 'image');
}

/** Images + instruction in, JSON matching `schema` out (the cheap text model). */
export async function generateJson<T>(images: InlineImage[], prompt: string, schema: object): Promise<T> {
  const model = process.env.GEMINI_TEXT_MODEL || 'gemini-3.8-flash';
  const env = await call(model, images, prompt, { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.4 });
  const text = (env.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text) throw noOutput(model, env, 'text');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError(`${model} returned invalid JSON: ${text.slice(0, 200)}`, 'The AI returned something unreadable — try again');
  }
}
