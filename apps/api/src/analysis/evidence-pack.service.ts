import { Injectable, Logger } from '@nestjs/common';
import type { EvidencePackV2 } from '@bourse/analysis';
import { SnapshotV2Service } from './snapshot-v2.service';

interface AnalysisForEvidencePack {
  id: string;
  stock: {
    symbol: string;
    market: string;
  };
}

export interface EvidencePackBuildResult {
  pack?: EvidencePackV2;
  degraded: boolean;
  fallbackUsed: boolean;
  missingPrivateFields: string[];
  error?: string;
}

@Injectable()
export class EvidencePackService {
  private readonly logger = new Logger(EvidencePackService.name);

  constructor(private readonly snapshotV2: SnapshotV2Service) {}

  async buildForAnalysis(
    analysis: AnalysisForEvidencePack,
    signal?: AbortSignal,
  ): Promise<EvidencePackBuildResult> {
    try {
      const pack = await this.snapshotV2.fetchAsEvidencePack(
        analysis.stock.symbol,
        analysis.stock.market as 'US' | 'CN' | 'HK',
        signal ? { signal } : undefined,
      );
      return {
        pack,
        ...this.describePackAvailability(pack),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[${analysis.id}] SnapshotV2 evidence pack build failed: ${error} - dims fall back to web_search`,
      );
      return {
        degraded: true,
        fallbackUsed: false,
        missingPrivateFields: [],
        error,
      };
    }
  }

  private describePackAvailability(
    pack: EvidencePackV2,
  ): Omit<EvidencePackBuildResult, 'pack' | 'error'> {
    const availability = (
      pack as {
        dataAvailability?: {
          degradedSource?: string;
          missingPrivateFields?: unknown;
        };
      }
    ).dataAvailability;
    const missingPrivateFields = Array.isArray(
      availability?.missingPrivateFields,
    )
      ? availability.missingPrivateFields.filter(
          (field): field is string => typeof field === 'string',
        )
      : [];
    const fallbackUsed =
      availability?.degradedSource === 'WEB_SEARCH_FALLBACK';

    return {
      degraded:
        fallbackUsed ||
        (availability?.degradedSource !== undefined &&
          availability.degradedSource !== 'NONE'),
      fallbackUsed,
      missingPrivateFields,
    };
  }
}
