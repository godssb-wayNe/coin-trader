import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';

interface LatencyStressReport {
  environment: string;
  networkLatency: string;
  slippageFeeRate: string;
  finalCapital: number;
  netProfit: number;
  roiPercent: number;
  maxDrawdown: number;
  totalTrades: number;
  winRate: number;
}

/**
 * 🛰️ [구글 클라우드(미국 us-central1) 네트워크 지연 및 슬리피지 반영 10년 스트레스 시뮬레이터]
 */
export class LatencyStressSimulator {
  public async fetchAllUpbitCandles(market: string): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    let toDateStr = '';
    for (let loop = 0; loop < 18; loop++) {
      const url = 'https://api.upbit.com/v1/candles/days';
      const params: any = { market, count: 200 };
      if (toDateStr) params.to = toDateStr;
      try {
        const response = await axios.get(url, { params });
        const data = response.data;
        if (!data || data.length === 0) break;
        const chunk: Candle[] = data.map((c: any) => ({
          market: c.market,
          candleDateTimeUtc: c.candle_date_time_utc,
          candleDateTimeKst: c.candle_date_time_kst,
          openingPrice: c.opening_price,
          highPrice: c.high_price,
          lowPrice: c.low_price,
          tradePrice: c.trade_price,
          timestamp: c.timestamp,
          candleAccTradeVolume: c.candle_acc_trade_volume,
          candleAccTradePrice: c.candle_acc_trade_price
        }));
        allCandles.unshift(...chunk.reverse());
        const oldest = data[data.length - 1].candle_date_time_utc;
        toDateStr = new Date(new Date(oldest).getTime() - 1000).toISOString().replace('.000Z', 'Z');
        await new Promise((resolve) => setTimeout(resolve, 80));
      } catch (err) {
        break;
      }
    }
    const uniqueMap = new Map<number, Candle>();
    allCandles.forEach((c) => uniqueMap.set(c.timestamp, c));
    return Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  public async runStressTest(): Promise<void> {
    const symbols = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-ADA', 'KRW-SOL', 'KRW-DOGE'];
    const map = new Map<string, Candle[]>();
    for (const s of symbols) {
      map.set(s, await this.fetchAllUpbitCandles(s));
    }
    const btcCandles = map.get('KRW-BTC') || [];

    const reports: LatencyStressReport[] = [];

    // 1. 이상적 환경 (0ms, 정상 수수료 0.1%)
    reports.push(this.simulateWithLatency(symbols, map, btcCandles, '1. 이상적 로컬 환경 (Ideal 0ms)', '0ms (로컬)', 0.001));

    // 2. 구글 클라우드 미국 서버 실제 환경 (150ms 태평양 횡단 + 왕복 0.3% 슬리피지)
    reports.push(this.simulateWithLatency(symbols, map, btcCandles, '2. 구글 클라우드 실제 환경 (us-central1)', '120~150ms', 0.003));

    // 3. 극한 악조건 환경 (Worst Case: 심한 렉 500ms + 왕복 0.5% 슬리피지)
    reports.push(this.simulateWithLatency(symbols, map, btcCandles, '3. 극한 악조건 스트레스 (Worst Case)', '500ms+', 0.005));

    console.log('\n==================================================================================================');
    console.log(`🛰️ [구글 클라우드(us-central1) 네트워크 지연 및 슬리피지 반영 10년 스트레스 검증 결과]`);
    console.log('==================================================================================================');
    console.log(`테스트 환경                          지연시간    왕복비용    최종 평가자산     누적 순수익 (수익률)    MDD`);
    console.log('--------------------------------------------------------------------------------------------------');
    for (const r of reports) {
      console.log(
        `${r.environment.padEnd(35)} ${r.networkLatency.padEnd(11)} ${(parseFloat(r.slippageFeeRate) * 100).toFixed(2)}%     ${Math.round(r.finalCapital).toLocaleString().padStart(9)}원    +${Math.round(r.netProfit).toLocaleString().padStart(7)}원 (+${r.roiPercent.toFixed(2)}%)   -${r.maxDrawdown.toFixed(2)}%`
      );
    }
    console.log('==================================================================================================\n');
  }

