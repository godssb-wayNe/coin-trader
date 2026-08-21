import { TRADING_CONSTANTS } from '../config/constants';
import { TradeRepository } from '../data/repository';

export interface FrequencyCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * 거래 빈도 및 쿨다운 관리자
 * 횡보장에서 잦은 진입으로 수수료가 낭비되는 오버트레이딩을 원천 차단합니다.
 */
export class TradeFrequencyController {
  private hourlyTradeTimes: number[] = [];
  private dailyTradeTimes: number[] = [];

  /**
   * 신규 매수 주문 발송 전 제약 조건 검증
   */
  public canExecuteBuy(market: string): FrequencyCheck {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // 1. 기간 만료된 카운터 필터링
    this.hourlyTradeTimes = this.hourlyTradeTimes.filter((t) => t > oneHourAgo);
    this.dailyTradeTimes = this.dailyTradeTimes.filter((t) => t > oneDayAgo);

    // 2. 시간당 최대 거래 수 제한 (최대 2회)
    if (this.hourlyTradeTimes.length >= TRADING_CONSTANTS.MAX_TRADES_PER_HOUR) {
      return {
        allowed: false,
        reason: `[빈도 제한] 최근 1시간 최대 진입 한도(${TRADING_CONSTANTS.MAX_TRADES_PER_HOUR}회) 도달`
      };
    }

    // 3. 1일 최대 거래 수 제한 (최대 6회)
    if (this.dailyTradeTimes.length >= TRADING_CONSTANTS.MAX_TRADES_PER_DAY) {
      return {
        allowed: false,
        reason: `[빈도 제한] 오늘 일일 최대 진입 한도(${TRADING_CONSTANTS.MAX_TRADES_PER_DAY}회) 도달`
      };
    }

    // 4. 종목별 쿨다운(60분) 확인
    const cooldownUntil = TradeRepository.getMarketCooldown(market);
    if (cooldownUntil && now < cooldownUntil) {
      const remainMins = Math.ceil((cooldownUntil - now) / 60000);
      return {
        allowed: false,
        reason: `[쿨다운] ${market} 청산 후 재진입 대기 중 (${remainMins}분 남음)`
      };
    }

    return { allowed: true };
  }

  /**
   * 매수 체결 성공 시 타임스탬프 기록
   */
  public recordTrade(): void {
    const now = Date.now();
    this.hourlyTradeTimes.push(now);
    this.dailyTradeTimes.push(now);
  }

  /**
   * 포지션 청산 시 60분 쿨다운 설정
   */
  public applyCooldown(market: string): void {
    const cooldownUntil = Date.now() + TRADING_CONSTANTS.COOLDOWN_DURATION_MS;
    TradeRepository.setMarketCooldown(market, cooldownUntil);
  }
}
