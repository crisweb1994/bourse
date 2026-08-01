import { z } from 'zod';

/** Decimal strings used by canonical market-data observations. */
export const DecimalStringSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
