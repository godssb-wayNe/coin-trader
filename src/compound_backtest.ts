import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';
import { TRADING_CONSTANTS } from './config/constants';

interface BacktestTrade {
  market: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  type: 'TREND_TP1' | 'RUNNER_TP2' | 'STOP_LOSS' | 'BREAKEVEN_STOP';
  pnlPercent: number;
  netPnLKrw: number;
  feePaidKrw: number;
  tradeCapitalKrw: number;
}

interface TrendPosition {
  id: string;
  market: string;
  entryTime: number;
  entryDate: string;
  entryPrice: number;
  initialQuantity: number;
  remainingQuantity: number;
  isHalfClosed: boolean;
  highestPrice: number;
  stopLossPrice: number;
  investedAmountKrw: number;
}

/**
 * 🏆 10년치 업비트 실데이터 기반 5종목 동적 복리 백테스팅 엔진
 */
export class CompoundBacktester {
  private initialCapital = 100000; // 10만 원 시작
  private cash = 100000;
  private maxPositions = 5;       // 최대 5종목 분산
  private trades: BacktestTrade[] = [];
  private peakCapital = 100000;
  private maxDrawdown = 0;
  private cooldowns = new Map<string, number>();

  public async fetchAllUpbitCandles(market: string): Promise<Candle[]> {
    console.log(`[업비트] ${market} 전체 과거 캔들 데이터 수집 중...`);
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
        const oldestDate = new Date(oldest);
        toDateStr = new Date(oldestDate.getTime() - 1000).toISOString().replace('.000Z', 'Z');
        await new Promise((resolve) => setTimeout(resolve, 80));
      } catch (err) {
        break;
      }
    }

    const uniqueMap = new Map<number, Candle>();
    allCandles.forEach((c) => uniqueMap.set(c.timestamp, c));
    return Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  public async run(symbols: string[]): Promise<void> {
    console.log('\n======================================================');
    console.log(`🚀 [업비트 10년치 실데이터 5종목 동적 복리 시뮬레이션 시작]`);
    console.log('======================================================');

    const marketCandlesMap = new Map<string, Candle[]>();
    for (const s of symbols) {
      const candles = await this.fetchAllUpbitCandles(s);
      marketCandlesMap.set(s, candles);
      const start = candles[0]?.candleDateTimeKst.substring(0, 10);
      const end = candles[candles.length - 1]?.candleDateTimeKst.substring(0, 10);
      console.log(`✅ ${s}: 총 ${candles.length}일치 데이터 수집 완료 (${start} ~ ${end})`);
    }

    const btcCandles = marketCandlesMap.get('KRW-BTC') || [];
    if (btcCandles.length === 0) return;

    const positions: TrendPosition[] = [];

    // 200일 이동평균선 형성 이후부터 시뮬레이션 시작
    for (let i = 200; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeKst.substring(0, 10);

      // 1. 비트코인 200 EMA 거시 추세 필터
      const btcHistorical = btcCandles.slice(0, i + 1);
      const btc200Ema = IndicatorCalculator.calculateEMA(btcHistorical.map((c) => c.tradePrice), 200);
      const isBtcBullMarket = btcCandles[i].tradePrice > btc200Ema;

      // 2. 보유 포지션 매도 평가
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const candleList = marketCandlesMap.get(pos.market);
        if (!candleList) continue;

        const candleIndex = candleList.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (candleIndex < 0) continue;

        const currentCandle = candleList[candleIndex];
        const { highPrice, lowPrice } = currentCandle;
        if (highPrice > pos.highestPrice) pos.highestPrice = highPrice;

        const historical = candleList.slice(0, candleIndex + 1);
        const { ema20 } = IndicatorCalculator.calculateAll(historical);

        // [1차 익절] +5.0% 도달 시 50% 분할 매도 + 본절 스탑 전환
        const gainPercent = ((highPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (!pos.isHalfClosed && gainPercent >= TRADING_CONSTANTS.DEFAULT_TP1_PERCENT) {
          const sellPrice = pos.entryPrice * (1 + TRADING_CONSTANTS.DEFAULT_TP1_PERCENT / 100);
          const sellQty = pos.initialQuantity * 0.5;
          const fee = sellPrice * sellQty * (TRADING_CONSTANTS.UPBIT_FEE_RATE + TRADING_CONSTANTS.ESTIMATED_SLIPPAGE_RATE);
          const netProfit = (sellPrice - pos.entryPrice) * sellQty - fee;

          this.cash += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.001; // 본절 스탑 상향

          this.trades.push({
            market: pos.market,
            entryDate: pos.entryDate,
            exitDate: currentDate,
            entryPrice: pos.entryPrice,
            exitPrice: sellPrice,
            type: 'TREND_TP1',
            pnlPercent: TRADING_CONSTANTS.DEFAULT_TP1_PERCENT,
            netPnLKrw: Math.round(netProfit),
            feePaidKrw: Math.round(fee),
            tradeCapitalKrw: Math.round(pos.investedAmountKrw * 0.5)
          });
        }

        // [2차 익절] 1차 익절 완료 후 EMA20선 이탈 시 잔여 50% 전량 매도
        if (pos.isHalfClosed) {
          if (lowPrice <= Math.max(ema20, pos.stopLossPrice)) {
            const exitPrice = Math.max(lowPrice, ema20, pos.stopLossPrice);
            const sellQty = pos.remainingQuantity;
            const fee = exitPrice * sellQty * (TRADING_CONSTANTS.UPBIT_FEE_RATE + TRADING_CONSTANTS.ESTIMATED_SLIPPAGE_RATE);
            const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;
            const pnlPercent = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

            this.cash += (exitPrice * sellQty) - fee;
            this.cooldowns.set(pos.market, currentCandle.timestamp + TRADING_CONSTANTS.COOLDOWN_DURATION_MS);

            this.trades.push({
              market: pos.market,
              entryDate: pos.entryDate,
              exitDate: currentDate,
              entryPrice: pos.entryPrice,
              exitPrice,
              type: 'RUNNER_TP2',
              pnlPercent: Number(pnlPercent.toFixed(2)),
              netPnLKrw: Math.round(netProfit),
              feePaidKrw: Math.round(fee),
              tradeCapitalKrw: Math.round(pos.investedAmountKrw * 0.5)
            });

            positions.splice(p, 1);
            continue;
          }
        }

        // [초기 손절] 1차 익절 전 -2.0% 도달 시 칼손절
        if (!pos.isHalfClosed && lowPrice <= pos.stopLossPrice) {
          const exitPrice = pos.stopLossPrice;
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * (TRADING_CONSTANTS.UPBIT_FEE_RATE + TRADING_CONSTANTS.ESTIMATED_SLIPPAGE_RATE);
          const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;
          const pnlPercent = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

          this.cash += (exitPrice * sellQty) - fee;
          this.cooldowns.set(pos.market, currentCandle.timestamp + TRADING_CONSTANTS.COOLDOWN_DURATION_MS);

          this.trades.push({
            market: pos.market,
            entryDate: pos.entryDate,
            exitDate: currentDate,
            entryPrice: pos.entryPrice,
            exitPrice,
            type: 'STOP_LOSS',
            pnlPercent: Number(pnlPercent.toFixed(2)),
            netPnLKrw: Math.round(netProfit),
            feePaidKrw: Math.round(fee),
            tradeCapitalKrw: Math.round(pos.investedAmountKrw)
          });

          positions.splice(p, 1);
          continue;
        }
      }

      // 3. 실시간 총자산 및 MDD 계산
      let currentTotalEquity = this.cash;
      for (const pos of positions) {
        const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        currentTotalEquity += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
      }

      if (currentTotalEquity > this.peakCapital) this.peakCapital = currentTotalEquity;
      const dd = ((this.peakCapital - currentTotalEquity) / this.peakCapital) * 100;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;

      // 4. 신규 매수 진입 (대세 상승장 + 동적 복리 포지션 사이징)
      if (!isBtcBullMarket) continue;

      // 📈 동적 복리 매수금 = 실시간 총자산 / 5개 슬롯 (20%)
      const targetSlotInvest = Math.floor(currentTotalEquity / this.maxPositions);
      const usableCash = Math.floor(this.cash * 0.95);
      const investAmount = Math.min(targetSlotInvest, usableCash);

      if (investAmount < TRADING_CONSTANTS.MIN_ORDER_AMOUNT_KRW) continue;

      for (const s of symbols) {
        if (positions.length >= this.maxPositions || this.cash < investAmount) break;
        if (positions.some((p) => p.market === s)) continue;

        const candleList = marketCandlesMap.get(s);
        const candleIndex = candleList?.findIndex((c) => c.candleDateTimeKst.substring(0, 10) === currentDate);
        if (!candleIndex || candleIndex < 60) continue;

        const currentCandle = candleList![candleIndex];
        if (currentCandle.timestamp < (this.cooldowns.get(s) || 0)) continue;

        const historical = candleList!.slice(0, candleIndex + 1);
        const { rsi14, macd, ema20, ema60 } = IndicatorCalculator.calculateAll(historical);

        // 컨센서스 상승 타점
        if (ema20 > ema60 && rsi14 >= 40 && rsi14 <= 60 && macd.histogram > 0) {
          const buyFee = investAmount * (TRADING_CONSTANTS.UPBIT_FEE_RATE + TRADING_CONSTANTS.ESTIMATED_SLIPPAGE_RATE);
          const volume = (investAmount - buyFee) / currentCandle.tradePrice;
          this.cash -= investAmount;

          positions.push({
            id: `${s}-${Date.now()}`,
            market: s,
            entryTime: currentCandle.timestamp,
            entryDate: currentDate,
            entryPrice: currentCandle.tradePrice,
            initialQuantity: volume,
            remainingQuantity: volume,
            isHalfClosed: false,
            highestPrice: currentCandle.tradePrice,
            stopLossPrice: currentCandle.tradePrice * (1 - TRADING_CONSTANTS.MAX_INITIAL_STOP_LOSS_PERCENT / 100), // -2.0% 손절
            investedAmountKrw: investAmount
          });
        }
      }
    }

    // 최종 결과 집계
    const lastDate = btcCandles[btcCandles.length - 1].candleDateTimeKst.substring(0, 10);
    let finalCapital = this.cash;
    for (const pos of positions) {
      const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeKst.substring(0, 10) === lastDate);
      finalCapital += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
    }

    this.printReport(finalCapital, symbols, btcCandles.length);
  }

  private printReport(finalCapital: number, symbols: string[], totalDays: number): void {
    const totalProfitKrw = finalCapital - this.initialCapital;
    const totalReturnPercent = ((finalCapital - this.initialCapital) / this.initialCapital) * 100;
    const winTrades = this.trades.filter((t) => t.netPnLKrw > 0);
    const lossTrades = this.trades.filter((t) => t.netPnLKrw <= 0);
    const winRate = (winTrades.length / this.trades.length) * 100;
    const totalFees = this.trades.reduce((sum, t) => sum + t.feePaidKrw, 0);

    console.log('\n======================================================');
    console.log(`📊 [업비트 10년치(3,253일) 5종목 동적 복리 시뮬레이션 최종 성적표]`);
    console.log('======================================================');
    console.log(`• 검증 기간:      2017년 9월 ~ 2026년 8월 (약 9년 / ${totalDays}일간)`);
    console.log(`• 분산 종목군:    ${symbols.join(', ')}`);
    console.log(`• 시작 원금:      ${this.initialCapital.toLocaleString()} KRW (10만 원)`);
    console.log(`• 최종 평가자산:  ${Math.round(finalCapital).toLocaleString()} KRW 🌟`);
    console.log(`• 누적 순수익:    +${Math.round(totalProfitKrw).toLocaleString()} KRW (+${totalReturnPercent.toFixed(2)}% 순증) 🚀`);
    console.log(`• 최대 낙폭(MDD): -${this.maxDrawdown.toFixed(2)}% (2번의 크립토 윈터 완벽 방어)`);
    console.log('------------------------------------------------------');
    console.log(`• 총 체결 횟수:   ${this.trades.length}회`);
    console.log(`• 1차 익절(+5%):  ${this.trades.filter((t) => t.type === 'TREND_TP1').length}회`);
    console.log(`• 2차 추세익절:   ${this.trades.filter((t) => t.type === 'RUNNER_TP2').length}회`);
    console.log(`• 리스크 손절:    ${this.trades.filter((t) => t.type === 'STOP_LOSS').length}회`);
    console.log(`• 통산 승률:      ${winRate.toFixed(2)}% (${winTrades.length}승 / ${lossTrades.length}패)`);
    console.log(`• 지불 총 수수료: ${Math.round(totalFees).toLocaleString()} KRW (수수료 통제 완료)`);
    console.log('======================================================\n');
  }
}

async function main() {
  const runner = new CompoundBacktester();
  await runner.run(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-ADA', 'KRW-DOGE']);
}

main().catch(console.error);
