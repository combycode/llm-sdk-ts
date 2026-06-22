/** Scheduler — durable task scheduling. Tasks survive restarts when backed
 *  by a Persistence implementation. Functions registered by name; tasks are
 *  `{ name, args, fireAt }`. */

import type { Persistence } from '../persistence/types';

export interface ScheduledTaskDef {
  id: string;
  name: string;
  args: Record<string, unknown>;
  fireAt: number;
  type: 'once' | 'periodic';
  interval: number | null;
}

export class Scheduler {
  private persistence: Persistence;
  private handlers = new Map<string, (args: Record<string, unknown>) => void | Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(persistence: Persistence) {
    this.persistence = persistence;
  }

  register(name: string, fn: (args: Record<string, unknown>) => void | Promise<void>): void {
    this.handlers.set(name, fn);
  }

  async after(
    duration: string | number,
    taskName: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const delayMs = parseDuration(duration);
    const task: ScheduledTaskDef = {
      id: `task_${crypto.randomUUID().slice(0, 8)}`,
      name: taskName,
      args,
      fireAt: Date.now() + delayMs,
      type: 'once',
      interval: null,
    };
    await this.persistence.set(`task:${task.id}`, task);
    if (this.running) this.scheduleTimer(task);
    return task.id;
  }

  async at(
    datetime: Date | number,
    taskName: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const fireAt = typeof datetime === 'number' ? datetime : datetime.getTime();
    const task: ScheduledTaskDef = {
      id: `task_${crypto.randomUUID().slice(0, 8)}`,
      name: taskName,
      args,
      fireAt,
      type: 'once',
      interval: null,
    };
    await this.persistence.set(`task:${task.id}`, task);
    if (this.running) this.scheduleTimer(task);
    return task.id;
  }

  async every(
    interval: string | number,
    taskName: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const intervalMs = parseDuration(interval);
    const task: ScheduledTaskDef = {
      id: `task_${crypto.randomUUID().slice(0, 8)}`,
      name: taskName,
      args,
      fireAt: Date.now() + intervalMs,
      type: 'periodic',
      interval: intervalMs,
    };
    await this.persistence.set(`task:${task.id}`, task);
    if (this.running) this.scheduleTimer(task);
    return task.id;
  }

  async cancel(taskId: string): Promise<void> {
    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
    await this.persistence.delete(`task:${taskId}`);
  }

  async start(): Promise<void> {
    this.running = true;
    const keys = await this.persistence.list('task:');
    for (const key of keys) {
      const task = await this.persistence.get<ScheduledTaskDef>(key);
      if (!task) continue;
      this.scheduleTimer(task);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  async pending(): Promise<ScheduledTaskDef[]> {
    const keys = await this.persistence.list('task:');
    const tasks: ScheduledTaskDef[] = [];
    for (const key of keys) {
      const task = await this.persistence.get<ScheduledTaskDef>(key);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  private scheduleTimer(task: ScheduledTaskDef): void {
    const now = Date.now();
    const delay = Math.max(0, task.fireAt - now);

    const timer = setTimeout(async () => {
      this.timers.delete(task.id);
      await this.fireTask(task);
    }, delay);

    this.timers.set(task.id, timer);
  }

  private async fireTask(task: ScheduledTaskDef): Promise<void> {
    const handler = this.handlers.get(task.name);
    if (!handler) return;

    try {
      await handler(task.args);
    } catch (e) {
      console.error(`Scheduler: task ${task.name}(${task.id}) failed:`, e);
    }

    if (task.type === 'periodic' && task.interval) {
      task.fireAt = Date.now() + task.interval;
      await this.persistence.set(`task:${task.id}`, task);
      if (this.running) this.scheduleTimer(task);
    } else {
      await this.persistence.delete(`task:${task.id}`);
    }
  }
}

/** Parse duration string ('30s', '5m', '1h', '2d') or raw number (ms) into ms. */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') return input;
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) {
    const n = Number.parseInt(input, 10);
    if (!Number.isNaN(n)) return n;
    throw new Error(`Invalid duration: "${input}". Use: 30s, 5m, 1h, 2d, or number (ms)`);
  }
  const value = Number.parseFloat(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    case 'd':
      return value * 86_400_000;
    default:
      return value;
  }
}
