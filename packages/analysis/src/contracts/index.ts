// Analysis contracts barrel. Package boundary (KISS C4): market-data types
// are NOT re-exported here — consumers import @bourse/market-data directly.
export * from './enums';
export * from './citation';
export * from './trace';
export * from './analysis-request';
export * from './analysis-result';
export * from './comprehensive-summary';
export * from './evidence-pack-v2';
export * from './sse-events';

// Daily Brief (docs/prd-daily-brief.md) — 定时行情简报契约
export * from './brief-payload';
export * from './earnings';
export * from './investor-relations';
