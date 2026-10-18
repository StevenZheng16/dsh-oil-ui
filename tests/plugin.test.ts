import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import SkillRegistry, { type SkillRegistration, type SkillProvider } from '@deepseek-ai/dsh-skill';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { apply } from '../src/index.ts';
import { skillStatus } from '../src/upstream.ts';

const localHome = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => localHome.path || os.homedir() };
});

it('registers 5 native Harness tools, validates their schemas and operates directly in session cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oil-plugin-'));
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { name: string; handler: (inv: unknown) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string } }>();
  const pending: Promise<unknown>[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  let registration: SkillRegistration | undefined;
  let prompt = '';
  const ctx = {
    effect(fn: () => () => void | Promise<void>) {
      disposers.push(fn());
    },
    inject(_services: string[], fn: (ctx: unknown) => unknown) {
      pending.push(Promise.resolve(fn(ctx)));
    },
    tools: {
      register(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
    },
    commands: {
      register(cmd: { name: string; handler: (inv: unknown) => Promise<{ kind: string; text?: string }> | { kind: string; text?: string } }) {
        commands.set(cmd.name, cmd);
        return () => {
          commands.delete(cmd.name);
        };
      },
    },
    skills: {
      register(skill: SkillRegistration) {
        registration = skill;
      },
      get: async () => registration,
    },
    systemPrompt: {
      section(section: { text: string }) {
        prompt = section.text;
      },
    },
  };
  const followupMessages: unknown[] = [];
  const exec = {
    agent: {
      session: { id: 'alice', header: { cwd: root } },
      followup(msg: unknown) {
        followupMessages.push(msg);
      },
    },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
  const run = async (name: string, args: Record<string, unknown>) => tools.get(name)!.execute(args, exec);
  try {
    apply(ctx as unknown as Context, { previewPort: 0, preferPro: false });
    await Promise.all(pending);
    expect([...tools.keys()].sort()).toEqual(
      ['oil_ui_explorer', 'oil_ui_image', 'oil_ui_media', 'oil_ui_shoot', 'oil_ui_skill_status'].sort(),
    );
    expect([...commands.keys()].sort()).toEqual(['oil-ui-explore', 'oil-ui-review', 'oil-ui-status']);
    const statusCmd = await commands.get('oil-ui-status')!.handler({
      agent: exec.agent,
      rawInput: '',
      attachments: [],
      signal: exec.signal,
    });
    expect(statusCmd).toMatchObject({ kind: 'success' });
    expect(statusCmd.text).toContain('当前生效 Skill：oil-ui（Lite）');
    const exploreCmd = await commands.get('oil-ui-explore')!.handler({
      agent: exec.agent,
      rawInput: ' Hero landing page',
      attachments: [],
      signal: exec.signal,
    });
    expect(exploreCmd).toMatchObject({ kind: 'success' });
    expect(followupMessages).toHaveLength(1);
    expect(registration?.name).toBe('oil-ui');
    expect(prompt).toContain('activeSkillName');
    expect(prompt).toContain('without restarting');
    expect(prompt).not.toContain('ADAPTER.md');
    expect(prompt).not.toContain('shoot.mjs');
    expect(await run('oil_ui_skill_status', {})).toMatchObject({
      edition: 'lite',
      activeSkillName: 'oil-ui',
      visibleMatchesOriginal: true,
    });
    expect(tools.get('oil_ui_skill_status')!.isConcurrencySafe?.({})).toBe(true);
    expect(tools.get('oil_ui_media')!.isConcurrencySafe?.({ action: 'search', query: 'ceramic' })).toBe(true);
    expect(tools.get('oil_ui_media')!.isConcurrencySafe?.({ action: 'search', query: 'ceramic', out: 'res.json' })).toBe(
      false,
    );
    expect(tools.get('oil_ui_media')!.isConcurrencySafe?.({ action: 'fetch', refs: '1,2' })).toBe(false);
    for (const name of ['oil_ui_explorer', 'oil_ui_shoot', 'oil_ui_image']) {
      expect(tools.get(name)!.isConcurrencySafe?.({}) ?? false).toBe(false);
    }

    await expect(run('oil_ui_image', {})).rejects.toThrow();
    await expect(run('oil_ui_image', { prompt: '' })).rejects.toThrow('prompt');

    await mkdir(join(root, 'explore'), { recursive: true });
    for (const direction of ['a', 'b', 'c']) {
      await writeFile(join(root, `explore/${direction}.html`), `<title>${direction}</title>`);
    }
    expect(await run('oil_ui_explorer', { title: 'Native explorer', request: 'Compare designs' })).toMatchObject({
      ok: true,
      explorerPath: 'style-explorer.html',
    });

    await expect(run('oil_ui_shoot', { viewport: 'invalid' })).rejects.toThrow('viewport');
    await expect(run('oil_ui_media', { query: '' })).rejects.toThrow('query');
    await expect(run('oil_ui_media', {})).rejects.toThrow('query');
    await expect(tools.get('oil_ui_explorer')!.execute({}, { signal: exec.signal } as ToolRunContext)).rejects.toThrow(
      'session-owned',
    );
  } finally {
    await Promise.all(disposers.map(dispose => dispose()));
    await rm(root, { recursive: true, force: true });
  }
});

it('refreshes the real Harness Skill registry after a local Pro install without recreating the plugin', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-provider-')));
  const pro = join(root, 'home/.dsh/skills/oil-ui-pro');
  vi.stubEnv('DSH_HOME', join(root, 'home/.dsh'));
  vi.stubEnv('OIL_UI_PRO_DIR', '');
  localHome.path = join(root, 'home');
  const registry = new SkillRegistry(new Context());
  const tools = new Map<string, ToolDefinition>();
  const pending: Promise<unknown>[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  let provider: SkillProvider | undefined;
  const ctx = {
    effect(fn: () => () => Promise<void>) {
      disposers.push(fn());
    },
    inject(_services: string[], fn: (ctx: unknown) => unknown) {
      pending.push(Promise.resolve(fn(ctx)));
    },
    tools: {
      register(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
    },
    skills: {
      register: vi.fn(),
      get: registry.get.bind(registry),
      registerProvider(create: Parameters<SkillRegistry['registerProvider']>[0]) {
        const dispose = registry.registerProvider(control => (provider = create(control)));
        disposers.push(dispose);
        return dispose;
      },
    },
    systemPrompt: { section() {} },
  };
  try {
    apply(ctx as unknown as Context, { previewPort: 0, preferPro: true });
    await Promise.all(pending);
    expect(ctx.skills.register).not.toHaveBeenCalled();
    expect(provider?.name).toBe('oil-ui-provider');
    expect((await registry.list()).map(s => s.name)).toEqual(['oil-ui']);
    const before = await provider!.list({});
    expect(before).toEqual([expect.objectContaining({ name: 'oil-ui', rank: 600 })]);

    await mkdir(pro, { recursive: true });
    await writeFile(
      join(pro, 'SKILL.md'),
      '---\nname: oil-ui-pro\ndescription: Hot-installed Pro\nmetadata:\n  version: hot\n---\nPro body with `scripts/shoot.mjs`',
    );
    expect((await registry.list()).map(s => s.name)).toEqual(['oil-ui']);
    const exec = {
      agent: { session: { id: 'alice', header: { cwd: root } } },
      signal: new AbortController().signal,
    } as ToolRunContext;
    expect(await tools.get('oil_ui_skill_status')!.execute({}, exec)).toMatchObject({
      edition: 'pro',
      activeSkillName: 'oil-ui-pro',
      proSourcePath: pro,
      visibleMatchesOriginal: true,
    });
    expect((await registry.list()).map(s => s.name)).toEqual(['oil-ui-pro']);
    const loadedPro = await registry.get('oil-ui-pro');
    expect(loadedPro?.content).toContain('oil_ui_shoot');
    expect(await provider!.list({})).toEqual([expect.objectContaining({ name: 'oil-ui-pro', rank: 100 })]);
    const old = Array.isArray(before) ? before[0] : undefined;
    expect(await provider!.get(old!, {})).toBeUndefined();
  } finally {
    await Promise.all(disposers.map(dispose => dispose()));
    localHome.path = '';
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('triggers one-time Pro recommendation once on lite edition and reports cached update notices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oil-ui-recommend-'));
  localHome.path = root;
  const stateDir = join(root, 'state');
  vi.stubEnv('XDG_STATE_HOME', stateDir);
  try {
    await mkdir(join(stateDir, 'oil'), { recursive: true });
    await writeFile(
      join(stateDir, 'oil', 'oil-ui-update.json'),
      JSON.stringify({ checkedAt: Math.floor(Date.now() / 1000), latest: '99.0.0' }),
    );
    const first = await skillStatus(null, { preferPro: false });
    expect(first.edition).toBe('lite');
    expect(first.recommendOnceTriggered).toBe(true);
    expect(first.recommendOnceNotice).toContain('Oil UI Pro');
    expect(first.updateAvailable).toBe(true);
    expect(first.latestVersion).toBe('99.0.0');
    expect(first.updateNotice).toContain('Update available');

    const second = await skillStatus(null, { preferPro: false });
    expect(second.recommendOnceTriggered).toBe(false);
    expect(second.recommendOnceNotice).toBeNull();
  } finally {
    localHome.path = '';
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('automatically injects reviewer-manual.md into subagent system prompt and shadows main agent prompt without conflict', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-oil-ui-subagent-')));
  const proDir = join(root, '.dsh/skills/oil-ui-pro');
  const rootCtx = new Context();
  new SystemPrompt(rootCtx, {});
  const createdListeners: ((payload: { agent: unknown }) => Promise<void> | void)[] = [];
  const pending: Promise<unknown>[] = [];
  const disposers: (() => void | Promise<void>)[] = [];

  const hostCtx = {
    systemPrompt: rootCtx.systemPrompt,
    agents: { list: () => [] },
    effect(fn: () => () => void | Promise<void>) {
      disposers.push(fn());
    },
    inject(services: string[], fn: (ctx: unknown) => unknown) {
      if (services.includes('systemPrompt')) {
        pending.push(Promise.resolve(fn(hostCtx)));
      }
    },
    on(event: string, listener: (payload: { agent: unknown }) => Promise<void> | void) {
      if (event === 'agent/created') createdListeners.push(listener);
      return () => {};
    },
  };

  try {
    apply(hostCtx as unknown as Context, { previewPort: 0, preferPro: true });
    await Promise.all(pending);

    const mainSections: { name: string; order: number; interpolate?: boolean; text: string }[] = [];
    const mainAgent = {
      id: 'main-1',
      session: { id: 'main-1', header: { cwd: root } },
      ctx: {
        systemPrompt: {
          section(sec: { name: string; order: number; interpolate?: boolean; text: string }) {
            mainSections.push(sec);
            return () => {};
          },
        },
      },
    };
    for (const listener of createdListeners) await listener({ agent: mainAgent });
    expect(mainSections).toHaveLength(0);
    const mainPrompt = renderPrompt(await rootCtx.systemPrompt.assemble({}));
    expect(mainPrompt).toContain('call oil_ui_skill_status first');
    expect(mainPrompt).not.toContain('视觉与交互评审手册');

    const subSections: { name: string; order: number; interpolate?: boolean; text: string }[] = [];
    const liteSubagent = {
      id: 'sub-lite',
      session: { id: 'sub-lite', header: { cwd: root, origin: 'subagent', parentSession: 'main-1' } },
      ctx: {
        systemPrompt: {
          section(sec: { name: string; order: number; interpolate?: boolean; text: string }) {
            subSections.push(sec);
            return () => {};
          },
        },
      },
    };
    for (const listener of createdListeners) await listener({ agent: liteSubagent });
    expect(subSections).toHaveLength(1);
    expect(subSections[0]!.name).toBe('oil-ui');
    expect(subSections[0]!.text).toContain('# 视觉与交互评审手册 (子 Agent 专用)');
    expect(subSections[0]!.text).toContain('oil_ui_shoot');
    expect(subSections[0]!.text).toContain('read_image');
    expect(subSections[0]!.text).not.toContain('call oil_ui_skill_status first');

    await mkdir(join(proDir, 'references'), { recursive: true });
    await writeFile(
      join(proDir, 'SKILL.md'),
      '---\nname: oil-ui-pro\ndescription: Pro\nmetadata:\n  version: 9.9.9\n---\nPro body',
    );
    await writeFile(
      join(proDir, 'references/reviewer-manual.md'),
      '# 视觉与交互评审手册 (子 Agent 专用 - Pro 专属标识)\n能用截图工具时，用它出缩略图和遮字图。',
    );
    const proSubSections: { name: string; order: number; interpolate?: boolean; text: string }[] = [];
    const proSubagent = {
      id: 'sub-pro',
      session: { id: 'sub-pro', header: { cwd: root, origin: 'subagent', parentSession: 'main-1' } },
      ctx: {
        systemPrompt: {
          section(sec: { name: string; order: number; interpolate?: boolean; text: string }) {
            proSubSections.push(sec);
            return () => {};
          },
        },
      },
    };
    for (const listener of createdListeners) await listener({ agent: proSubagent });
    expect(proSubSections).toHaveLength(1);
    expect(proSubSections[0]!.text).toContain('Pro 专属标识');
    expect(proSubSections[0]!.text).toContain('能用 `oil_ui_shoot` 时');
  } finally {
    await Promise.all(disposers.map(dispose => dispose()));
    await rm(root, { recursive: true, force: true });
  }
});


