import { FeeCalculator } from './feeCalculator';
import { TargetPriceResult } from '../data/models';
import { TRADING_CONSTANTS } from '../config/constants';

/**
 * 🎯 10년 1위 동적 목표가 및 손절가 산출 엔진
 * 1차 목표가: +8.0% (비대칭 손익비 1:2.7 이상)
 * 손절가: 최대 -2.0% 이내 엄격 통제
 */
export class TargetPriceEngine {
  public static calculate(entryPrice: number, atr14: number = 0): TargetPriceResult {
    // 1. 손익분기점(BEP)
    const breakEvenPrice = FeeCalculator.calculateBreakEvenPrice(entryPrice);

    // 2. 1차 목표가 (+8.0% 비대칭 익절)
    const targetPercent1 = TRADING_CONSTANTS.DEFAULT_TP1_PERCENT;
    const targetPrice1 = Math.round(entryPrice * (1 + targetPercent1 / 100));

    // 3. 초기 손절가 (-2.0% 엄격 방어)
    const stopLossPercent = TRADING_CONSTANTS.MAX_INITIAL_STOP_LOSS_PERCENT;
    const initialStopLossPrice = Math.round(entryPrice * (1 - stopLossPercent / 100));

    // 4. 손익비 (Risk-Reward Ratio: 8.0% / 2.0% = 4.0)
    const riskRewardRatio = Number((targetPercent1 / stopLossPercent).toFixed(2));

    return {
      targetPrice1,
      targetPercent1,
      initialStopLossPrice,
      stopLossPercent,
      breakEvenPrice,
      riskRewardRatio
    };
  }
}
