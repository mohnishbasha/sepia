import OpenAI from 'openai';
import { createEngine } from '../engine/index.js';
import type { EngineOptions } from '../engine/index.js';
import { parseAction, dispatch } from '../actions/index.js';
import type { TypedAction } from '../actions/index.js';
import {
  createAuditor,
  redactSecrets,
  redactCompactView,
  sanitizeForLLM,
  createNamedProfile,
} from '../privacy/index.js';
import { createLogger } from '../telemetry/index.js';
import { estimateTokens } from '../serializer/index.js';
import type { ActionResult } from '../types/index.js';
import type { Outcome } from '../types/index.js';
import type { SepiaConfig } from '../config/index.js';
import type { CompactNode, CompactView } from '../types/index.js';

export interface StepTrace {
  stepN: number;
  action: string;
  handle?: string;
  confidence: number;
  tokensUsed: number;
  latencyMs: number;
  result: ActionResult;
  secretsRedacted: boolean;
}

export interface RunTrace {
  runId: string;
  goal: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  outcome: Outcome;
  totalSteps: number;
  totalTokens: number;
  /** Final answer from the model's `done` action, when the run reached one. */
  answer?: string;
  steps: StepTrace[];
}

export interface SepiaAgent {
  run: (goal: string) => Promise<RunTrace>;
}

// Default system prompt — tuned for large models (Claude, GPT-4, Gemini).
const SYSTEM_PROMPT_DEFAULT = `You are a browser automation agent. On each turn you receive the current page state as a compact outline where [e12] are interactive element handles. Respond with exactly one JSON action:
{"action":"click","handle":"e12"}
{"action":"type","handle":"e13","text":"hello@example.com"}
{"action":"open","url":"https://example.com"}
{"action":"done","summary":"Completed the task"}
Only use handles that appear in the current page. Never fabricate handles.`;

// Minimal system prompt — shorter and more schema-explicit for SLMs (≤ 7B).
// Includes a one-shot example to improve JSON output reliability.
const SYSTEM_PROMPT_MINIMAL = `Browser agent. Output ONE JSON action per turn. Schema:
{"action":"click","handle":"[eNN]"}
{"action":"type","handle":"[eNN]","text":"value"}
{"action":"open","url":"https://..."}
{"action":"done","summary":"..."}
Rules: use only handles shown on page; never invent handles; output raw JSON only.`;

function selectSystemPrompt(style: SepiaConfig['model']['promptStyle']): string {
  return style === 'minimal' ? SYSTEM_PROMPT_MINIMAL : SYSTEM_PROMPT_DEFAULT;
}

function formatNode(node: CompactNode, indent: number = 0): string {
  const prefix = '  '.repeat(indent);
  const handleStr = node.handle ? `[${node.handle}] ` : '';
  const stateStr = node.state
    ? ` (${[
        node.state.enabled === false ? 'disabled' : node.state.enabled ? 'enabled' : null,
        node.state.checked !== undefined ? (node.state.checked ? 'checked' : 'unchecked') : null,
        node.state.required ? 'required' : null,
        node.state.expanded !== undefined ? (node.state.expanded ? 'expanded' : 'collapsed') : null,
      ]
        .filter(Boolean)
        .join(', ')})`
    : '';
  const valueStr = node.value ? ` "${node.value}"` : '';
  return `${prefix}${handleStr}${node.role} "${node.name}"${valueStr}${stateStr}`;
}

function formatCompactView(view: CompactView): string {
  const lines: string[] = [];
  lines.push(`URL: ${view.url}`);
  lines.push(`Title: ${view.title}`);
  lines.push('');
  for (const node of view.nodes) {
    lines.push(formatNode(node, node.indent));
  }
  return lines.join('\n');
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Attempt to repair common SLM JSON formatting errors before giving up.
function repairJson(raw: string): string {
  return (
    raw
      .trim()
      // Strip markdown code fences
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      // Trailing commas before } or ]
      .replace(/,\s*([}\]])/g, '$1')
      .trim()
  );
}

