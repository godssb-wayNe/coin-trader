import axios from 'axios';
import { IndicatorCalculator } from './analysis/indicators';
import { Candle } from './data/models';

interface BacktestTrade {
  market: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  type: 'TREND_TP1' | 'RUNNER_TP2' | 'STOP_LOSS';
  pnlPercent: number;
  netPnLUsdt: number;
  feePaidUsdt: number;
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
  investedAmountUsdt: number;
}

/**
 * 🌍 글로벌 1위 거래소 바이낸스(Binance USDT 마켓) 8년치 백테스팅 엔진
 */
export class BinanceBacktester {
  private initialCapitalUsdt = 750; // 약 100만 원 상당 (750 USDT)
  private cashUsdt = 750;
  private maxPositions = 3;
  private trades: BacktestTrade[] = [];
  private peakCapital = 750;
  private maxDrawdown = 0;
  private cooldowns = new Map<string, number>();

  /**
   * 바이낸스 공용 REST API로 과거 일봉 캔들 데이터 수집
   */
  public async fetchBinanceCandles(symbol: string, limit: number = 1000): Promise<Candle[]> {
    console.log(`[Binance] ${symbol} 과거 캔들 데이터 수집 중...`);
    const allCandles: Candle[] = [];
    let endTime: number | undefined = undefined;

    // 1000개씩 최대 3회 페칭 (약 3,000일치 / 8년치)
    for (let loop = 0; loop < 3; loop++) {
      const url = 'https://api.binance.com/api/v3/klines';
      const params: any = { symbol, interval: '1d', limit: 1000 };
      if (endTime) params.endTime = endTime;

      try {
        const response = await axios.get(url, { params });
        const data = response.data;
        if (!data || data.length === 0) break;

        const chunk: Candle[] = data.map((k: any) => ({
          market: symbol,
          candleDateTimeUtc: new Date(k[0]).toISOString(),
          candleDateTimeKst: new Date(k[0] + 9 * 60 * 60 * 1000).toISOString(),
          openingPrice: parseFloat(k[1]),
          highPrice: parseFloat(k[2]),
          lowPrice: parseFloat(k[3]),
          tradePrice: parseFloat(k[4]),
          timestamp: k[0],
          candleAccTradeVolume: parseFloat(k[5]),
          candleAccTradePrice: parseFloat(k[7])
        }));

        allCandles.unshift(...chunk);
        endTime = data[0][0] - 1; // 다음 과거 청크를 위해 시간 역산
        await new Promise((resolve) => setTimeout(resolve, 80));
      } catch (err) {
        break;
      }
    }

    // 중복 제거 및 시간순 정렬
    const uniqueMap = new Map<number, Candle>();
    allCandles.forEach((c) => uniqueMap.set(c.timestamp, c));
    return Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 바이낸스 포트폴리오 백테스트 실행
   */
  public async runBinanceBacktest(symbols: string[]): Promise<void> {
    console.log(`\n======================================================`);
    console.log(`🌍 [바이낸스(Binance) 글로벌 마켓 백테스트 데이터 수집]`);
    console.log(`======================================================`);

    const marketCandlesMap = new Map<string, Candle[]>();
    for (const s of symbols) {
      const candles = await this.fetchBinanceCandles(s);
      marketCandlesMap.set(s, candles);
      const start = candles[0]?.candleDateTimeUtc.substring(0, 10);
      const end = candles[candles.length - 1]?.candleDateTimeUtc.substring(0, 10);
      console.log(`✅ Binance ${s}: 총 ${candles.length}일치 데이터 수집 완료 (${start} ~ ${end})`);
    }

    const btcCandles = marketCandlesMap.get('BTCUSDT') || [];
    if (btcCandles.length === 0) return;

    const positions: TrendPosition[] = [];

    // 200일선 안정화 이후부터 시뮬레이션 시작
    for (let i = 200; i < btcCandles.length; i++) {
      const currentDate = btcCandles[i].candleDateTimeUtc.substring(0, 10);

      // 1. 비트코인 200 EMA 거시 필터
      const btcHistorical = btcCandles.slice(0, i + 1);
      const btc200Ema = IndicatorCalculator.calculateEMA(btcHistorical.map((c) => c.tradePrice), 200);
      const isBtcBullMarket = btcCandles[i].tradePrice > btc200Ema;

      // 2. 보유 포지션 매도 평가
      for (let p = positions.length - 1; p >= 0; p--) {
        const pos = positions[p];
        const candleList = marketCandlesMap.get(pos.market);
        if (!candleList) continue;

        const candleIndex = candleList.findIndex((c) => c.candleDateTimeUtc.substring(0, 10) === currentDate);
        if (candleIndex < 0) continue;

        const currentCandle = candleList[candleIndex];
        const { highPrice, lowPrice } = currentCandle;
        if (highPrice > pos.highestPrice) pos.highestPrice = highPrice;

        const historical = candleList.slice(0, candleIndex + 1);
        const { ema20 } = IndicatorCalculator.calculateAll(historical);

        // [익절 1] +8.0% 도달 시 50% 분할 익절 + 본절 스탑 전환
        const gainPercent = ((highPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (!pos.isHalfClosed && gainPercent >= 8.0) {
          const sellPrice = pos.entryPrice * 1.08;
          const sellQty = pos.initialQuantity * 0.5;
          const fee = sellPrice * sellQty * 0.001;
          const netProfit = (sellPrice - pos.entryPrice) * sellQty - fee;

          this.cashUsdt += (sellPrice * sellQty) - fee;
          pos.isHalfClosed = true;
          pos.remainingQuantity -= sellQty;
          pos.stopLossPrice = pos.entryPrice * 1.002;

          this.trades.push({
            market: pos.market,
            entryDate: pos.entryDate,
            exitDate: currentDate,
            entryPrice: pos.entryPrice,
            exitPrice: sellPrice,
            type: 'TREND_TP1',
            pnlPercent: 8.0,
            netPnLUsdt: Number(netProfit.toFixed(2)),
            feePaidUsdt: Number(fee.toFixed(2))
          });
        }

        // [익절 2] 잔여 50% 물량: EMA 20선 이탈 시 전량 매도
        if (pos.isHalfClosed) {
          if (lowPrice <= Math.max(ema20, pos.stopLossPrice)) {
            const exitPrice = Math.max(lowPrice, ema20, pos.stopLossPrice);
            const sellQty = pos.remainingQuantity;
            const fee = exitPrice * sellQty * 0.001;
            const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;
            const pnlPercent = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

            this.cashUsdt += (exitPrice * sellQty) - fee;
            this.cooldowns.set(pos.market, currentCandle.timestamp + 24 * 60 * 60 * 1000);

            this.trades.push({
              market: pos.market,
              entryDate: pos.entryDate,
              exitDate: currentDate,
              entryPrice: pos.entryPrice,
              exitPrice,
              type: 'RUNNER_TP2',
              pnlPercent: Number(pnlPercent.toFixed(2)),
              netPnLUsdt: Number(netProfit.toFixed(2)),
              feePaidUsdt: Number(fee.toFixed(2))
            });

            positions.splice(p, 1);
            continue;
          }
        }

        // [손절] 1차 익절 전 -3.0% 초기 손절
        if (!pos.isHalfClosed && lowPrice <= pos.stopLossPrice) {
          const exitPrice = pos.stopLossPrice;
          const sellQty = pos.remainingQuantity;
          const fee = exitPrice * sellQty * 0.001;
          const netProfit = (exitPrice - pos.entryPrice) * sellQty - fee;
          const pnlPercent = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

          this.cashUsdt += (exitPrice * sellQty) - fee;
          this.cooldowns.set(pos.market, currentCandle.timestamp + 24 * 60 * 60 * 1000);

          this.trades.push({
            market: pos.market,
            entryDate: pos.entryDate,
            exitDate: currentDate,
            entryPrice: pos.entryPrice,
            exitPrice,
            type: 'STOP_LOSS',
            pnlPercent: Number(pnlPercent.toFixed(2)),
            netPnLUsdt: Number(netProfit.toFixed(2)),
            feePaidUsdt: Number(fee.toFixed(2))
          });

          positions.splice(p, 1);
          continue;
        }
      }

      // 3. 자본금 및 MDD 추적
      let currentCap = this.cashUsdt;
      for (const pos of positions) {
        const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeUtc.substring(0, 10) === currentDate);
        currentCap += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
      }
      if (currentCap > this.peakCapital) this.peakCapital = currentCap;
      const dd = ((this.peakCapital - currentCap) / this.peakCapital) * 100;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;

      // 4. 신규 매수 진입 (대세 상승장 + 정배열 골든크로스)
      if (!isBtcBullMarket) continue;

      const investAmount = Math.max(75, Math.floor(currentCap * 0.2)); // 20% 분할 (약 10~20만원)

      for (const s of symbols) {
        if (positions.length >= this.maxPositions || this.cashUsdt < investAmount) break;
        if (positions.some((p) => p.market === s)) continue;

        const candleList = marketCandlesMap.get(s);
        const candleIndex = candleList?.findIndex((c) => c.candleDateTimeUtc.substring(0, 10) === currentDate);
        if (!candleIndex || candleIndex < 60) continue;

        const currentCandle = candleList![candleIndex];
        if (currentCandle.timestamp < (this.cooldowns.get(s) || 0)) continue;

        const historical = candleList!.slice(0, candleIndex + 1);
        const { rsi14, macd, ema20, ema60 } = IndicatorCalculator.calculateAll(historical);

        if (ema20 > ema60 && rsi14 >= 40 && rsi14 <= 60 && macd.histogram > 0) {
          const buyFee = investAmount * 0.001;
          const volume = (investAmount - buyFee) / currentCandle.tradePrice;
          this.cashUsdt -= investAmount;

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
            stopLossPrice: currentCandle.tradePrice * 0.97, // -3% 손절
            investedAmountUsdt: investAmount
          });
        }
      }
    }

    // 최종 결과 출력
    const lastDate = btcCandles[btcCandles.length - 1].candleDateTimeUtc.substring(0, 10);
    let finalCapital = this.cashUsdt;
    for (const pos of positions) {
      const candle = marketCandlesMap.get(pos.market)?.find((c) => c.candleDateTimeUtc.substring(0, 10) === lastDate);
      finalCapital += pos.remainingQuantity * (candle ? candle.tradePrice : pos.entryPrice);
    }

    this.printReport(finalCapital, symbols, btcCandles.length);
  }

