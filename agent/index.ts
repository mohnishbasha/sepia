import OpenAI from 'openai';
import { createEngine } from '../engine/index.js';
import type { EngineOptions } from '../engine/index.js';
import { parseAction, dispatch } from '../actions/index.js';
import { createAuditor, redactSecrets, sanitizeForLLM } from '../privacy/index.js';
import { createLogger } from '../telemetry/index.js';
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
  steps: StepTrace[];
}

export interface SepiaAgent {
  run: (goal: string) => Promise<RunTrace>;
}

const SYSTEM_PROMPT = `You are a browser automation agent. On each turn you receive the current page state as a compact outline where [e12] are interactive element handles. Respond with exactly one JSON action:
{"action":"click","handle":"e12"}
{"action":"type","handle":"e13","text":"hello@example.com"}
{"action":"open","url":"https://example.com"}
{"action":"done","summary":"Completed the task"}
Only use handles that appear in the current page. Never fabricate handles.`;

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

// Agent factory — Phase 2 M3
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
      };
      if (config.browser.executablePath !== undefined) {
        engineOpts.executablePath = config.browser.executablePath;
      }
      const engine = await createEngine(engineOpts);

      const client = new OpenAI({
        baseURL: config.model.endpoint,
        apiKey: config.model.apiKey ?? 'no-key',
      });

      let outcome: Outcome = 'error';
      let totalTokens = 0;

      try {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: 'system', content: SYSTEM_PROMPT },
        ];

        for (let stepN = 0; stepN < config.agent.maxSteps; stepN++) {
          const stepStart = Date.now();

          // Observe current page state
          let view: CompactView;
          try {
            view = await engine.observe({ verbosity: config.agent.verbosity });
          } catch (err) {
            outcome = 'error';
            const errTrace: StepTrace = {
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
            };
            steps.push(errTrace);
            break;
          }

          // Build user message
          // Format and sanitize page content before inserting into LLM context (SR-2)
          const rawPageContent = formatCompactView(view);
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

          // Call model
          let completion: OpenAI.Chat.ChatCompletion;
          try {
            completion = await client.chat.completions.create({
              model: config.model.model,
              messages: [...messages, userMsg],
              max_tokens: 1024,
            });
          } catch (err) {
            outcome = 'error';
            const errTrace: StepTrace = {
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
            };
            steps.push(errTrace);
            break;
          }

          const tokensUsed = completion.usage?.total_tokens ?? 0;
          totalTokens += tokensUsed;

          const rawContent = completion.choices[0]?.message?.content ?? '';

          // Check if model indicates done
          let parsedRaw: unknown;
          try {
            parsedRaw = JSON.parse(rawContent);
          } catch {
            // Not valid JSON — treat as error
            outcome = 'error';
            break;
          }

          // Check for done action (not in ACTION_NAMES, handled specially)
          if (
            typeof parsedRaw === 'object' &&
            parsedRaw !== null &&
            (parsedRaw as Record<string, unknown>)['action'] === 'done'
          ) {
            outcome = 'success';
            break;
          }

          // Parse as typed action
          let typedAction: ReturnType<typeof parseAction>;
          try {
            typedAction = parseAction(parsedRaw);
          } catch {
            // Invalid action — reject and break
            outcome = 'error';
            break;
          }

          // Dispatch action with stale handle retry
          let result: Awaited<ReturnType<typeof dispatch>>;
          let confidence = 1;
          let secretsRedacted = false;
          let retries = 0;

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

            // Check for stale handle
            const actionResult = result as ActionResult;
            if (
              actionResult.error?.code === 'STALE_HANDLE' &&
              retries < config.agent.maxRetries
            ) {
              retries++;
              // Re-observe and update handle map
              try {
                view = await engine.observe({ verbosity: config.agent.verbosity });
              } catch {
                break;
              }
              // Small backoff
              await new Promise<void>((r) => setTimeout(r, config.agent.retryBackoffMs));
              continue;
            }
            break;
          }

          // Extract confidence from result
          if ('confidence' in result) {
            confidence = (result as ActionResult).confidence;
          }

          // Check for secrets in action text
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

          // Log step
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
          if (typedAction.handle !== undefined) {
            stepEvent.handle = typedAction.handle;
          }
          const errCode = (result as ActionResult).error?.code;
          if (errCode !== undefined) {
            stepEvent.errorCode = errCode;
          }
          logger.step(stepEvent);

          // Append to conversation
          messages.push(userMsg);
          messages.push({
            role: 'assistant',
            content: rawContent,
          });

          // Audit outbound
          auditor.record({
            destination: config.model.endpoint,
            byteCount: userContent.length,
            fields: ['goal', 'pageContent'],
            timestampMs: Date.now(),
          });

          // Budget check — check total tokens
          if (totalTokens >= config.agent.maxTokensPerRun) {
            outcome = 'budget_exceeded';
            break;
          }
        }

        // If we never set outcome to success/budget_exceeded/error after loop, it's budget_exceeded
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
        steps,
      };
    },
  };
}