// Sliding window: keep only the last N (user + assistant) pairs plus the system prompt.
function windowedMessages(
  history: OpenAI.Chat.ChatCompletionMessageParam[],
  maxHistorySteps: number,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  // history contains interleaved user/assistant pairs (no system prompt here).
  // Each step appends 2 messages, so keep last maxHistorySteps * 2.
  const maxMessages = maxHistorySteps * 2;
  return history.length > maxMessages ? history.slice(history.length - maxMessages) : history;
}

// Resolve token count: prefer API-reported value; fall back to local estimate.
function resolveTokens(
  apiTokens: number | undefined | null,
  inputText: string,
  outputText: string,
  mode: SepiaConfig['model']['tokenEstimation'] = 'auto',
): number {
  if (mode === 'api' || (mode === 'auto' && apiTokens != null && apiTokens > 0)) {
    return apiTokens ?? 0;
  }
  // 'local' or 'auto' with no API usage data → estimate
  return estimateTokens(inputText) + estimateTokens(outputText);
}

// Hard ceiling on any inter-attempt sleep. mergeConfig already bounds the
// configured value, but createAgent also accepts a hand-built SepiaConfig, so
// the sink clamps too rather than trusting its input
// (CodeQL js/resource-exhaustion).
const MAX_RETRY_BACKOFF_MS = 30_000;

