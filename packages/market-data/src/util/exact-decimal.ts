/**
 * 精确十进制运算（无第三方依赖）。
 *
 * market-data 不依赖 decimal.js；派生计算（FCF = OCF - capex、grossProfit =
 * revenue - costOfRevenue）用 BigInt 对齐小数位后做整数运算，避免 IEEE754
 * 浮点误差（如 6.34 - 5.1 = 1.2399999999999998）。
 */

export function decimalSubtract(a: string, b: string): string {
  const [aSign, aInt, aFrac] = parseDecimal(a);
  const [bSign, bInt, bFrac] = parseDecimal(b);
  const scale = Math.max(aFrac.length, bFrac.length);
  const aScaled = BigInt(aSign) * toBigInt(aInt, aFrac, scale);
  const bScaled = BigInt(bSign) * toBigInt(bInt, bFrac, scale);
  return formatScaled(aScaled - bScaled, scale);
}

function parseDecimal(value: string): [sign: 1 | -1, int: string, frac: string] {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`invalid decimal string: ${value}`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [int = '0', frac = ''] = unsigned.split('.');
  return [negative ? -1 : 1, int, frac];
}

function toBigInt(int: string, frac: string, scale: number): bigint {
  const paddedFrac = frac.padEnd(scale, '0');
  return BigInt(`${int}${paddedFrac}`);
}

function formatScaled(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
  if (scale === 0) return negative ? `-${digits}` : digits;
  const int = digits.slice(0, digits.length - scale);
  let frac = digits.slice(digits.length - scale);
  frac = frac.replace(/0+$/, '');
  const result = frac ? `${int}.${frac}` : int;
  return negative ? `-${result}` : result;
}
