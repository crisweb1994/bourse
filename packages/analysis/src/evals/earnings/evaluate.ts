/* eslint-disable no-console */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { EarningsExtractionSchema } from '../../contracts/earnings';
import { locateSourceSpan } from '../../compute/earnings-verify';
import {
  EARNINGS_EXTRACTION_PROMPT_VERSION,
  EARNINGS_SCHEMA_VERSION,
} from '../../prompts/earnings';
import {
  assertEarningsEvalComposition,
  EarningsEvalManifestSchema,
  selectEarningsEvalSamples,
} from './manifest';
import { runEarningsEval } from './runner';
import { EarningsEvalGoldFactSchema } from './types';

const GoldSetSchema = z.object({
  schemaVersion: z.literal('earnings-eval-gold-v1'),
  policy: z.string().min(1),
  reviewedAt: z.string().datetime(),
  samples: z.array(z.object({
    sampleId: z.string().min(1),
    event: z.object({
      periodEndOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reportingScope: z.enum(['consolidated', 'parent', 'unknown']),
    }),
    goldFacts: z.array(EarningsEvalGoldFactSchema).min(1),
  })),
});

const VendoredDocumentSchema = z.object({
  summary: z.object({
    instrumentId: z.string(),
    formType: z.string(),
    sourceDocumentId: z.string(),
  }),
  document: z.object({
    contentHash: z.string().min(32),
    text: z.string().min(1),
    pages: z.array(z.object({
      page: z.number().int().positive(),
      startOffset: z.number().int().nonnegative(),
      endOffset: z.number().int().positive(),
    })).optional(),
  }),
});

const CandidateSnapshotSchema = z.object({
  schemaVersion: z.literal('earnings-eval-candidate-v1'),
  sampleId: z.string(),
  sourceDocumentId: z.string(),
  sourceContentHash: z.string().min(32),
  promptVersion: z.string(),
  extractionSchemaVersion: z.string(),
  model: z.string(),
  extraction: EarningsExtractionSchema,
});

interface Args {
  manifest: string;
  gold: string;
  vendorDir: string;
  candidateDir: string;
  output?: string;
  enforceGate: boolean;
  split: 'all' | 'development' | 'blind';
  only?: string[];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const manifest = EarningsEvalManifestSchema.parse(readJson(args.manifest));
  assertEarningsEvalComposition(manifest);
  const gold = GoldSetSchema.parse(readJson(args.gold));
  const goldBySample = new Map(gold.samples.map((sample) => [sample.sampleId, sample]));
  assertExactSampleSet(manifest.samples.map((sample) => sample.id), [...goldBySample.keys()], 'gold');

  for (const sample of manifest.samples) {
    const vendored = VendoredDocumentSchema.parse(readJson(join(args.vendorDir, sample.vendorFile)));
    const sampleGold = goldBySample.get(sample.id);
    if (!sampleGold) throw new Error(`${sample.id}: missing gold sample`);
    for (const fact of sampleGold.goldFacts) {
      const located = locateSourceSpan(
        vendored.document.text,
        fact.sourceQuote,
        fact.sourcePage,
        vendored.document.pages,
      );
      if (!located) {
        throw new Error(`${sample.id}/${fact.metricCode}: gold sourceQuote is not uniquely anchored`);
      }
    }
  }

