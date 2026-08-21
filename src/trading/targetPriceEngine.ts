import { TRADING_CONSTANTS } from '../config/constants';

export interface DynamicTarget {
  targetPrice1: number;       // 1차 50% 분할 익절 목표가
  targetPercent1: number;     // 1차 목표 수익률 (%)
  initialStopPrice: number;   // 1단계 손절가
  stopLossPercent: number;    // 손절폭 (%)
  riskRewardRatio: number;    // 손익비
}

/**
 * 변동성(ATR) 기반 동적 목표가 및 손절가 산출 엔진
 */
export class TargetPriceEngine {
  /**
   * 진입가 및 ATR 기반 목표가 산출
   */
  public static calculate(entryPrice: number, atr14: number): DynamicTarget {
    const volatilityRatio = (atr14 / entryPrice) * 100;

    // 1차 목표 수익률: 최소 2.0% ~ 최대 4.0%
    let targetPercent1 = Math.max(
      2.0,
      Math.min(4.0, volatilityRatio * 1.5)
    );
    targetPercent1 = Number(targetPercent1.toFixed(2));

    // 손절 비율: 최대 1.3% 하드캡 적용
    let stopLossPercent = Math.max(
      0.9,
      Math.min(TRADING_CONSTANTS.MAX_INITIAL_STOP_LOSS_PERCENT, volatilityRatio * 1.0)
    );
    stopLossPercent = Number(stopLossPercent.toFixed(2));

    const targetPrice1 = Math.round(entryPrice * (1 + targetPercent1 / 100));
    const initialStopPrice = Math.round(entryPrice * (1 - stopLossPercent / 100));
    const riskRewardRatio = Number((targetPercent1 / stopLossPercent).toFixed(2));

    return {
      targetPrice1,
      targetPercent1,
      initialStopPrice,
      stopLossPercent,
      riskRewardRatio
    };
  }
}
