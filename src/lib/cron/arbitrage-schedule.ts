export const ARBITRAGE_DAILY_TARGET = 500;
export const ARBITRAGE_CRON_TIME_ZONE = "America/Los_Angeles";

export function getLosAngelesCronTime(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ARBITRAGE_CRON_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour")),
  };
}

export function shouldRunDailyArbitrageCron(now = new Date()) {
  return getLosAngelesCronTime(now).hour === 3;
}