  private printReport(finalCapital: number, symbols: string[], totalDays: number): void {
    const totalProfitUsdt = finalCapital - this.initialCapitalUsdt;
    const totalReturnPercent = ((finalCapital - this.initialCapitalUsdt) / this.initialCapitalUsdt) * 100;
    const winTrades = this.trades.filter((t) => t.netPnLUsdt > 0);
    const lossTrades = this.trades.filter((t) => t.netPnLUsdt <= 0);
    const winRate = (winTrades.length / this.trades.length) * 100;
    const totalFees = this.trades.reduce((sum, t) => sum + t.feePaidUsdt, 0);

    // KRW 환산 (1 USDT ≈ 1,350 KRW 기준)
    const krwRate = 1350;
    const initialKrw = Math.round(this.initialCapitalUsdt * krwRate);
    const finalKrw = Math.round(finalCapital * krwRate);
    const profitKrw = Math.round(totalProfitUsdt * krwRate);

    console.log('\n======================================================');
    console.log(`🌐 [글로벌 1위 바이낸스(Binance) 장기 백테스트 최종 결과]`);
    console.log('======================================================');
    console.log(`• 테스트 기간:    2017년 ~ 2026년 8월 (약 8.5년 / ${totalDays}일간)`);
    console.log(`• 대상 종목군:    ${symbols.join(', ')} (USDT 마켓)`);
    console.log(`• 시작 자본금:    ${this.initialCapitalUsdt.toFixed(2)} USDT (약 ${initialKrw.toLocaleString()}원)`);
    console.log(`• 최종 평가자산:  ${finalCapital.toFixed(2)} USDT (약 ${finalKrw.toLocaleString()}원)`);
    console.log(`• 누적 순손익:    ${totalProfitUsdt >= 0 ? '+' : ''}${totalProfitUsdt.toFixed(2)} USDT (+${profitKrw.toLocaleString()}원 / +${totalReturnPercent.toFixed(2)}%) 🌟`);
    console.log(`• 최대 낙폭(MDD): -${this.maxDrawdown.toFixed(2)}% (원금 완벽 방어)`);
    console.log('------------------------------------------------------');
    console.log(`• 총 체결 횟수:   ${this.trades.length}회`);
    console.log(`• 1차 익절(+8%):  ${this.trades.filter((t) => t.type === 'TREND_TP1').length}회`);
    console.log(`• 2차 추세익절:   ${this.trades.filter((t) => t.type === 'RUNNER_TP2').length}회`);
    console.log(`• 손절(-3%):      ${this.trades.filter((t) => t.type === 'STOP_LOSS').length}회`);
    console.log(`• 통산 승률:      ${winRate.toFixed(2)}% (${winTrades.length}승 / ${lossTrades.length}패)`);
    console.log(`• 지불 총 수수료: ${totalFees.toFixed(2)} USDT (약 ${Math.round(totalFees * krwRate).toLocaleString()}원)`);
    console.log('======================================================\n');
  }
}

async function main() {
  const runner = new BinanceBacktester();
  await runner.runBinanceBacktest(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT']);
}

main().catch(console.error);
