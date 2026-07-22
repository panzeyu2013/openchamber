import { describe, expect, mock, test } from 'bun:test';

const invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let invokeResult: unknown = [];

mock.module('@/lib/desktop', () => ({
  hasDesktopInvoke: mock(() => true),
  getDesktopHomeDirectory: mock(async () => null),
  invokeDesktop: mock((command: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ command, args });
    return Promise.resolve(invokeResult);
  }),
}));

const { desktopSshInstanceSummariesGet } = await import(`./desktopSsh?test=${Date.now()}`);

describe('desktop SSH helpers', () => {
  test('loads SSH instance summaries without requiring full instance secrets', async () => {
    invokeCalls.length = 0;
    invokeResult = [
      { id: 'ssh-1', sshCommand: 'ssh prod', auth: { sshPassword: { value: 'secret' } } },
      { id: '' },
      { id: 'ssh-2' },
      null,
    ];

    const summaries = await desktopSshInstanceSummariesGet();

    expect(summaries).toEqual([{ id: 'ssh-1' }, { id: 'ssh-2' }]);
    expect(invokeCalls).toEqual([{ command: 'desktop_ssh_instance_summaries_get', args: undefined }]);
  });
});
