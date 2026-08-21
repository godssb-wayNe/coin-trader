import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';

/**
 * 🔬 [추가 입금 없는 순수 자체 복리 10년치 실데이터 시뮬레이터]
 */
export class PureCompoundSimulator {
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

  public async runPureSimulation(): Promise<void> {
    const symbols = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-ADA', 'KRW-SOL', 'KRW-DOGE'];
    const map = new Map<string, Candle[]>();
    for (const s of symbols) {
      map.set(s, await this.fetchAllUpbitCandles(s));
    }
    const btcCandles = map.get('KRW-BTC') || [];

    // 10만 원 시작 (추가 입금 0원)
    const res100k = this.simulate(symbols, map, btcCandles, 100000);

    // 100만 원 시작 (추가 입금 0원)
    const res1m = this.simulate(symbols, map, btcCandles, 1000000);

    console.log('\n==================================================================================================');
    console.log(`🏆 [추가 자본금 투입 0원! 순수 자체 복리 1위 변동성 역비례 하이브리드 엔진 10년 성적표]`);
    console.log('==================================================================================================');
    console.log(`구분                     초기 10만 원 시작 (순수 복리)        초기 100만 원 시작 (순수 복리)`);
    console.log('--------------------------------------------------------------------------------------------------');
    console.log(`• 시작 원금              ${res100k.initialCapital.toLocaleString()} KRW                       ${res1m.initialCapital.toLocaleString()} KRW`);
    console.log(`• 추가 투입금            0원 (외부 자금 유입 일절 없음)       0원 (외부 자금 유입 일절 없음)`);
    console.log(`• 최종 평가자산          ${Math.round(res100k.finalCapital).toLocaleString()} KRW 🌟                  ${Math.round(res1m.finalCapital).toLocaleString()} KRW 🚀`);
    console.log(`• 누적 순수익            +${Math.round(res100k.netProfit).toLocaleString()} KRW (+${res100k.roiPercent.toFixed(2)}%)            +${Math.round(res1m.netProfit).toLocaleString()} KRW (+${res1m.roiPercent.toFixed(2)}%)`);
    console.log(`• 최대 낙폭(MDD)         -${res100k.maxDrawdown.toFixed(2)}% (원금 방어)              -${res1m.maxDrawdown.toFixed(2)}% (원금 방어)`);
    console.log(`• 총 체결 횟수           ${res100k.totalTrades}회                            ${res1m.totalTrades}회`);
    console.log(`• 1차 익절(+8%) 체결     ${res100k.tp1Count}회                             ${res1m.tp1Count}회`);
    console.log(`• 2차 추세익절 체결      ${res100k.tp2Count}회                             ${res1m.tp2Count}회`);
    console.log(`• 손절(-2%) 체결         ${res100k.slCount}회                             ${res1m.slCount}회`);
    console.log(`• 통산 승률              ${res100k.winRate.toFixed(2)}%                            ${res1m.winRate.toFixed(2)}%`);
    console.log('==================================================================================================\n');
  }

  private simulate(symbols: string[], map: Map<string, Candle[]>, btcCandles: Candle[], initialCapital: number) {
    let cash = initialCapital;
    let peak = initialCapital;
    let maxDrawdown = 0;
    const cooldowns = new Map<string, number>();
    const positions: any[] = [];
    const trades: any[] = [];
    let tp1Count = 0;
    let tp2Count = 0;
    let slCount = 0;
    const maxSlots = 5;

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
          const netProfit = (sellPrice - pos.entryPrice) * sellQty - fee;

          cash += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.001;
          trades.push({ netProfit });
          tp1Count++;
        }

        // 2차 EMA20 추세 익절
        if (pos.isHalfClosed && lowPrice <= Math.max(ema20, pos.stopLossPrice)) {
          const exitPrice = Math.max(lowPrice, ema20, pos.stopLossPrice);
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;

          cash += (exitPrice * sellQty) - fee;
          cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
          positions.splice(p, 1);
          trades.push({ netProfit });
          tp2Count++;
          continue;
        }

        // -2% 손절
        if (!pos.isHalfClosed && lowPrice <= pos.stopLossPrice) {
          const exitPrice = pos.stopLossPrice;
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;

          cash += (exitPrice * sellQty) - fee;
          cooldowns.set(pos.market, currentCandle.timestamp + 45 * 60 * 1000);
          positions.splice(p, 1);
          trades.push({ netProfit });
          slCount++;
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
          // 🏆 1위 변동성 역비례 (Inverted ATR) 포지션 사이징
          const baseSlotAmount = (cash * 0.95) / openSlots;
          const atrRatio = Math.max(0.15, Math.min(0.35, 1 - (atr14 / currentCandle.tradePrice) * 5));
          const investAmount = Math.max(5000, Math.min(Math.floor(equity * atrRatio), Math.floor(cash * 0.95)));

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

    const winTrades = trades.filter((t) => t.netProfit > 0);

    return {
      initialCapital,
      finalCapital,
      netProfit: finalCapital - initialCapital,
      roiPercent: ((finalCapital - initialCapital) / initialCapital) * 100,
      maxDrawdown,
      totalTrades: trades.length,
      tp1Count,
      tp2Count,
      slCount,
      winRate: (winTrades.length / trades.length) * 100
    };
  }
}

async function main() {
  const sim = new PureCompoundSimulator();
  await sim.runPureSimulation();
}

main().catch(console.error);
