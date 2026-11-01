// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { testTask } from '@/test/compute';
import { createTaskRegistry, TaskRegistryError } from './registry';

describe('createTaskRegistry', () => {
  it('looks tasks up by type, and by exact version', () => {
    const registry = createTaskRegistry([testTask(), testTask({ type: 'test.other', version: 2 })]);

    expect(registry.get('test.double')?.version).toBe(1);
    expect(registry.find('test.other', 2)?.type).toBe('test.other');
    expect(registry.find('test.other', 1)).toBeUndefined();
    expect(registry.get('test.missing')).toBeUndefined();
  });

  it('lists tasks in a stable order', () => {
    const registry = createTaskRegistry([testTask({ type: 'b.task' }), testTask({ type: 'a.task' })]);
    expect(registry.list().map((task) => task.type)).toEqual(['a.task', 'b.task']);
  });

  it('refuses the same type twice', () => {
    expect(() => createTaskRegistry([testTask(), testTask({ version: 2 })])).toThrow(
      /registered more than once/,
    );
  });

  it('reports every problem at once', () => {
    let error: unknown;
    try {
      createTaskRegistry([
        testTask({ type: 'nodots' }),
        testTask({ type: 'test.limits', limits: { timeoutMs: 0, maxAttempts: 99, maxParamsBytes: 1, maxOutputBytes: 1 } }),
        testTask({ type: 'test.roles', access: { roles: [], system: false } }),
        testTask({ type: 'test.runtime', runtime: 'python' as never }),
      ]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TaskRegistryError);
    const issues = (error as TaskRegistryError).issues;
    expect(issues.some((issue) => issue.startsWith('nodots: type'))).toBe(true);
    expect(issues.filter((issue) => issue.startsWith('test.limits:'))).toHaveLength(4);
    expect(issues.some((issue) => issue.includes('no role and no system process'))).toBe(true);
    expect(issues.some((issue) => issue.includes('runtime must be "node"'))).toBe(true);
  });

  it('rejects unknown roles', () => {
    expect(() =>
      createTaskRegistry([testTask({ access: { roles: ['superuser' as never], system: false } })]),
    ).toThrow(/unknown role "superuser"/);
  });
});