  private simulateWithLatency(
    symbols: string[],
    map: Map<string, Candle[]>,
    btcCandles: Candle[],
    envName: string,
    latency: string,
    roundTripFeeRate: number
  ): LatencyStressReport {
    const initialCapital = 100000;
    let cash = initialCapital;
    let peak = initialCapital;
    let maxDrawdown = 0;
    const cooldowns = new Map<string, number>();
    const positions: any[] = [];
    const trades: any[] = [];
    const maxSlots = 5;

    // 편도 슬리피지 및 수수료 패널티
    const singleLegCost = roundTripFeeRate / 2;

    for (let i = 200; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeKst.substring(0, 10);
      const btcHistorical = btcCandles.slice(0, i + 1);
      const btc200Ema = IndicatorCalculator.calculateEMA(btcHistorical.map((c) => c.tradePrice), 200);
      const isBtcBull = btcCandles[i].tradePrice > btc200Ema;

      // 매도 평가
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const candleList = map.get(pos.market);
        if (!candleList) continue;
        const cIdx = candleList.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (cIdx < 0) continue;
        const currentCandle = candleList[cIdx];
        const { highPrice, lowPrice } = currentCandle;
        if (highPrice > pos.highestPrice) pos.highestPrice = highPrice;

        const historical = candleList.slice(0, cIdx + 1);
        const { ema20 } = IndicatorCalculator.calculateAll(historical);

        // 1차 +8% 익절 (지연 슬리피지 적용 매도가격)
        if (!pos.isHalfClosed && ((highPrice - pos.entryPrice) / pos.entryPrice) * 100 >= 8.0) {
          const rawSellPrice = pos.entryPrice * 1.08;
          const sellPrice = rawSellPrice * (1 - singleLegCost); // 슬리피지 불리 체결
          const sellQty = pos.initialQuantity * 0.5;
          const netProfit = (sellPrice - pos.entryPrice) * sellQty;

          cash += sellPrice * sellQty;
          pos.isHalfClosed = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.001;
          trades.push({ netProfit });
        }

        // 2차 EMA20 추세 익절
        if (pos.isHalfClosed && lowPrice <= Math.max(ema20, pos.stopLossPrice)) {
          const rawExitPrice = Math.max(lowPrice, ema20, pos.stopLossPrice);
          const exitPrice = rawExitPrice * (1 - singleLegCost); // 슬리피지 불리 체결
          const sellQty = pos.remainingQuantity;
          const netProfit = (exitPrice - pos.entryPrice) * sellQty;

          cash += exitPrice * sellQty;
          cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
          positions.splice(p, 1);
          trades.push({ netProfit });
          continue;
        }

        // -2% 손절
        if (!pos.isHalfClosed && lowPrice <= pos.stopLossPrice) {
          const rawExitPrice = pos.stopLossPrice;
          const exitPrice = rawExitPrice * (1 - singleLegCost); // 슬리피지 불리 체결
          const sellQty = pos.remainingQuantity;
          const netProfit = (exitPrice - pos.entryPrice) * sellQty;

          cash += exitPrice * sellQty;
          cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
          positions.splice(p, 1);
          trades.push({ netProfit });
          continue;
        }
      }

      let equity = cash;
      for (const pos of positions) {
        const candle = map.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        equity += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
      }
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;

      if (!isBtcBull) continue;

      for (const s of symbols) {
        if (positions.length >= maxSlots) break;
        if (positions.some((p) => p.market === s)) continue;

        const openSlots = maxSlots - positions.length;
        const candleList = map.get(s);
        const cIdx = candleList?.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!cIdx || cIdx < 60) continue;

        const currentCandle = candleList![cIdx];
        if (currentCandle.timestamp < (cooldowns.get(s) || 0)) continue;

        const historical = candleList!.slice(0, cIdx + 1);
        const { rsi14, macd, ema20, ema60, atr14 } = IndicatorCalculator.calculateAll(historical);

        if (ema20 > ema60 && rsi14 >= 40 && rsi14 <= 60 && macd.histogram > 0) {
          const atrRatio = Math.max(0.15, Math.min(0.35, 1 - (atr14 / currentCandle.tradePrice) * 5));
          const investAmount = Math.max(5000, Math.min(Math.floor(equity * atrRatio), Math.floor(cash * 0.95)));

          if (cash < investAmount || investAmount < 5000) continue;

          // 매수 시 지연 슬리피지 (조금 더 높은 가격에 체결됨)
          const actualExecutionPrice = currentCandle.tradePrice * (1 + singleLegCost);
          const volume = investAmount / actualExecutionPrice;
          cash -= investAmount;

          positions.push({
            id: `${s}-${Date.now()}`,
            market: s,
            entryPrice: actualExecutionPrice,
            initialQuantity: volume,
            remainingQuantity: volume,
            isHalfClosed: false,
            highestPrice: actualExecutionPrice,
            stopLossPrice: actualExecutionPrice * 0.98,
            investedAmountKrw: investAmount
          });
        }
      }
    }

    const lastDate = btcCandles[btcCandles.length - 1].candleDateTimeKst.substring(0, 10);
    let finalCapital = cash;
    for (const pos of positions) {
      const candle = map.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === lastDate);
      finalCapital += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
    }

    const winTrades = trades.filter((t) => t.netProfit > 0);

    return {
      environment: envName,
      networkLatency: latency,
      slippageFeeRate: roundTripFeeRate.toString(),
      finalCapital,
      netProfit: finalCapital - initialCapital,
      roiPercent: ((finalCapital - initialCapital) / initialCapital) * 100,
      maxDrawdown,
      totalTrades: trades.length,
      winRate: trades.length > 0 ? (winTrades.length / trades.length) * 100 : 0
    };
  }
}

async function main() {
  const runner = new LatencyStressSimulator();
  await runner.runStressTest();
}

main().catch(console.error);
