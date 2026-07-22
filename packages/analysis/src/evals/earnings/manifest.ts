import { z } from 'zod';

export const EarningsEvalSampleSchema = z.object({
  id: z.string().min(1),
  market: z.enum(['US', 'CN']),
  symbol: z.string().min(1),
  formType: z.string().min(1),
  split: z.enum(['development', 'blind']),
  vendorFile: z.string().min(1),
  sizeTier: z.enum(['large', 'mid', 'small']).optional(),
  correction: z.boolean().default(false),
});

export const EarningsEvalManifestSchema = z.object({
  schemaVersion: z.literal('earnings-eval-manifest-v1'),
  samples: z.array(EarningsEvalSampleSchema),
});

export type EarningsEvalSample = z.infer<typeof EarningsEvalSampleSchema>;
export type EarningsEvalManifest = z.infer<typeof EarningsEvalManifestSchema>;
export type EarningsEvalSplit = EarningsEvalSample['split'] | 'all';

export function selectEarningsEvalSamples(
  manifest: EarningsEvalManifest,
  split: EarningsEvalSplit,
  only?: readonly string[],
): EarningsEvalSample[] {
  if (only?.length) {
    const samplesById = new Map(manifest.samples.map((sample) => [sample.id, sample]));
    const unknown = only.filter((id) => !samplesById.has(id));
    if (unknown.length > 0) {
      throw new Error(`unknown earnings eval sample(s): ${unknown.join(', ')}`);
    }
    if (split !== 'all') {
      const outsideSplit = only.filter((id) => samplesById.get(id)?.split !== split);
      if (outsideSplit.length > 0) {
        throw new Error(
          `earnings eval sample(s) do not belong to the ${split} split: ${outsideSplit.join(', ')}`,
        );
      }
    }
  }

  const requested = only?.length ? new Set(only) : undefined;
  const selected = manifest.samples.filter((sample) => (
    (split === 'all' || sample.split === split)
    && (!requested || requested.has(sample.id))
  ));
  if (selected.length === 0) {
    throw new Error(`no manifest sample matched split=${split}`);
  }
  return selected;
}

export function assertEarningsEvalComposition(manifest: EarningsEvalManifest): void {
  const issues: string[] = [];
  const cn = manifest.samples.filter((sample) => sample.market === 'CN');
  const us = manifest.samples.filter((sample) => sample.market === 'US');
  if (cn.length < 10) issues.push(`expected at least 10 CN samples, received ${cn.length}`);
  if (us.length < 5) issues.push(`expected at least 5 US samples, received ${us.length}`);
  if (us.some((sample) => sample.formType.toUpperCase() !== '8-K')) {
    issues.push('all US Phase 0 samples must be 8-K earnings releases');
  }
  const tiers = new Set(cn.map((sample) => sample.sizeTier));
  for (const tier of ['large', 'mid', 'small'] as const) {
    if (!tiers.has(tier)) issues.push(`CN samples are missing size tier: ${tier}`);
  }
  if (!cn.some((sample) => sample.correction)) issues.push('CN samples must include a correction');
  if (!manifest.samples.some((sample) => sample.split === 'development')) {
    issues.push('manifest has no development samples');
  }
  if (!manifest.samples.some((sample) => sample.split === 'blind')) {
    issues.push('manifest has no blind samples');
  }
  const ids = manifest.samples.map((sample) => sample.id);
  if (new Set(ids).size !== ids.length) issues.push('sample ids must be unique');
  const files = manifest.samples.map((sample) => sample.vendorFile);
  if (new Set(files).size !== files.length) issues.push('vendor files must be unique');
  if (issues.length > 0) throw new Error(`invalid earnings eval manifest: ${issues.join('; ')}`);
}
