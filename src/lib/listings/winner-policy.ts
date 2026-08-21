export const WINNER_ACTIVE_WINDOW_DAYS = 7;
export const WINNER_MIN_PROFITABLE_UNITS = 3;
export const WINNER_MIN_SALE_DAYS = 2;

export type WinnerOrderFacts = {
  saleDate: Date;
  quantity: number;
  profitCents: number;
};

export type VerifiedWinnerStatus = {
  isWinner: boolean;
  profitableUnits: number;
  profitableSaleDays: number;
  lastProfitableSaleAt: Date | null;
  protectedUntil: Date | null;
};

export type ProfitableSaleLockStatus = {
  isLocked: boolean;
  profitableUnits: number;
  lastProfitableSaleAt: Date | null;
  protectedUntil: Date | null;
};

/**
 * A listing becomes a verified winner after at least three profitable units
 * sold across at least two different days. It keeps the winner lock while it
 * has produced a profitable sale during the trailing seven days.
 */
export function assessVerifiedWinner(
  orders: WinnerOrderFacts[],
  now = new Date(),
): VerifiedWinnerStatus {
  const profitable = orders.filter((order) => order.quantity > 0 && order.profitCents > 0);
  const profitableUnits = profitable.reduce((total, order) => total + order.quantity, 0);
  const profitableSaleDays = new Set(
    profitable.map((order) => order.saleDate.toISOString().slice(0, 10)),
  ).size;
  const lastProfitableSaleAt = profitable.reduce<Date | null>(
    (latest, order) => !latest || order.saleDate > latest ? order.saleDate : latest,
    null,
  );
  const protectedUntil = lastProfitableSaleAt
    ? new Date(lastProfitableSaleAt.getTime() + WINNER_ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    : null;
  const established = profitableUnits >= WINNER_MIN_PROFITABLE_UNITS
    && profitableSaleDays >= WINNER_MIN_SALE_DAYS;

  return {
    isWinner: established && protectedUntil !== null && protectedUntil >= now,
    profitableUnits,
    profitableSaleDays,
    lastProfitableSaleAt,
    protectedUntil,
  };
}

/** A separate, user-controlled price lock that starts after one profitable
 * sale. This does not grant Verified Winner status. */
export function assessProfitableSalePriceLock(
  orders: WinnerOrderFacts[],
  now = new Date(),
): ProfitableSaleLockStatus {
  const profitable = orders.filter((order) => order.quantity > 0 && order.profitCents > 0);
  const profitableUnits = profitable.reduce((total, order) => total + order.quantity, 0);
  const lastProfitableSaleAt = profitable.reduce<Date | null>(
    (latest, order) => !latest || order.saleDate > latest ? order.saleDate : latest,
    null,
  );
  const protectedUntil = lastProfitableSaleAt
    ? new Date(lastProfitableSaleAt.getTime() + WINNER_ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    : null;
  return {
    isLocked: profitableUnits >= 1 && protectedUntil !== null && protectedUntil >= now,
    profitableUnits,
    lastProfitableSaleAt,
    protectedUntil,
  };
}
