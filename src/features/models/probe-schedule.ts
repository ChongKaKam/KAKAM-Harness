// China Standard Time does not observe daylight saving time. Keeping the
// schedule independent of the host timezone makes Docker and local runs agree.
const shanghaiOffsetMs = 8 * 60 * 60_000;
const hourMs = 60 * 60_000;
const dayMs = 24 * hourMs;
const daytimeHours = [8, 10, 12, 14, 16, 18];

export function nextSourceProbeDelay(now = new Date()): number {
  const localTime = now.getTime() + shanghaiOffsetMs;
  const local = new Date(localTime);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const nextHour = daytimeHours.find((hour) => midnight + hour * hourMs > localTime);
  const next =
    nextHour === undefined
      ? midnight + dayMs + daytimeHours[0] * hourMs
      : midnight + nextHour * hourMs;
  return next - localTime;
}
