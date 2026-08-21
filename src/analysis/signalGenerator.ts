import { Candle, TradeSignal } from '../data/models';
import { IndicatorCalculator } from './indicators';
import { TRADING_CONSTANTS } from '../config/constants';

/**
 * 매수/매도 시그널 생성기 (Signal Generator)
 * 다중 지표 컨센서스(Consensus Scoring) 기반으로 신뢰도 높은 진입 자리만 선별합니다.
 */
export class SignalGenerator {
  /**
   * 15분봉 캔들 데이터를 분석하여 매매 신호 생성
   */
  public static generateSignal(market: string, candles: Candle[]): TradeSignal {
    if (candles.length < 30) {
      return this.createHoldSignal(market, '캔들 데이터 부족');
    }

    const currentPrice = candles[candles.length - 1].tradePrice;
    const indicators = IndicatorCalculator.calculateAll(candles);
    const { rsi14, macd, bollingerBands, ema5, ema20, ema60, atr14 } = indicators;

    let score = 0;
    const reasons: string[] = [];

    // [조건 1] RSI 과매도 탈출 또는 반등 구간 (30 ~ 45)
    if (rsi14 >= 30 && rsi14 <= 48) {
      score += 25;
      reasons.push(`RSI 저점 반등 구간 (${rsi14})`);
    }

    // [조건 2] MACD 히스토그램 양전 또는 시그널선 골든크로스
    if (macd.histogram > 0 || macd.macd > macd.signal) {
      score += 25;
      reasons.push(`MACD 상승 모멘텀 유지 (히스토그램: ${macd.histogram})`);
    }

    // [조건 3] 볼린저 밴드 하단 근접 후 양봉 반등
    const lastCandle = candles[candles.length - 1];
    const isBullishCandle = lastCandle.tradePrice > lastCandle.openingPrice;
    if (lastCandle.lowPrice <= bollingerBands.lower * 1.01 && isBullishCandle) {
      score += 25;
      reasons.push(`볼린저 밴드 하단선 지지 후 양봉 반등`);
    }

    // [조건 4] 단기 이평선(EMA5)이 중기 이평선(EMA20) 상향 돌파
    if (ema5 > ema20) {
      score += 25;
      reasons.push(`EMA 단기 정배열 (EMA5 > EMA20)`);
    }

    // 컨센서스 점수 70점 이상일 때만 매수 신호 확정
    if (score >= 70) {
      // 1단계 초기 손절가 산출: 직전 저점 또는 ATR 1.1배 아래 (최대 -1.3% 이내)
      const recentSwingLow = Math.min(...candles.slice(-5).map((c) => c.lowPrice));
      const atrStop = currentPrice - (atr14 * 1.1);
      let calculatedStop = Math.max(recentSwingLow * 0.998, atrStop);

      const maxStopLossPrice = currentPrice * (1 - TRADING_CONSTANTS.MAX_INITIAL_STOP_LOSS_PERCENT / 100);
      if (calculatedStop < maxStopLossPrice) {
        calculatedStop = maxStopLossPrice;
      }
      calculatedStop = Math.round(calculatedStop);

      // 1차 목표가 (+2.3%)
      const targetPrice = Math.round(currentPrice * (1 + TRADING_CONSTANTS.DEFAULT_TP1_PERCENT / 100));

      // 손익비 계산
      const potentialProfit = targetPrice - currentPrice;
      const potentialLoss = currentPrice - calculatedStop;
      const riskRewardRatio = potentialLoss > 0 ? Number((potentialProfit / potentialLoss).toFixed(2)) : 2.0;

      // 손익비가 1.5 미만인 경우 진입 거부
      if (riskRewardRatio < 1.5) {
        return this.createHoldSignal(market, `손익비 부족 (${riskRewardRatio} < 1.5)`);
      }

      return {
        market,
        signalType: 'BUY',
        score,
        reasons,
        currentPrice,
        suggestedStopLoss: calculatedStop,
        suggestedTargetPrice: targetPrice,
        riskRewardRatio,
        timestamp: Date.now()
      };
    }

    return this.createHoldSignal(market, `점수 미달 (${score}/100점)`);
  }

  private static createHoldSignal(market: string, reason: string): TradeSignal {
    return {
      market,
      signalType: 'HOLD',
      score: 0,
      reasons: [reason],
      currentPrice: 0,
      suggestedStopLoss: 0,
      suggestedTargetPrice: 0,
      riskRewardRatio: 0,
      timestamp: Date.now()
    };
  }
}
