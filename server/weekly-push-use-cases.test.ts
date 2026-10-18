import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeeklyPushUseCases } from './core/weekly-push/use-cases';
import type { WeeklyPushDependencies, WeeklyRun } from './core/weekly-push/ports';

const window = { weekStartDate: '2030-01-07', weekEndDate: '2030-01-13' };
const coach = { id: 'fixture-coach', name: 'Fixture Coach', linkedCoachName: null, lineId: 'fixture-line' };
const schedule = { date: '2030-01-08', coachName: coach.name, coachName2: null,
  venue: { name: 'Fixture Venue' }, timeSlot: { startTime: '09:00', endTime: '10:00', order: 1 }, className: null };
function fixture() {
  const events: string[] = [], bundles: any[] = [];
  let keys = 0, instant = 1000;
  let run: WeeklyRun | null = null;
  let failed = [{ id: 'failed-id', status: 'failed' }];
  const deps: WeeklyPushDependencies<WeeklyRun> = {
    roster: { approvedCoaches: async () => [coach], schedules: async () => [schedule] },
    repository: {
      findByKey: async () => run, hasLegacyHistory: async () => false,
      createBundle: async (input, recipients) => { bundles.push({ input, recipients }); return { run: input, created: true, recipientsCreated: recipients.length }; },
      getRun: async () => run, failedRecipients: async () => failed,
      resetRecipient: async id => { events.push('reset:' + id); },
      markSending: async id => { events.push('sending:' + id); },
    },
    transaction: { run: async work => { events.push('begin'); try { const result = await work(); events.push('commit'); return result; } catch (error) { events.push('rollback'); throw error; } } },
    queue: { enqueueRecipient: async (runId, id, manual) => { events.push(`queue:${runId}:${id}:${manual}`); },
      flushCommitted: async () => { events.push('flush'); } },
    clock: { now: () => instant, defaultWeek: () => window },
    newId: () => 'fixture-key-' + ++keys,
    message: (_name, items) => `fixture-message:${items.length}`,
  };
  return { deps, events, bundles, useCases: createWeeklyPushUseCases(deps),
    keys: () => keys, setNow: (value: number) => { instant = value; },
    setRun: (value: WeeklyRun) => { run = value; }, setFailed: (value: typeof failed) => { failed = value; } };
}
test('weekly core commits one bundle with original identities and a frozen payload', async () => {
  const f = fixture(); const result = await f.useCases.enqueue(window);
  assert.equal(result.reused, false); assert.equal(result.recipientsCreated, 1);
  const { input, recipients } = f.bundles[0];
  assert.equal(input.idempotencyKey, 'weekly-send:2030-01-07:coaches');
  assert.equal(recipients[0].deliveryKey, 'weekly:2030-01-07:fixture-coach');
  assert.equal(recipients[0].lineRetryKey, 'fixture-key-2');
  assert.deepEqual(recipients[0].payloadJson, { message: 'fixture-message:1', scheduleCount: 1, messageVersion: 1, capturedAt: '1970-01-01T00:00:01.000Z' });
  assert.deepEqual(f.events, ['flush']);
});
test('durable replay precedes roster/history/deadline and generates no identity', async () => {
  const f = fixture(); const run: WeeklyRun = { id: 'existing', dryRun: false };
  f.setRun(run); f.deps.repository.hasLegacyHistory = async () => { throw Error('must not read'); };
  f.deps.roster.approvedCoaches = async () => { throw Error('must not rebuild'); };
  const result = await f.useCases.enqueue({ ...window, latestCreateAt: 0 });
  assert.equal(result.run, run); assert.equal(result.reused, true); assert.equal(f.keys(), 0); assert.deepEqual(f.events, []);
});
test('wet legacy history fails before any new identity or bundle', async () => {
  const f = fixture(); f.deps.repository.hasLegacyHistory = async () => true;
  await assert.rejects(f.useCases.enqueue(window), /weekly_push_legacy_history_blocked/);
  assert.equal(f.keys(), 0); assert.equal(f.bundles.length, 0);
});
test('dry run bypasses legacy history and retains separate preview identity', async () => {
  const f = fixture(); f.deps.repository.hasLegacyHistory = async () => { throw Error('must not read'); };
  await f.useCases.enqueue({ ...window, dryRun: true });
  assert.equal(f.bundles[0].input.idempotencyKey, 'weekly-preview:2030-01-07:coaches');
  assert.equal(f.bundles[0].recipients[0].status, 'skipped');
});
test('a racing winner reuses the committed bundle and does not dispatch', async () => {
  const f = fixture(); f.deps.repository.createBundle = async input => ({ run: input, created: false, recipientsCreated: 0 });
  const result = await f.useCases.enqueue(window);
  assert.equal(result.reused, true); assert.equal(result.recipientsCreated, 0); assert.deepEqual(f.events, []);
});
for (const deadline of [1000, 999, NaN, Infinity]) test(`slot deadline ${deadline} fails before writing`, async () => {
  const f = fixture(); await assert.rejects(f.useCases.enqueue({ ...window, latestCreateAt: deadline }), /weekly_push_slot_expired/);
  assert.equal(f.bundles.length, 0); assert.deepEqual(f.events, []);
});
test('deadline is rechecked after a slow roster read', async () => {
  const f = fixture(); f.deps.roster.schedules = async () => { f.setNow(2000); return [schedule]; };
  await assert.rejects(f.useCases.enqueue({ ...window, latestCreateAt: 1500 }), /weekly_push_slot_expired/);
  assert.equal(f.bundles.length, 0);
});
test('same-name distinct accounts fail closed before generating identities', async () => {
  const f = fixture(); f.deps.roster.approvedCoaches = async () => [coach, { ...coach, id: 'other' }];
  await assert.rejects(f.useCases.enqueue(window), /weekly_push_ambiguous_scheduled_coach/);
  assert.equal(f.keys(), 0); assert.equal(f.bundles.length, 0);
});
test('placeholder and unbound accounts are excluded; secondary slot matches once', async () => {
  const f = fixture(); f.deps.roster.approvedCoaches = async () => [coach, { ...coach, id: 'unbound', lineId: null }, { ...coach, id: 'vacant', name: '000' }];
  f.deps.roster.schedules = async () => [{ ...schedule, coachName: coach.name, coachName2: coach.name }];
  const recipients = await f.useCases.buildRecipients(window.weekStartDate, window.weekEndDate);
  assert.equal(recipients.length, 1); assert.equal(recipients[0].scheduleCount, 1);
});
test('failed retry keeps the original run and queues only failed ids inside one transaction', async () => {
  const f = fixture(); const run = { id: 'original', dryRun: false }; f.setRun(run);
  const result = await f.useCases.retryFailed('original');
  assert.equal(result.run, run); assert.equal(result.reused, true); assert.equal(f.keys(), 0);
  assert.deepEqual(f.events, ['begin', 'reset:failed-id', 'queue:original:failed-id:true', 'sending:original', 'commit']);
});
test('retry queue failure propagates through transaction rollback', async () => {
  const f = fixture(); f.setRun({ id: 'original', dryRun: false });
  f.deps.queue.enqueueRecipient = async () => { throw Error('queue unavailable'); };
  await assert.rejects(f.useCases.retryFailed('original'), /queue unavailable/);
  assert.deepEqual(f.events, ['begin', 'reset:failed-id', 'rollback']);
});
test('missing run or no failed recipients performs no retry writes', async () => {
  const f = fixture(); await assert.rejects(f.useCases.retryFailed('missing'), /not found/);
  f.setRun({ id: 'original', dryRun: false }); f.setFailed([]);
  await assert.rejects(f.useCases.retryFailed('original'), /no failed recipients/);
  assert.equal(f.events.filter(event => event.startsWith('reset:') || event.startsWith('queue:')).length, 0);
});
test('default week comes from the calendar port and keeps manual as default source', async () => {
  const f = fixture(); await f.useCases.enqueue();
  assert.equal(f.bundles[0].input.weekStartDate, window.weekStartDate);
  assert.equal(f.bundles[0].input.weekEndDate, window.weekEndDate);
  assert.equal(f.bundles[0].input.triggerSource, 'manual');
});
test('no bound coach means no schedule read and an empty recipient bundle', async () => {
  const f = fixture(); f.deps.roster.approvedCoaches = async () => [];
  f.deps.roster.schedules = async () => { throw Error('must not read'); };
  await f.useCases.enqueue(window); assert.equal(f.bundles[0].recipients.length, 0);
});
test('bundle failure propagates without dispatching committed work', async () => {
  const f = fixture(); f.deps.repository.createBundle = async () => { throw Error('atomic commit failed'); };
  await assert.rejects(f.useCases.enqueue(window), /atomic commit failed/);
  assert.deepEqual(f.events, []);
});
test('linked name and secondary slot preserve exact matching and source order', async () => {
  const f = fixture(); f.deps.roster.approvedCoaches = async () => [{ ...coach, name: 'Other', linkedCoachName: coach.name }];
  f.deps.roster.schedules = async () => [{ ...schedule, coachName: null, coachName2: coach.name },
    { ...schedule, date: '2030-01-09', coachName: coach.name + ' ', coachName2: null }];
  const recipients = await f.useCases.buildRecipients(window.weekStartDate, window.weekEndDate);
  assert.equal(recipients.length, 1); assert.equal(recipients[0].recipientName, coach.name);
  assert.equal(recipients[0].scheduleCount, 1);
});
