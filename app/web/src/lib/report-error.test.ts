import { describe, expect, it, vi } from 'vitest';

describe('while the page reloads for a new build', () => {
  it('a screen whose old chunk is gone is not reported: the reload is doing its job', async () => {
    vi.resetModules();
    const m = await import('@/lib/report-error');
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    m.reloadingForBuild();
    m.reportError({ message: "Cannot read properties of undefined (reading 'SettingsScreen')", where: 'This screen' });
    await new Promise((r) => setTimeout(r, 0));
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });
});
