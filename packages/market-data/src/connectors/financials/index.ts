/**
 * Financials connectors barrel.
 *
 * Phase 1: SEC EDGAR XBRL (US).
 * Phase 2: Eastmoney datacenter-web (CN A-share).
 * Phase 3: Eastmoney datacenter HK F10 (港股, RPT_HKF10_FN_MAININDICATOR wide report).
 */
export {
  createSecEdgarXbrlFinancialsConnector,
  type SecEdgarXbrlOptions,
} from './sec-edgar-xbrl';
export {
  createSecEdgarXbrlV2FinancialsConnector,
  type SecEdgarXbrlV2Options,
} from './sec-edgar-xbrl-v2';
export {
  createEastmoneyFinancialsConnector,
  type EastmoneyFinancialsOptions,
} from './eastmoney';
export {
  createEastmoneyV2FinancialsConnector,
  type EastmoneyV2Options,
} from './eastmoney-v2';
export {
  createEastmoneyHkFinancialsConnector,
  type EastmoneyHkFinancialsOptions,
} from './eastmoney-hk';
export {
  createEastmoneyHkV2FinancialsConnector,
  type EastmoneyHkV2Options,
} from './eastmoney-hk-v2';
export {
  createHkexDerivedFinancialsConnector,
  type HkexDerivedFinancialsOptions,
} from './hkex-derived';
