/** Explicit deployment profile; imports normal HTTP only, never starts timers or performs SQL. */
if(process.env.NODE_ENV!=='production')throw Error('autoscale_profile_requires_production');
process.env.ENABLE_WEEKLY_PUSH_QUEUE??='1';
process.env.ENABLE_WEEKLY_PUSH_WORKER??='0';
process.env.NOTIFICATION_WAKE_ENABLED??='true';
process.env.NOTIFICATION_WAKE_MODE??='canary';
process.env.NOTIFICATION_WAKE_AUDIENCE??='https://swim-scheduler-ronchen2.replit.app/api/internal/notification-wake';
process.env.NOTIFICATION_WAKE_NOT_BEFORE??='2026-10-17T09:00:00Z';
export const webServerReady=import('./index').then(module=>module.webServerReady);
