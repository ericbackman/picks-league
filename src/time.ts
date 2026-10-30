// Eastern Time helpers. A sports "day" is an ET calendar day no matter where the
// Worker runs or who is looking, so every day boundary goes through here. Pure:
// fixed Dates in, strings out, which is what makes the DST cases testable.
// tick.ts re-exports them.

const ET = "America/New_York"; // sports schedule "days" are Eastern Time

export function etParts(now: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10),
  };
}

export function fmtEt(iso: string): string {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return "TBD";
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(dt);
  return `${text} ET`;
}

export function prettyDay(day: string): string {
  const dt = new Date(`${day}T12:00:00Z`); // noon UTC: same calendar day in any zone
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(dt);
}

export function yyyymmdd(day: string): string {
  return day.replaceAll("-", "");
}

/** Strict YYYY-MM-DD that also round-trips through the calendar (no Feb 30). */
export function isCalendarDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const dt = new Date(`${day}T12:00:00Z`);
  return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === day;
}

/** The calendar day `offset` days away from `day` (negative for earlier). */
export function shiftDay(day: string, offset: number): string {
  const dt = new Date(`${day}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + offset);
  return dt.toISOString().slice(0, 10);
}
