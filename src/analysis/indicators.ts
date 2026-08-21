import { Candle, TechnicalIndicators } from '../data/models';

/**
 * 기술적 분석 지표 계산기 (RSI, MACD, Bollinger Bands, EMA, ATR)
 * 캔들 데이터를 바탕으로 금융 지표를 정밀하게 산출합니다.
 */
export class IndicatorCalculator {
  /**
   * 전체 기술 지표 일괄 산출
   */
  public static calculateAll(candles: Candle[]): TechnicalIndicators {
    const closes = candles.map((c) => c.tradePrice);
    
    const rsi14 = this.calculateRSI(closes, 14);
    const macd = this.calculateMACD(closes);
    const bollingerBands = this.calculateBollingerBands(closes, 20, 2);
    const ema5 = this.calculateEMA(closes, 5);
    const ema20 = this.calculateEMA(closes, 20);
    const ema60 = this.calculateEMA(closes, 60);
    const atr14 = this.calculateATR(candles, 14);

    return {
      rsi14,
      macd,
      bollingerBands,
      ema5,
      ema20,
      ema60,
      atr14
    };
  }

  /**
   * RSI (Relative Strength Index) 계산
   */
  public static calculateRSI(closes: number[], period: number = 14): number {
    if (closes.length <= period) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) {
        avgGain = (avgGain * (period - 1) + diff) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - diff) / period;
      }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return Number((100 - 100 / (1 + rs)).toFixed(2));
  }

  /**
   * 지수이동평균(EMA) 계산
   */
  public static calculateEMA(values: number[], period: number): number {
    if (values.length === 0) return 0;
    if (values.length < period) {
      return values.reduce((sum, v) => sum + v, 0) / values.length;
    }

    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;

    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }

    return Number(ema.toFixed(2));
  }

  /**
   * MACD (12, 26, 9) 계산
   */
  public static calculateMACD(closes: number[]): { macd: number; signal: number; histogram: number } {
    if (closes.length < 26) {
      return { macd: 0, signal: 0, histogram: 0 };
    }

    const macdLine: number[] = [];
    const k12 = 2 / (12 + 1);
    const k26 = 2 / (26 + 1);

    let ema12 = closes.slice(0, 12).reduce((s, v) => s + v, 0) / 12;
    let ema26 = closes.slice(0, 26).reduce((s, v) => s + v, 0) / 26;

    for (let i = 26; i < closes.length; i++) {
      ema12 = closes[i] * k12 + ema12 * (1 - k12);
      ema26 = closes[i] * k26 + ema26 * (1 - k26);
      macdLine.push(ema12 - ema26);
    }

    const currentMacd = macdLine[macdLine.length - 1] || 0;
    const signalLine = this.calculateEMA(macdLine, 9);
    const histogram = currentMacd - signalLine;

    return {
      macd: Number(currentMacd.toFixed(2)),
      signal: Number(signalLine.toFixed(2)),
      histogram: Number(histogram.toFixed(2))
    };
  }

  /**
   * 볼린저 밴드 (20, 2) 계산
   */
  public static calculateBollingerBands(closes: number[], period: number = 20, multiplier: number = 2): {
    upper: number;
    middle: number;
    lower: number;
  } {
    if (closes.length < period) {
      const last = closes[closes.length - 1] || 0;
      return { upper: last, middle: last, lower: last };
    }

    const recent = closes.slice(-period);
    const mean = recent.reduce((sum, v) => sum + v, 0) / period;
    const variance = recent.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper: Number((mean + stdDev * multiplier).toFixed(2)),
      middle: Number(mean.toFixed(2)),
      lower: Number((mean - stdDev * multiplier).toFixed(2))
    };
  }

  /**
   * ATR (Average True Range) 변동성 지표 계산
   */
  public static calculateATR(candles: Candle[], period: number = 14): number {
    if (candles.length <= 1) return 0;

    const trValues: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const prevClose = candles[i - 1].tradePrice;

      const tr = Math.max(
        current.highPrice - current.lowPrice,
        Math.abs(current.highPrice - prevClose),
        Math.abs(current.lowPrice - prevClose)
      );
      trValues.push(tr);
    }

    if (trValues.length < period) {
      return trValues.reduce((s, v) => s + v, 0) / trValues.length;
    }

    let atr = trValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < trValues.length; i++) {
      atr = (atr * (period - 1) + trValues[i]) / period;
    }

    return Number(atr.toFixed(2));
  }
}
