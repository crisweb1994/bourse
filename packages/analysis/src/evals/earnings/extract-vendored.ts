/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';
import { EarningsExtractionSchema } from '../../contracts/earnings';
import {
  EARNINGS_EXTRACTION_PROMPT_VERSION,
  EARNINGS_EXTRACTION_SYSTEM_PROMPT,
  EARNINGS_MAX_OUTPUT_TOKENS,
  EARNINGS_SCHEMA_VERSION,
  buildEarningsExtractionUserPrompt,
} from '../../prompts/earnings';
import { ClaudeProvider, OpenAIProvider } from '../../primitives/provider';
import { structuredOutputWithRepair } from '../../primitives/structured-output';
import {
  assertEarningsEvalComposition,
  EarningsEvalManifestSchema,
  selectEarningsEvalSamples,
  type EarningsEvalSplit,
} from './manifest';

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, '../../../../..');

const VendoredDocumentSchema = z.object({
  summary: z.object({
    instrumentId: z.string(),
    formType: z.string(),
    filingDate: z.string(),
    title: z.string().optional(),
    sourceDocumentId: z.string(),
  }),
  document: z.object({
    contentHash: z.string().min(32),
    text: z.string().min(1),
    pages: z.array(z.unknown()).optional(),
  }),
});

interface Args {
  manifest: string;
  vendorDir: string;
  outDir: string;
  only?: string[];
  split: EarningsEvalSplit;
  force: boolean;
  timeoutMs: number;
  retries: number;
  failFast: boolean;
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseArgs(process.argv.slice(2));
  const manifest = EarningsEvalManifestSchema.parse(JSON.parse(readFileSync(args.manifest, 'utf8')));
  assertEarningsEvalComposition(manifest);
  const provider = buildProvider();
  mkdirSync(args.outDir, { recursive: true });
  const selected = selectEarningsEvalSamples(manifest, args.split, args.only);
  console.log(
    `extracting ${selected.length} ${args.split} sample(s) with ${provider.getUtilityModel()}`,
  );
  const failures: Array<{ sampleId: string; message: string }> = [];