// Agent factory
export function createAgent(config: SepiaConfig): SepiaAgent {
  return {
    async run(goal: string): Promise<RunTrace> {
      const runId = generateId();
      const sessionId = generateId();
      const startMs = Date.now();
      const steps: StepTrace[] = [];

      const logger = createLogger({
        enabled: config.privacy.telemetry,
        verbose: config.agent.verbosity !== 'minimal',
      });

      const auditor = createAuditor();

      const engineOpts: EngineOptions = {
        headless: config.browser.headless,
        confidenceThreshold: config.agent.confidenceThreshold,
        profile: config.browser.profile,
        ...(config.browser.settleTimeoutMs !== undefined
          ? { settleTimeoutMs: config.browser.settleTimeoutMs }
          : {}),
      };
      if (config.browser.executablePath !== undefined) {
        engineOpts.executablePath = config.browser.executablePath;
      }
      if (!config.browser.ephemeral && config.browser.profileStorePath !== undefined) {
        const profile = createNamedProfile(sessionId, config.browser.profileStorePath);
        engineOpts.profileDir = profile.profileDir;
      }
      if (config.security.rateLimitMs !== undefined || config.security.robotsAwareness) {
        engineOpts.security = {
          robotsAwareness: config.security.robotsAwareness,
          ...(config.security.rateLimitMs !== undefined
            ? { rateLimitMs: config.security.rateLimitMs }
            : {}),
        };
      }
      const engine = await createEngine(engineOpts);

      const client = new OpenAI({
        baseURL: config.model.endpoint,
        apiKey: config.model.apiKey ?? 'no-key',
      });

      const systemPrompt = selectSystemPrompt(config.model.promptStyle ?? 'default');
      let outcome: Outcome = 'error';
      let totalTokens = 0;
      let answer: string | undefined;

      // Conversation history (excludes system prompt; windowed before each call).
      const history: OpenAI.Chat.ChatCompletionMessageParam[] = [];

      try {
        for (let stepN = 0; stepN < config.agent.maxSteps; stepN++) {
          const stepStart = Date.now();

          // Observe current page state
          let view: CompactView;
          try {
            view = await engine.observe({ verbosity: config.agent.verbosity });
          } catch (err) {
            outcome = 'error';
            steps.push({
              stepN,
              action: 'observe',
              confidence: 0,
              tokensUsed: 0,
              latencyMs: Date.now() - stepStart,
              result: {
                ok: false,
                confidence: 0,
                error: { code: 'UNKNOWN', message: String(err) },
              },
              secretsRedacted: false,
            });
            break;
          }

          // Strip secret values, then sanitize, before any page content enters
          // the LLM context (AC-P5, SR-2).
          const rawPageContent = formatCompactView(redactCompactView(view));
          const { sanitized: safePageContent, injectionDetected } = sanitizeForLLM(rawPageContent);
          const userContent = `Goal: ${goal}\n\nCurrent page:\n${safePageContent}`;

          if (injectionDetected) {
            logger.step({
              timestamp: Date.now(),
              sessionId,
              runId,
              stepN,
              action: 'observe',
              confidence: 0,
              tokensUsed: 0,
              latencyMs: 0,
              ok: true,
              errorCode: 'PROMPT_INJECTION_DETECTED',
            });
          }

          const userMsg: OpenAI.Chat.ChatCompletionMessageParam = {
            role: 'user',
            content: userContent,
          };

          // Build windowed message list: system + last N history pairs + current user msg
          const contextMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
            ...windowedMessages(history, config.agent.maxHistorySteps ?? 10),
            userMsg,
          ];

          // Call the model, retrying with corrective feedback when the reply is
          // unparseable or fails validation (AC-AG8). Re-sending a byte-identical
          // request gives the model no reason to answer any differently, so each
          // retry states what was wrong with the previous attempt.
          let rawContent = '';
          let apiTokensUsed: number | null = null;
          let typedAction: TypedAction | undefined;
          let doneSummary: string | undefined;
          let sawDone = false;
          let rejection: string | undefined;
          let modelCallFailed = false;

          for (let attempt = 0; attempt <= config.agent.maxRetries; attempt++) {
            const attemptMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [...contextMessages];
            if (rejection !== undefined) {
              attemptMessages.push({ role: 'assistant', content: rawContent });
              attemptMessages.push({
                role: 'user',
                content:
                  `Your previous reply was rejected: ${rejection}. ` +
                  `Reply with exactly one valid JSON action object and nothing else.`,
              });
            }

            const callParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
              model: config.model.model,
              messages: attemptMessages,
              max_tokens: 1024,
            };
            if (config.model.jsonMode === true) {
              callParams.response_format = { type: 'json_object' };
            }

            let completion: OpenAI.Chat.ChatCompletion;
            try {
              completion = await client.chat.completions.create(callParams);
            } catch (err) {
              modelCallFailed = true;
              steps.push({
                stepN,
                action: 'model_call',
                confidence: 0,
                tokensUsed: 0,
                latencyMs: Date.now() - stepStart,
                result: {
                  ok: false,
                  confidence: 0,
                  error: { code: 'TIMEOUT', message: String(err) },
                },
                secretsRedacted: false,
              });
              break;
            }

            apiTokensUsed = completion.usage?.total_tokens ?? null;
            rawContent = completion.choices[0]?.message?.content ?? '';

            let parsedRaw: unknown;
            try {
              parsedRaw = JSON.parse(rawContent);
            } catch {
              const repaired = repairJson(rawContent);
              try {
                parsedRaw = JSON.parse(repaired);
                rawContent = repaired;
              } catch {
                rejection = 'the response was not valid JSON';
                if (attempt < config.agent.maxRetries) {
                  await new Promise<void>((r) =>
                    setTimeout(
                      r,
                      Math.min(MAX_RETRY_BACKOFF_MS, Math.max(0, config.agent.retryBackoffMs)),
                    ),
                  );
                }
                continue;
              }
            }

            // done action — its summary is the run's answer (AC-AG5)
            if (
              typeof parsedRaw === 'object' &&
              parsedRaw !== null &&
              (parsedRaw as Record<string, unknown>)['action'] === 'done'
            ) {
              const summary = (parsedRaw as Record<string, unknown>)['summary'];
              if (typeof summary === 'string' && summary.trim() !== '') {
                doneSummary = summary;
              }
              sawDone = true;
              break;
            }

            try {
              typedAction = parseAction(parsedRaw);
              rejection = undefined;
              break;
            } catch (err) {
              rejection = err instanceof Error ? err.message : String(err);
              if (attempt < config.agent.maxRetries) {
                await new Promise<void>((r) =>
                  setTimeout(
                    r,
                    Math.min(MAX_RETRY_BACKOFF_MS, Math.max(0, config.agent.retryBackoffMs)),
                  ),
                );
              }
            }
          }

          if (modelCallFailed) {
            outcome = 'error';
            break;
          }

          // Resolve token count — fall back to local estimate when API returns nothing
          const tokensUsed = resolveTokens(
            apiTokensUsed,
            contextMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(''),
            rawContent,
            config.model.tokenEstimation ?? 'auto',
          );
          totalTokens += tokensUsed;

          if (sawDone) {
            if (doneSummary !== undefined) answer = doneSummary;
            outcome = 'success';
            break;
          }

          // Retries exhausted without a valid action — record why, then stop.
          if (typedAction === undefined) {
            outcome = 'error';
            steps.push({
              stepN,
              action: 'model_call',
              confidence: 0,
              tokensUsed,
              latencyMs: Date.now() - stepStart,
              result: {
                ok: false,
                confidence: 0,
                error: {
                  code: 'INVALID_ACTION',
                  message: rejection ?? 'model produced no valid action',
                },
              },
              secretsRedacted: false,
            });
            break;
          }

          // Dispatch action with stale handle retry
          let result: Awaited<ReturnType<typeof dispatch>>;
          let confidence = 1;
          let secretsRedacted = false;
          let retries = 0;

          // A handle the engine refused to act on — stale, or resolved below the
          // confidence threshold. Re-observing may settle the page, so retry a
          // bounded number of times, then bail rather than guessing (AC-AG7).
          const isUnresolvable = (r: unknown): boolean => {
            const code = (r as ActionResult).error?.code;
            return code === 'STALE_HANDLE' || code === 'LOW_CONFIDENCE';
          };

          while (true) {
            try {
              result = await dispatch(typedAction, engine);
            } catch (err) {
              result = {
                ok: false,
                confidence: 0,
                error: { code: 'UNKNOWN', message: String(err) },
              };
            }

            if (isUnresolvable(result) && retries < config.agent.maxRetries) {
              retries++;
              try {
                view = await engine.observe({ verbosity: config.agent.verbosity });
              } catch {
                break;
              }
              await new Promise<void>((r) =>
                setTimeout(
                  r,
                  Math.min(MAX_RETRY_BACKOFF_MS, Math.max(0, config.agent.retryBackoffMs)),
                ),
              );
              continue;
            }
            break;
          }

          const bailedOnHandle = isUnresolvable(result);

          if ('confidence' in result) {
            confidence = (result as ActionResult).confidence;
          }

          if (typedAction.text) {
            const redacted = redactSecrets(typedAction.text);
            secretsRedacted = redacted.count > 0;
          }

          const latencyMs = Date.now() - stepStart;

          const stepTrace: StepTrace = {
            stepN,
            action: typedAction.action,
            confidence,
            tokensUsed,
            latencyMs,
            result: result as ActionResult,
            secretsRedacted,
          };
          if (typedAction.handle !== undefined) {
            stepTrace.handle = typedAction.handle;
          }
          steps.push(stepTrace);

          const stepEvent: Parameters<typeof logger.step>[0] = {
            timestamp: Date.now(),
            sessionId,
            runId,
            stepN,
            action: typedAction.action,
            confidence,
            tokensUsed,
            latencyMs,
            ok: (result as ActionResult).ok ?? true,
          };
          if (typedAction.handle !== undefined) stepEvent.handle = typedAction.handle;
          const errCode = (result as ActionResult).error?.code;
          if (errCode !== undefined) stepEvent.errorCode = errCode;
          logger.step(stepEvent);

          // Retries exhausted against an unresolvable handle: stop and report
          // rather than continuing to act on an ambiguous page (AC-AG7).
          if (bailedOnHandle) {
            outcome = 'stale_bail';
            break;
          }

          // Append to windowed history
          history.push(userMsg);
          history.push({ role: 'assistant', content: rawContent });

          auditor.record({
            destination: config.model.endpoint,
            byteCount: userContent.length,
            fields: ['goal', 'pageContent'],
            timestampMs: Date.now(),
          });

          if (totalTokens >= config.agent.maxTokensPerRun) {
            outcome = 'budget_exceeded';
            break;
          }
        }

        if (outcome === 'error' && steps.length >= config.agent.maxSteps) {
          outcome = 'budget_exceeded';
        }
      } finally {
        await engine.close();
      }

      return {
        runId,
        goal,
        sessionId,
        startMs,
        endMs: Date.now(),
        outcome,
        totalSteps: steps.length,
        totalTokens,
        ...(answer !== undefined ? { answer } : {}),
        steps,
      };
    },
  };
}
