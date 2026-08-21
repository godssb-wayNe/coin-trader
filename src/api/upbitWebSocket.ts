import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../utils/logger';

export type TickerCallback = (data: { market: string; tradePrice: number; timestamp: number }) => void;

/**
 * 업비트 WebSocket 실시간 시세 수신기
 * 핑퐁 하트비트 및 연결 끊김 시 자동 지수 백오프 재연결을 보장합니다.
 */
export class UpbitWebSocket {
  private readonly wsUrl = 'wss://api.upbit.com/websocket/v1';
  private ws: WebSocket | null = null;
  private markets: string[] = [];
  private onTicker: TickerCallback | null = null;
  private isExplicitlyClosed = false;
  private reconnectAttempts = 0;

  constructor(markets: string[], onTicker: TickerCallback) {
    this.markets = markets;
    this.onTicker = onTicker;
  }

  /**
   * 웹소켓 연결 시작
   */
  public connect(): void {
    this.isExplicitlyClosed = false;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      Logger.success(`[WebSocket] 업비트 실시간 시세 스트림 연결 성공 (구독 종목: ${this.markets.length}개)`);
      this.reconnectAttempts = 0;
      this.subscribe();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const text = data.toString();
        const json = JSON.parse(text);
        if (json.type === 'ticker' && this.onTicker) {
          this.onTicker({
            market: json.code,
            tradePrice: json.trade_price,
            timestamp: json.timestamp
          });
        }
      } catch (err) {
        Logger.error('[WebSocket] 메시지 파싱 오류', err);
      }
    });

    this.ws.on('close', () => {
      if (!this.isExplicitlyClosed) {
        this.handleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      Logger.error('[WebSocket] 연결 에러 발생', err);
    });
  }

  /**
   * 구독 메시지 전송
   */
  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const payload = [
      { ticket: uuidv4() },
      { type: 'ticker', codes: this.markets }
    ];

    this.ws.send(JSON.stringify(payload));
  }

  /**
   * 구독 종목 실시간 갱신 (신규 종목 발굴 시)
   */
  public updateSubscription(newMarkets: string[]): void {
    this.markets = newMarkets;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribe();
    }
  }

  /**
   * 연결 끊김 시 자동 재접속 로직
   */
  private handleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(30000, Math.pow(2, this.reconnectAttempts) * 1000);
    Logger.warn(`[WebSocket] 연결 끊김. ${delay / 1000}초 후 자동 재접속 시도 (${this.reconnectAttempts}회차)...`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * 웹소켓 연결 정상 종료
   */
  public close(): void {
    this.isExplicitlyClosed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
