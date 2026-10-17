export function wakeExecutionConfig(source:NodeJS.ProcessEnv=process.env) {
  const enabled=source.NOTIFICATION_WAKE_ENABLED==='true';
  const mode=source.NOTIFICATION_WAKE_MODE ?? 'canary';
  const notBefore=Date.parse(source.NOTIFICATION_WAKE_NOT_BEFORE ?? '');
  if(enabled && (source.NODE_ENV!=='production' || !['active','canary'].includes(mode) || !Number.isFinite(notBefore))) throw Error('wake_execution_config_invalid');
  if(enabled && mode==='active' && source.ENABLE_WEEKLY_PUSH_QUEUE!=='1')throw Error('wake_queue_disabled');
  return {enabled,mode:mode as 'active'|'canary',notBefore};
}
