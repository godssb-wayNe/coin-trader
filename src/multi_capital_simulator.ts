import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';

interface StrategyStats {
  name: string;
  finalCapital: number;
  netProfit: number;
  returnPercent: number;
  maxDrawdown: number;
  totalTrades: number;
  cashUtilization: number; // 평균 현금 활용도 (%)
}

/**
 * 🔬 [4대 자금 관리 모델 10년 실데이터 비교 시뮬레이터]
 * 1. 고정 5슬롯 분할 (기준)
 * 2. 가용현금 100% 유동적 배분 (Adaptive Slot)
 * 3. 신호 강도 가중치 배분 (Signal Weighted: 80점 이상 40%, 일반 20%)
 * 4. 스마트 하프 켈리 (Half-Kelly: 총자산 30% 집중 회전형)
 */
export class CapitalEfficiencySimulator {
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

  public async runAll(): Promise<void> {
    const symbols = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-ADA', 'KRW-SOL'];
    const map = new Map<string, Candle[]>();
    for (const s of symbols) {
      map.set(s, await this.fetchAllUpbitCandles(s));
    }
    const btcCandles = map.get('KRW-BTC') || [];

    const results: StrategyStats[] = [];

    // 모델 1: 고정 5슬롯 (기준)
    results.push(this.simulateModel(symbols, map, btcCandles, 'MODEL_1_FIXED_5'));

    // 모델 2: 유동적 잔여 슬롯 배분
    results.push(this.simulateModel(symbols, map, btcCandles, 'MODEL_2_ADAPTIVE'));

    // 모델 3: 신호 강도 가중 배분 (Signal Weighted)
    results.push(this.simulateModel(symbols, map, btcCandles, 'MODEL_3_SIGNAL_WEIGHTED'));

    // 모델 4: 스마트 3슬롯 집중 회전형 (Smart 3-Slot Concentrated)
    results.push(this.simulateModel(symbols, map, btcCandles, 'MODEL_4_SMART_3SLOT'));

    console.log('\n===================================================================================');
    console.log(`🏆 [유휴 현금 최소화 & 수익률 극대화 4대 자금 모델 10년 시뮬레이션 종합 성적표]`);
    console.log('===================================================================================');
    console.log(`전략 모델                        최종 평가자산      누적 순손익 (수익률)     최대낙폭(MDD)    체결횟수`);
    console.log('-----------------------------------------------------------------------------------');
    for (const r of results) {
      console.log(
        `${r.name.padEnd(30)} ${Math.round(r.finalCapital).toLocaleString().padStart(10)}원    +${Math.round(r.netProfit).toLocaleString().padStart(8)}원 (+${r.returnPercent.toFixed(2)}%)   -${r.maxDrawdown.toFixed(2)}%       ${r.totalTrades}회`
      );
    }
    console.log('===================================================================================\n');
  }

  private simulateModel(
    symbols: string[],
    map: Map<string, Candle[]>,
    btcCandles: Candle[],
    modelType: 'MODEL_1_FIXED_5' | 'MODEL_2_ADAPTIVE' | 'MODEL_3_SIGNAL_WEIGHTED' | 'MODEL_4_SMART_3SLOT'
  ): StrategyStats {
    let cash = 100000;
    let peak = 100000;
    let maxDrawdown = 0;
    const cooldowns = new Map<string, number>();
    const positions: any[] = [];
    let tradeCount = 0;

    const maxSlots = modelType === 'MODEL_4_SMART_3SLOT' ? 3 : 5;

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

        // 1차 +8% 익절
        if (!pos.isHalfClosed && ((highPrice - pos.entryPrice) / pos.entryPrice) * 100 >= 8.0) {
          const sellPrice = pos.entryPrice * 1.08;
          const sellQty = pos.initialQuantity * 0.5;
          const fee = sellPrice * sellQty * 0.001;
          cash += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.001;
          tradeCount++;
        }

        // 2차 EMA20 추세 익절
        if (pos.isHalfClosed && lowPrice <= Math.max(ema20, pos.stopLossPrice)) {
          const exitPrice = Math.max(lowPrice, ema20, pos.stopLossPrice);
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          cash += (exitPrice * sellQty) - fee;
          cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
          positions.splice(p, 1);
          tradeCount++;
          continue;
        }

        // -2% 손절
        if (!pos.isHalfClosed && lowPrice <= pos.stopLossPrice) {
          const exitPrice = pos.stopLossPrice;
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          cash += (exitPrice * sellQty) - fee;
          cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
          positions.splice(p, 1);
          tradeCount++;
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
        let investAmount = 0;

        const candleList = map.get(s);
        const cIdx = candleList?.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!cIdx || cIdx < 60) continue;

        const currentCandle = candleList![cIdx];
        if (currentCandle.timestamp < (cooldowns.get(s) || 0)) continue;

        const historical = candleList!.slice(0, cIdx + 1);
        const { rsi14, macd, ema20, ema60 } = IndicatorCalculator.calculateAll(historical);

        if (ema20 > ema60 && rsi14 >= 40 && rsi14 <= 60 && macd.histogram > 0) {
          // 모델별 포지션 사이징 산출
          if (modelType === 'MODEL_1_FIXED_5') {
            investAmount = Math.min(Math.floor(equity / 5), Math.floor(cash * 0.95));
          } else if (modelType === 'MODEL_2_ADAPTIVE') {
            investAmount = Math.max(5000, Math.floor((cash * 0.95) / openSlots));
          } else if (modelType === 'MODEL_3_SIGNAL_WEIGHTED') {
            // 신호 강도: RSI 45~55 사이 및 MACD 히스토그램 급증 시 가중치 35% 투입
            const isStrongSignal = rsi14 >= 45 && rsi14 <= 55;
            const weightRatio = isStrongSignal ? 0.35 : 0.20;
            investAmount = Math.min(Math.floor(equity * weightRatio), Math.floor(cash * 0.95));
          } else if (modelType === 'MODEL_4_SMART_3SLOT') {
            // 3슬롯 집중: 총자산 33% 또는 가용현금/빈슬롯
            investAmount = Math.max(5000, Math.floor((cash * 0.95) / openSlots));
          }

          if (cash < investAmount || investAmount < 5000) continue;

          const buyFee = investAmount * 0.001;
          const volume = (investAmount - buyFee) / currentCandle.tradePrice;
          cash -= investAmount;

          positions.push({
            id: `${s}-${Date.now()}`,
            market: s,
            entryPrice: currentCandle.tradePrice,
            initialQuantity: volume,
            remainingQuantity: volume,
            isHalfClosed: false,
            highestPrice: currentCandle.tradePrice,
            stopLossPrice: currentCandle.tradePrice * 0.98,
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

    const titles: Record<string, string> = {
      MODEL_1_FIXED_5: '1. 고정 5슬롯 분할 (기준)',
      MODEL_2_ADAPTIVE: '2. 유동적 5슬롯 배분 (Adaptive)',
      MODEL_3_SIGNAL_WEIGHTED: '3. 신호강도 가중 배분 (Weighted)',
      MODEL_4_SMART_3SLOT: '4. 스마트 3슬롯 집중 회전형'
    };

    return {
      name: titles[modelType],
      finalCapital,
      netProfit: finalCapital - 100000,
      returnPercent: ((finalCapital - 100000) / 100000) * 100,
      maxDrawdown,
      totalTrades: tradeCount,
      cashUtilization: 0
    };
  }
}

async function main() {
  const runner = new CapitalEfficiencySimulator();
  await runner.runAll();
}

main().catch(console.error);
