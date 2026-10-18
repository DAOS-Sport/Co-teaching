// UTC timestamps remain comparable across host timezones and include the date.
export const logTimestamp = (at = new Date()): string =>
  at.toISOString().replace("Z", "+00:00");
