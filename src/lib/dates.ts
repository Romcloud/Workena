export const APP_TIME_ZONE = "Europe/Bratislava";

function timezoneOffsetMinutes(date: Date) {
  const name = new Intl.DateTimeFormat("en", {
    timeZone: APP_TIME_ZONE,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const match = name?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "+" ? minutes : -minutes;
}

export function localDayBoundary(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const localMidnightAsUtc = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(localMidnightAsUtc.getTime()) || localMidnightAsUtc.toISOString().slice(0, 10) !== value) {
    return undefined;
  }
  return new Date(localMidnightAsUtc.getTime() - timezoneOffsetMinutes(localMidnightAsUtc) * 60_000);
}

export function nextLocalDayBoundary(value: string) {
  const start = localDayBoundary(value);
  if (!start) return undefined;
  const nextDay = new Date(`${value}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return localDayBoundary(nextDay.toISOString().slice(0, 10));
}
