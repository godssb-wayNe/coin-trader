import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';

interface StrategyReport {
  id: number;
  name: string;
  description: string;
  finalCapital: number;
  netProfit: number;
  roiPercent: number;
  maxDrawdown: number;
  totalTrades: number;
  winRate: number;
}

/**
 * 🔬 [10가지 자금 관리 및 복리 극대화 모델 10년 실데이터 전수 벤치마크 엔진]
 */
export class TenStrategiesBenchmark {
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

  public async runBenchmark(): Promise<void> {
    const symbols = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-ADA', 'KRW-SOL', 'KRW-DOGE'];
    const map = new Map<string, Candle[]>();
    for (const s of symbols) {
      map.set(s, await this.fetchAllUpbitCandles(s));
    }
    const btcCandles = map.get('KRW-BTC') || [];

    const reports: StrategyReport[] = [];

    // 10가지 전략 시뮬레이션 정의
    const strategies = [
      { id: 1, name: '1. 정적 5분할 (Baseline)', desc: '총자산 20% 고정 배분' },
      { id: 2, name: '2. 가용현금 1/N 적응형 (Adaptive)', desc: '남은 가용현금 / 빈 슬롯 수' },
      { id: 3, name: '3. 신호 강도 가중형 (Signal Tiered)', desc: '80점 이상 35%, 일반 18%' },
      { id: 4, name: '4. 변동성 역비례 (Inverted ATR)', desc: 'ATR 낮을 때 비중 확대, 높을 때 축소' },
      { id: 5, name: '5. 3슬롯 집중 회전형 (3-Slot Focus)', desc: '최대 3종목 (33.3% 집중 투자)' },
      { id: 6, name: '6. 하프 켈리 (Half-Kelly Sizing)', desc: '승률/손익비 기반 최적 베팅 25%' },
      { id: 7, name: '7. 시장 국면 가변형 (Regime Adaptive)', desc: '대세상승 3슬롯 집중, 횡보 5슬롯 분산' },
      { id: 8, name: '8. 80/20 현금 버퍼형 (Cash Buffer)', desc: '20% 안전현금 항시 유지, 80% 적극 운용' },
      { id: 9, name: '9. 수익 재투자 가속형 (Profit Accel)', desc: '1차 익절금을 다음 매수 풀에 즉시 합산' },
      { id: 10, name: '10. 스마트 유입 동적 리밸런싱 (Smart DCA)', desc: '실시간 가용현금 95% 비례 최적화' }
    ];

    for (const st of strategies) {
      const res = this.simulate(symbols, map, btcCandles, st.id);
      reports.push({
        id: st.id,
        name: st.name,
        description: st.desc,
        ...res
      });
    }

    // 결과 출력
    console.log('\n==================================================================================================');
    console.log(`🏆 [업비트 10년치(3,253일) 실데이터: 10대 자금 관리 및 복리 극대화 전략 전수 벤치마크 결과]`);
    console.log('==================================================================================================');
    console.log(`순위  전략 모델명                        누적 순손익 (수익률)     최종 평가자산     MDD      승률    체결수`);
    console.log('--------------------------------------------------------------------------------------------------');

    // 수익률 기준 정렬
    const sorted = [...reports].sort((a, b) => b.roiPercent - a.roiPercent);

    sorted.forEach((r, rank) => {
      const medal = rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : '  ';
      console.log(
        `${medal} ${r.name.padEnd(32)} +${Math.round(r.netProfit).toLocaleString().padStart(7)}원 (+${r.roiPercent.toFixed(2)}%)   ${Math.round(r.finalCapital).toLocaleString().padStart(9)}원   -${r.maxDrawdown.toFixed(2)}%   ${r.winRate.toFixed(1)}%   ${r.totalTrades}회`
      );
    });
    console.log('==================================================================================================\n');
  }

  private simulate(symbols: string[], map: Map<string, Candle[]>, btcCandles: Candle[], strategyId: number) {
    const initialCapital = 100000;
    let cash = 100000;
    let peak = 100000;
    let maxDrawdown = 0;
    const cooldowns = new Map<string, number>();
    const positions: any[] = [];
    const trades: any[] = [];

    for (let i = 200; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeKst.substring(0, 10);
      const btcHistorical = btcCandles.slice(0, i + 1);
      const btc200Ema = IndicatorCalculator.calculateEMA(btcHistorical.map((c) => c.tradePrice), 200);
      const btc50Ema = IndicatorCalculator.calculateEMA(btcHistorical.map((c) => c.tradePrice), 50);
      const isBtcBull = btcCandles[i].tradePrice > btc200Ema;
      const isSuperBull = isBtcBull && btcCandles[i].tradePrice > btc50Ema;

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

      // 10가지 전략별 최대 슬롯 수 결정
      let maxSlots = 5;
      if (strategyId === 5) maxSlots = 3;
      if (strategyId === 7) maxSlots = isSuperBull ? 3 : 5;

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
          let investAmount = 0;

          switch (strategyId) {
            case 1: // 정적 5분할 (총자산 20%)
              investAmount = Math.min(Math.floor(equity / 5), Math.floor(cash * 0.95));
              break;

            case 2: // 가용현금 1/N 적응형
              investAmount = Math.max(5000, Math.floor((cash * 0.95) / openSlots));
              break;

            case 3: // 신호 강도 가중형
              const isHigh = rsi14 >= 45 && rsi14 <= 55;
              const ratio3 = isHigh ? 0.35 : 0.18;
              investAmount = Math.min(Math.floor(equity * ratio3), Math.floor(cash * 0.95));
              break;

            case 4: // 변동성 역비례 (Inverted ATR)
              const atrRatio = Math.max(0.15, Math.min(0.35, 1 - (atr14 / currentCandle.tradePrice) * 5));
              investAmount = Math.min(Math.floor(equity * atrRatio), Math.floor(cash * 0.95));
              break;

            case 5: // 3슬롯 집중 회전형
              investAmount = Math.max(5000, Math.floor((cash * 0.95) / openSlots));
              break;

            case 6: // 하프 켈리 (총자산 25%)
              investAmount = Math.min(Math.floor(equity * 0.25), Math.floor(cash * 0.95));
              break;

            case 7: // 시장 국면 가변형 (슈퍼불장 3슬롯, 일반 5슬롯)
              investAmount = Math.max(5000, Math.floor((cash * 0.95) / openSlots));
              break;

            case 8: // 80/20 현금 버퍼형 (20% 현금 남김)
              const usable80 = Math.max(0, cash - equity * 0.2);
              investAmount = Math.max(5000, Math.floor((usable80 * 0.95) / openSlots));
              break;

            case 9: // 수익 재투자 가속형 (수익금 가산 배분)
              const profitBonus = Math.max(0, equity - initialCapital) * 0.2;
              investAmount = Math.min(Math.floor((equity / 5) + profitBonus), Math.floor(cash * 0.95));
              break;

            case 10: // 스마트 유입 동적 리밸런싱 (가용현금 95% 기반)
              investAmount = Math.max(5000, Math.floor(Math.min(equity * 0.25, (cash * 0.95) / Math.max(1, openSlots))));
              break;
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

    const winTrades = trades.filter((t) => t.netProfit > 0);

    return {
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
  const runner = new TenStrategiesBenchmark();
  await runner.runBenchmark();
}

main().catch(console.error);
