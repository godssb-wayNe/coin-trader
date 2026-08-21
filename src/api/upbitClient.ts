import axios, { AxiosInstance } from 'axios';
import { UpbitAuth } from './upbitAuth';
import { RateLimiter } from '../utils/rateLimiter';
import { Candle, Orderbook, AccountBalance } from '../data/models';
import { Logger } from '../utils/logger';
import { config } from '../config';

/**
 * 업비트 REST API 클라이언트
 * 시세 조회(Quotation) 및 계좌/주문(Exchange) 연동을 총괄합니다.
 */
export class UpbitClient {
  private readonly baseUrl = 'https://api.upbit.com';
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly isPaperTrading: boolean;
  private paperBalanceKrw: number;

  constructor(accessKey?: string, secretKey?: string, isPaperTrading: boolean = true) {
    this.accessKey = accessKey || config.upbit.accessKey;
    this.secretKey = secretKey || config.upbit.secretKey;
    this.isPaperTrading = isPaperTrading;
    this.paperBalanceKrw = config.trading.initialPaperBalanceKrw;
  }

  /**
   * KRW 마켓 전체 목록 및 유의종목 상태 조회
   */
  public async getKrwMarkets(): Promise<Array<{ market: string; koreanName: string; isWarning: boolean }>> {
    return RateLimiter.schedule(async () => {
      const response = await axios.get(`${this.baseUrl}/v1/market/all?isDetails=true`);
      return response.data
        .filter((item: any) => item.market.startsWith('KRW-'))
        .map((item: any) => ({
          market: item.market,
          koreanName: item.korean_name,
          isWarning: item.market_warning === 'CAUTION'
        }));
    });
  }

  /**
   * 분봉 캔들 조회 (15분봉, 60분봉 등)
   */
  public async getMinuteCandles(market: string, unit: 15 | 60 | 240 = 15, count: number = 100): Promise<Candle[]> {
    return RateLimiter.schedule(async () => {
      const response = await axios.get(`${this.baseUrl}/v1/candles/minutes/${unit}`, {
        params: { market, count }
      });

      // 최신순으로 오는 데이터를 과거 -> 최신순(오름차순)으로 정렬하여 반환
      return response.data.reverse().map((c: any) => ({
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
    });
  }

  /**
   * 호가창(Orderbook) 조회
   */
  public async getOrderbook(market: string): Promise<Orderbook> {
    return RateLimiter.schedule(async () => {
      const response = await axios.get(`${this.baseUrl}/v1/orderbook`, {
        params: { markets: market }
      });
      const data = response.data[0];
      return {
        market: data.market,
        timestamp: data.timestamp,
        totalAskSize: data.total_ask_size,
        totalBidSize: data.total_bid_size,
        orderbookUnits: data.orderbook_units.map((u: any) => ({
          askPrice: u.ask_price,
          bidPrice: u.bid_price,
          askSize: u.ask_size,
          bidSize: u.bid_size
        }))
      };
    });
  }

  /**
   * 계좌 잔고 조회 (실전 vs 모의 매매)
   */
  public async getAccounts(): Promise<AccountBalance[]> {
    if (this.isPaperTrading) {
      return [
        { currency: 'KRW', balance: this.paperBalanceKrw, locked: 0, avgBuyPrice: 0 }
      ];
    }

    return RateLimiter.schedule(async () => {
      const token = UpbitAuth.generateToken(this.accessKey, this.secretKey);
      const response = await axios.get(`${this.baseUrl}/v1/accounts`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      return response.data.map((acc: any) => ({
        currency: acc.currency,
        balance: parseFloat(acc.balance),
        locked: parseFloat(acc.locked),
        avgBuyPrice: parseFloat(acc.avg_buy_price)
      }));
    });
  }

  /**
   * 매수 주문 집행 (지정가/시장가)
   */
  public async placeBuyOrder(market: string, priceKrw: number, volume: number): Promise<{ orderId: string; executedPrice: number }> {
    if (this.isPaperTrading) {
      const totalCost = priceKrw * volume;
      this.paperBalanceKrw -= totalCost;
      Logger.trade(`[모의 매수 체결] ${market} 수량: ${volume} 체결가: ${priceKrw.toLocaleString()}원 (잔액: ${this.paperBalanceKrw.toLocaleString()}원)`);
      return { orderId: `paper-buy-${Date.now()}`, executedPrice: priceKrw };
    }

    return RateLimiter.schedule(async () => {
      const body = {
        market,
        side: 'bid',
        volume: volume.toString(),
        price: priceKrw.toString(),
        ord_type: 'limit'
      };

      const token = UpbitAuth.generateToken(this.accessKey, this.secretKey, body);
      const response = await axios.post(`${this.baseUrl}/v1/orders`, body, {
        headers: { Authorization: `Bearer ${token}` }
      });

      Logger.trade(`[실전 매수 접수] ${market} 주문ID: ${response.data.uuid}`);
      return { orderId: response.data.uuid, executedPrice: priceKrw };
    });
  }

  /**
   * 매도 주문 집행 (지정가/시장가)
   */
  public async placeSellOrder(market: string, volume: number, priceKrw: number): Promise<{ orderId: string; executedPrice: number }> {
    if (this.isPaperTrading) {
      const proceeds = priceKrw * volume;
      this.paperBalanceKrw += proceeds;
      Logger.trade(`[모의 매도 체결] ${market} 수량: ${volume} 체결가: ${priceKrw.toLocaleString()}원 (잔액: ${this.paperBalanceKrw.toLocaleString()}원)`);
      return { orderId: `paper-sell-${Date.now()}`, executedPrice: priceKrw };
    }

    return RateLimiter.schedule(async () => {
      const body = {
        market,
        side: 'ask',
        volume: volume.toString(),
        price: priceKrw.toString(),
        ord_type: 'limit'
      };

      const token = UpbitAuth.generateToken(this.accessKey, this.secretKey, body);
      const response = await axios.post(`${this.baseUrl}/v1/orders`, body, {
        headers: { Authorization: `Bearer ${token}` }
      });

      Logger.trade(`[실전 매도 접수] ${market} 주문ID: ${response.data.uuid}`);
      return { orderId: response.data.uuid, executedPrice: priceKrw };
    });
  }
}
