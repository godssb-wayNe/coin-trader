import { TRADING_CONSTANTS } from '../config/constants';

export interface FeeAnalysis {
  entryPrice: number;
  breakEvenPrice: number;
  grossProfitPercent: number;
  netProfitPercent: number;
  isProfitableAfterFee: boolean;
}

/**
 * 업비트 거래 수수료 및 손익분기점(Break-Even Point) 계산기
 */
export class FeeCalculator {
  /**
   * 손익분기점(BEP) 가격 계산 (원금 + 왕복 수수료 0.1% + 슬리피지 0.1%)
   */
  public static calculateBreakEvenPrice(entryPrice: number): number {
    const buyRate = 1 + TRADING_CONSTANTS.UPBIT_FEE_RATE + TRADING_CONSTANTS.ESTIMATED_SLIPPAGE_RATE;
    const sellRate = 1 - (TRADING_CONSTANTS.UPBIT_FEE_RATE + TRADING_CONSTANTS.ESTIMATED_SLIPPAGE_RATE);
    return Math.ceil((entryPrice * buyRate) / sellRate);
  }

  /**
   * 목표 가격이 수수료를 차감하고도 순수익이 남는지 검증
   */
  public static evaluateNetProfit(entryPrice: number, targetPrice: number): FeeAnalysis {
    const breakEvenPrice = this.calculateBreakEvenPrice(entryPrice);
    const totalBuyCost = entryPrice * (1 + TRADING_CONSTANTS.UPBIT_FEE_RATE + TRADING_CONSTANTS.ESTIMATED_SLIPPAGE_RATE);
    const netProceeds = targetPrice * (1 - (TRADING_CONSTANTS.UPBIT_FEE_RATE + TRADING_CONSTANTS.ESTIMATED_SLIPPAGE_RATE));

    const grossProfitPercent = ((targetPrice - entryPrice) / entryPrice) * 100;
    const netProfitPercent = ((netProceeds - totalBuyCost) / totalBuyCost) * 100;

    return {
      entryPrice,
      breakEvenPrice,
      grossProfitPercent: Number(grossProfitPercent.toFixed(2)),
      netProfitPercent: Number(netProfitPercent.toFixed(2)),
      isProfitableAfterFee: netProfitPercent >= 1.5 // 수수료 제하고 순수익 1.5% 이상 확보
    };
  }
}
