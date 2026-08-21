/**
 * 콘솔 및 파일 로깅을 위한 정형화된 로거 모듈
 */
export class Logger {
  private static formatTime(): string {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }

  public static info(message: string, ...args: any[]): void {
    console.log(`[${this.formatTime()}] ℹ️ [INFO] ${message}`, ...args);
  }

  public static success(message: string, ...args: any[]): void {
    console.log(`[${this.formatTime()}] ✅ [SUCCESS] ${message}`, ...args);
  }

  public static warn(message: string, ...args: any[]): void {
    console.warn(`[${this.formatTime()}] ⚠️ [WARN] ${message}`, ...args);
  }

  public static error(message: string, error?: any): void {
    console.error(`[${this.formatTime()}] ❌ [ERROR] ${message}`, error || '');
  }

  public static trade(message: string, ...args: any[]): void {
    console.log(`[${this.formatTime()}] 💹 [TRADE] ${message}`, ...args);
  }
}
