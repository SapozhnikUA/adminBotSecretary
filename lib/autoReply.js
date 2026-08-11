function getCurrentHour(timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Europe/Kyiv',
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(formatter.format(new Date()), 10);
}

function getAutoReplyText(config) {
  const hour = getCurrentHour(config.timezone);
  const schedule = config.schedules.find((s) =>
    s.from <= s.to ? hour >= s.from && hour < s.to : hour >= s.from || hour < s.to
  );
  return schedule ? schedule.text : 'Адміністратора наразі немає на місці.';
}

module.exports = { getCurrentHour, getAutoReplyText };
