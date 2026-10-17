import { AsyncLocalStorage } from 'node:async_hooks';
export interface OperationScope { signal: AbortSignal; deadlineMs: number; abort?:()=>void }
const scope = new AsyncLocalStorage<OperationScope>();
export const currentOperation = () => scope.getStore();
export function stopOperation():void { scope.getStore()?.abort?.(); }
export function runInOperationScope<T>(value: OperationScope, fn: () => T): T {
  if (!Number.isFinite(value.deadlineMs)) throw Error('operation_deadline_invalid');
  return scope.run(value, fn);
}
export function remainingOperationMs(maximum: number, reserve = 0): number {
  const current = currentOperation();
  return Math.max(0, Math.min(maximum, current ? current.deadlineMs - Date.now() - reserve : maximum));
}
export function assertOperationActive(reserve = 0): void {
  const current = currentOperation();
  if (current && (current.signal.aborted || remainingOperationMs(Infinity, reserve) <= 0)) throw Error('operation_stopped');
}
