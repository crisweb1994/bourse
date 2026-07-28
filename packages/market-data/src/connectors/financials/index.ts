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
  createEastmoneyFinancialsConnector,
  type EastmoneyFinancialsOptions,
} from './eastmoney';
export {
  createEastmoneyHkFinancialsConnector,
  type EastmoneyHkFinancialsOptions,
} from './eastmoney-hk';
