# LiteLLM integration guide

LiteLLM is an optional proxy layer that sits between Sepia and your model providers. It gives you a single OpenAI-compatible endpoint that can route to 100+ providers, with cost tracking, fallbacks, and rate limiting — all transparent to Sepia.

```
Sepia  →  LiteLLM proxy (:4000)  →  Anthropic / OpenAI / Ollama / Groq / …
```

Sepia requires zero code changes to use LiteLLM. You point `SEPIA_MODEL_ENDPOINT` at the proxy and use the LiteLLM model name format.

---

## When to use LiteLLM

| Need | Without LiteLLM | With LiteLLM |
|---|---|---|
| Switch between Anthropic and Ollama | Change env vars and restart | Change one config line in LiteLLM |
| Cost tracking across providers | Not available | Built-in spend dashboard |
| Fallback: if Claude fails → use local Llama | Manual retry logic | `model_list` fallback chain |
| Rate limiting across teams | Not available | Per-key rate limits |
| Load balance across Ollama replicas | Not available | Round-robin routing |
| A/B testing two models | Two Sepia instances | One Sepia instance, LiteLLM router |

---

## Quickstart — local dev

**Prerequisites:** Docker (for the proxy), Ollama (optional, for local models).

```bash
# 1. Start LiteLLM proxy with a minimal config
make litellm-start

# 2. Point Sepia at it
export SEPIA_MODEL_ENDPOINT=http://localhost:4000/v1
export SEPIA_MODEL=anthropic/claude-sonnet-4-6
export SEPIA_API_KEY=sk-ant-...

make run ARGS='run "What is the Node.js LTS version?"'
```

`make litellm-start` runs the official LiteLLM Docker image with the config at `config/litellm.yaml`.

---

## Config file — `config/litellm.yaml`

```yaml
model_list:
  # Anthropic (primary)
  - model_name: anthropic/claude-sonnet-4-6
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY

  # OpenAI
  - model_name: openai/gpt-4o
    litellm_params:
      model: gpt-4o
      api_key: os.environ/OPENAI_API_KEY

  # Ollama — local Hermes (no key needed)
  - model_name: ollama/nous-hermes2
    litellm_params:
      model: ollama/nous-hermes2
      api_base: http://host.docker.internal:11434

  # Ollama — local Llama 3.1 8B
  - model_name: ollama/llama3.1
    litellm_params:
      model: ollama/llama3.1
      api_base: http://host.docker.internal:11434

  # Groq — fast inference
  - model_name: groq/llama-3.1-70b-versatile
    litellm_params:
      model: groq/llama-3.1-70b-versatile
      api_key: os.environ/GROQ_API_KEY

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY   # set any string; used as the proxy API key

litellm_settings:
  drop_params: true   # silently drop unsupported params (e.g. json_mode on Ollama)
  request_timeout: 60
```

---

## Fallback chains

Configure automatic fallback when a primary model fails or rate-limits:

```yaml
router_settings:
  routing_strategy: simple-shuffle
  fallbacks:
    - anthropic/claude-sonnet-4-6:
        - ollama/nous-hermes2
        - groq/llama-3.1-70b-versatile
```

With this config Sepia always uses `SEPIA_MODEL=anthropic/claude-sonnet-4-6`. If that call fails (rate limit, timeout, outage), LiteLLM automatically retries with `nous-hermes2` and then `groq/llama-3.1-70b-versatile` — all transparent to Sepia.

---

## Model names for Sepia

When routing through LiteLLM, set `SEPIA_MODEL` to the LiteLLM model name:

| Provider | `SEPIA_MODEL` |
|---|---|
| Anthropic Claude Sonnet | `anthropic/claude-sonnet-4-6` |
| OpenAI GPT-4o | `openai/gpt-4o` |
| Ollama Hermes 2 | `ollama/nous-hermes2` |
| Ollama LLaMA 3.1 8B | `ollama/llama3.1` |
| Groq LLaMA 3.1 70B | `groq/llama-3.1-70b-versatile` |
| Together AI Mixtral | `together_ai/mistralai/Mixtral-8x7B-Instruct-v0.1` |

---

## JSON mode and SLM reliability

For small models that don't reliably output JSON, enable Sepia's built-in JSON mode:

```bash
# In Sepia config — adds response_format: {type: "json_object"} to model calls
SEPIA_JSON_MODE=true   # (or set model.jsonMode: true in SepiaConfig)
```

Also set `drop_params: true` in `litellm.yaml` so LiteLLM silently drops `response_format` for models that don't support it (e.g. Ollama without the `--json` flag).

For SLMs also set the minimal prompt style:

```bash
SEPIA_PROMPT_STYLE=minimal   # shorter, more schema-explicit prompt for ≤ 7B models
```

---

## Cost tracking

LiteLLM exposes a spend dashboard at `http://localhost:4000/ui`. It tracks:
- Cost per request, per model, per API key
- Token usage over time
- Request latency p50/p95/p99

No setup required beyond `master_key` in the config.

---

## Kubernetes sidecar (Helm)

The Sepia Helm chart supports LiteLLM as an optional sidecar container. Enable it in `values.yaml`:

```yaml
litellm:
  enabled: true
  image: ghcr.io/berriai/litellm:main-latest
  port: 4000
  configSecret: litellm-config   # kubectl secret with litellm.yaml key
```

When enabled, the sidecar runs in the same pod as Sepia. Sepia's `SEPIA_MODEL_ENDPOINT` is automatically set to `http://localhost:4000/v1` and `SEPIA_MODEL` to the value of `litellm.defaultModel`.

Create the config secret:

```bash
kubectl create secret generic litellm-config \
  --namespace sepia \
  --from-file=litellm.yaml=config/litellm.yaml
```

---

## Load balancing across Ollama replicas

To run multiple Ollama instances and load-balance across them:

```yaml
model_list:
  - model_name: ollama/llama3.1
    litellm_params:
      model: ollama/llama3.1
      api_base: http://ollama-0:11434
  - model_name: ollama/llama3.1
    litellm_params:
      model: ollama/llama3.1
      api_base: http://ollama-1:11434
  - model_name: ollama/llama3.1
    litellm_params:
      model: ollama/llama3.1
      api_base: http://ollama-2:11434

router_settings:
  routing_strategy: least-busy
```

LiteLLM routes to whichever replica has the lowest active request count.

---

## Further reading

- [LiteLLM docs](https://docs.litellm.ai)
- [Supported providers](https://docs.litellm.ai/docs/providers)
- [Router and fallbacks](https://docs.litellm.ai/docs/routing)
- [Spend tracking](https://docs.litellm.ai/docs/proxy/cost_tracking)