  const selectedSamples = selectEarningsEvalSamples(manifest, args.split, args.only);
  const evaluatedModels = new Set<string>();
  const fixtures = selectedSamples.map((sample) => {
    const vendored = VendoredDocumentSchema.parse(readJson(join(args.vendorDir, sample.vendorFile)));
    const candidatePath = join(args.candidateDir, `${sample.id}.json`);
    if (!existsSync(candidatePath)) throw new Error(`${sample.id}: missing candidate snapshot`);
    const candidate = CandidateSnapshotSchema.parse(readJson(candidatePath));
    const sampleGold = goldBySample.get(sample.id);
    if (!sampleGold) throw new Error(`${sample.id}: missing gold sample`);
    if (candidate.sampleId !== sample.id) throw new Error(`${sample.id}: candidate id mismatch`);
    if (candidate.sourceContentHash !== vendored.document.contentHash) {
      throw new Error(`${sample.id}: candidate was generated from a different document hash`);
    }
    if (candidate.sourceDocumentId !== vendored.summary.sourceDocumentId) {
      throw new Error(`${sample.id}: candidate sourceDocumentId mismatch`);
    }
    if (candidate.promptVersion !== EARNINGS_EXTRACTION_PROMPT_VERSION) {
      throw new Error(
        `${sample.id}: candidate prompt ${candidate.promptVersion} is stale; expected ${EARNINGS_EXTRACTION_PROMPT_VERSION}`,
      );
    }
    if (candidate.extractionSchemaVersion !== EARNINGS_SCHEMA_VERSION) {
      throw new Error(
        `${sample.id}: candidate schema ${candidate.extractionSchemaVersion} is stale; expected ${EARNINGS_SCHEMA_VERSION}`,
      );
    }
    evaluatedModels.add(candidate.model);
    return {
      meta: {
        id: sample.id,
        market: sample.market,
        split: sample.split,
        formType: sample.formType,
        description: sample.correction ? 'correction sample' : undefined,
      },
      derivation: {
        id: `eval:${sample.id}:${candidate.promptVersion}`,
        filingId: `eval:${vendored.summary.sourceDocumentId}`,
        contentHash: vendored.document.contentHash,
        text: vendored.document.text,
        pages: vendored.document.pages,
      },
      event: {
        ...sampleGold.event,
        periodType: candidate.extraction.periodType,
      },
      candidates: candidate.extraction.facts,
      goldFacts: sampleGold.goldFacts,
    };
  });
  if (evaluatedModels.size !== 1) {
    throw new Error(`candidate snapshots use mixed models: ${[...evaluatedModels].sort().join(', ')}`);
  }

  const result = runEarningsEval(fixtures);
  const report = {
    schemaVersion: 'earnings-eval-report-v1',
    generatedAt: new Date().toISOString(),
    manifest: args.manifest,
    gold: args.gold,
    goldPolicy: gold.policy,
    evaluatedSplit: args.split,
    evaluatedSampleIds: selectedSamples.map((sample) => sample.id),
    evaluatedModel: [...evaluatedModels][0],
    result,
  };
  if (args.output) writeFileSync(args.output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (args.enforceGate && !result.gate.passed) process.exitCode = 1;
}

function assertExactSampleSet(expected: string[], actual: string[], label: string): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((id) => !actualSet.has(id));
  const extra = actual.filter((id) => !expectedSet.has(id));
  if (missing.length || extra.length || actualSet.size !== actual.length) {
    throw new Error(`${label} sample set mismatch; missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`);
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  let enforceGate = true;
  const normalized = argv.filter((value) => value !== '--');
  for (let index = 0; index < normalized.length; index += 1) {
    const key = normalized[index];
    if (key === '--no-gate') {
      enforceGate = false;
      continue;
    }
    const value = normalized[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid argument near ${key ?? '<end>'}`);
    }
    values.set(key, value);
    index += 1;
  }
  const split = values.get('--split') || 'all';
  if (!['all', 'development', 'blind'].includes(split)) {
    throw new Error('--split must be one of all, development, or blind');
  }
  if (split === 'development' && enforceGate) {
    throw new Error('--split development requires --no-gate because the release gate is blind-only');
  }
  const only = values.get('--only')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (only?.length && enforceGate) {
    throw new Error('--only requires --no-gate because a subset cannot prove the release gate');
  }
  return {
    manifest: resolve(values.get('--manifest') || join(__dirname, 'fixtures/sample-manifest.json')),
    gold: resolve(values.get('--gold') || join(__dirname, 'fixtures/gold-v1.json')),
    vendorDir: resolve(values.get('--vendor-dir') || '/tmp/bourse-earnings-eval'),
    candidateDir: resolve(values.get('--candidate-dir') || '/tmp/bourse-earnings-eval-candidates'),
    ...(values.get('--out') ? { output: resolve(values.get('--out')!) } : {}),
    enforceGate,
    split: split as Args['split'],
    ...(only?.length ? { only } : {}),
  };
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