  for (const sample of selected) {
    const outputPath = join(args.outDir, `${sample.id}.json`);
    try {
      const vendored = VendoredDocumentSchema.parse(
        JSON.parse(readFileSync(join(args.vendorDir, sample.vendorFile), 'utf8')),
      );
      if (vendored.summary.instrumentId !== `${sample.market}:${sample.symbol}`) {
        throw new Error(`${sample.id}: manifest instrument does not match vendored document`);
      }
      if (!args.force && isReusableSnapshot(
        outputPath,
        vendored.document.contentHash,
        provider.getUtilityModel(),
      )) {
        console.log(`skip ${sample.id}: candidate snapshot is current`);
        continue;
      }
      const result = await withRetry(
        () => structuredOutputWithRepair(
          provider,
          EARNINGS_EXTRACTION_SYSTEM_PROMPT,
          buildEarningsExtractionUserPrompt(
            {
              formType: vendored.summary.formType,
              title: vendored.summary.title,
              publishedAt: vendored.summary.filingDate,
              normalizedText: vendored.document.text,
              pages: vendored.document.pages,
            },
            {
              symbol: sample.symbol,
              market: sample.market,
              name: vendored.summary.title ?? sample.symbol,
            },
          ),
          EarningsExtractionSchema,
          {
            maxTokens: EARNINGS_MAX_OUTPUT_TOKENS,
            signal: AbortSignal.timeout(args.timeoutMs),
          },
        ),
        args.retries,
        sample.id,
      );
      const payload = {
        schemaVersion: 'earnings-eval-candidate-v1',
        sampleId: sample.id,
        sourceDocumentId: vendored.summary.sourceDocumentId,
        sourceContentHash: vendored.document.contentHash,
        promptVersion: EARNINGS_EXTRACTION_PROMPT_VERSION,
        extractionSchemaVersion: EARNINGS_SCHEMA_VERSION,
        model: result.model ?? provider.getUtilityModel(),
        llmCalls: result.llmCalls,
        usage: result.usage,
        generatedAt: new Date().toISOString(),
        extraction: result.data,
      };
      const temporary = `${outputPath}.tmp`;
      writeFileSync(temporary, JSON.stringify(payload, null, 2));
      renameSync(temporary, outputPath);
      console.log(`${sample.id}: ${result.data.facts.length} candidates -> ${outputPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ sampleId: sample.id, message });
      console.error(`${sample.id}: extraction failed: ${message}`);
      if (args.failFast) throw error;
    }
  }
  if (failures.length > 0) {
    throw new Error(`earnings extraction failed for ${failures.map((failure) => failure.sampleId).join(', ')}`);
  }
}

function loadRootEnv(): void {
  const path = join(REPO_ROOT, '.env');
  if (existsSync(path)) loadEnvFile(path);
}

function buildProvider() {
  const name = (process.env.AI_PROVIDER || 'openai').toLowerCase();
  if (name === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for earnings eval extraction');
    return new OpenAIProvider({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
      model: process.env.OPENAI_MODEL?.trim() || undefined,
      utilityModel: process.env.OPENAI_UTILITY_MODEL?.trim() || undefined,
    });
  }
  if (name === 'claude' || name === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for earnings eval extraction');
    return new ClaudeProvider({
      apiKey,
      baseUrl: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
      model: process.env.ANTHROPIC_MODEL?.trim() || undefined,
      utilityModel: process.env.ANTHROPIC_UTILITY_MODEL?.trim() || undefined,
    });
  }
  throw new Error(`unsupported AI_PROVIDER for earnings eval: ${name}`);
}

function isReusableSnapshot(
  outputPath: string,
  contentHash: string,
  model: string,
): boolean {
  if (!existsSync(outputPath)) return false;
  try {
    const snapshot = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
    return snapshot.sourceContentHash === contentHash
      && snapshot.promptVersion === EARNINGS_EXTRACTION_PROMPT_VERSION
      && snapshot.extractionSchemaVersion === EARNINGS_SCHEMA_VERSION
      && snapshot.model === model;
  } catch {
    return false;
  }
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let force = false;
  let failFast = false;
  const normalized = argv.filter((value) => value !== '--');
  for (let index = 0; index < normalized.length; index += 1) {
    const key = normalized[index];
    if (key === '--force') {
      force = true;
      continue;
    }
    if (key === '--fail-fast') {
      failFast = true;
      continue;
    }
    const value = normalized[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid argument near ${key ?? '<end>'}`);
    }
    values.set(key, value);
    index += 1;
  }
  const timeoutMs = Number(values.get('--timeout-ms') || 180_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error('--timeout-ms must be an integer between 1000 and 600000');
  }
  const retries = Number(values.get('--retries') || 2);
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) {
    throw new Error('--retries must be an integer between 0 and 5');
  }
  const split = values.get('--split') || 'development';
  if (!['all', 'development', 'blind'].includes(split)) {
    throw new Error('--split must be one of all, development, or blind');
  }
  return {
    manifest: resolve(values.get('--manifest') || join(HERE, 'fixtures/sample-manifest.json')),
    vendorDir: resolve(values.get('--vendor-dir') || '/tmp/bourse-earnings-eval'),
    outDir: resolve(values.get('--out') || '/tmp/bourse-earnings-eval-candidates'),
    ...(values.get('--only')
      ? { only: values.get('--only')!.split(',').map((value) => value.trim()).filter(Boolean) }
      : {}),
    split: split as EarningsEvalSplit,
    force,
    timeoutMs,
    retries,
    failFast,
  };
}

async function withRetry<T>(
  operation: () => Promise<T>,
  retries: number,
  sampleId: string,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isRetryableProviderError(error)) throw error;
      const delayMs = 500 * 2 ** attempt;
      console.warn(`${sampleId}: provider temporarily unavailable; retry ${attempt + 1}/${retries}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
}

function isRetryableProviderError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && (status === 429 || status >= 500)) return true;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/.test(code)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:429|5\d\d)\b|temporarily unavailable|rate limit|timed?\s*out|connection (?:reset|refused)/i.test(message);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
