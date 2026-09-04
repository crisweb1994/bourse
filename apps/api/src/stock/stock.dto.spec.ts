import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSync } from 'class-validator';
import { UpsertStockDto } from './stock.dto';

/** KISS review B2-1: unsupported markets must be rejected at the DTO boundary. */

function makeDto(market: string): UpsertStockDto {
  const dto = new UpsertStockDto();
  dto.symbol = '7203';
  dto.name = 'Toyota';
  dto.market = market;
  dto.exchange = 'TSE';
  dto.currency = 'JPY';
  return dto;
}

function marketErrors(market: string): number {
  return validateSync(makeDto(market)).filter(
    (error) => error.property === 'market',
  ).length;
}

test('upsert DTO rejects markets outside the persisted US/CN/HK enum', () => {
  assert.equal(marketErrors('JP'), 1);
  assert.equal(marketErrors(''), 1);
});

test('upsert DTO accepts the three supported markets', () => {
  assert.equal(marketErrors('US'), 0);
  assert.equal(marketErrors('CN'), 0);
  assert.equal(marketErrors('HK'), 0);
});
