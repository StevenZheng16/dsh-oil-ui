import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type FileBlock, type ImageBlock } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolRunContext, type InferValue } from '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-skill';
import '@deepseek-ai/dsh-system-prompt';
import { loadUpstreamSkill, skillStatus, resolveActiveSkill, createSkillProvider } from './upstream.ts';
import { Config } from './config.ts';
import { DesignWorkbench } from './workbench.ts';
export { Config };
export const name = 'dsh-oil-ui';

interface OilUiCommandInvocation {
  readonly agent: Agent;
  readonly rawInput: string;
  readonly attachments: readonly (ImageBlock | FileBlock)[];
  readonly signal: AbortSignal;
}

interface OilUiCommandResult {
  readonly kind: 'success' | 'error';
  readonly text?: string;
}

interface OilUiCommandRuntime {
  register(definition: {
    readonly name: string;
    readonly description: string;
    readonly input?: {
      readonly hint: string;
      readonly attachments?: boolean;
    };
    readonly handler: (invocation: OilUiCommandInvocation) => OilUiCommandResult | Promise<OilUiCommandResult>;
  }): () => void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    commands: OilUiCommandRuntime;
  }
}

function sessionCwd(exec: ToolRunContext, fallback?: string): string {
  if (!exec.agent) throw new Error('Oil UI requires a session-owned agent execution');
  const cwd = exec.agent.session.header.cwd?.trim() || fallback?.trim();
  if (!cwd) throw new Error('Oil UI requires a session working directory');
  return cwd;
}

type JsonValue = InferValue<{ type: 'json' }>;
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
const nativeOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

export function apply(ctx: Context, config: Config) {
  const workbench = new DesignWorkbench(config.workspaceRoot, config.previewPort, config);
  ctx.effect(() => () => workbench.dispose());
  let invalidateSkills: (() => void) | undefined;

  ctx.inject(['tools', 'skills'], ctx => {
    ctx.tools.register(
      defineTool({
        name: 'oil_ui_skill_status',
        isConcurrencySafe: args => !Boolean(args && typeof args === 'object' && (args as { update?: unknown }).update),
        description:
          'Report the active oil-ui edition, local Pro installation, versions, update check status, one-time Pro recommendation, local image-gen availability and scoped Skill registration. Pass update=true only when the user explicitly confirms updating.',
        parameters: {
          update: { type: 'boolean' },
        },
        output: nativeOutput,
        execute: async (args, exec) => {
          invalidateSkills?.();
          const cwd = exec.agent?.session.header.cwd;
          const active = await resolveActiveSkill({ ...config, cwd });
          return json(
            await skillStatus(
              await ctx.skills.get(active.name, { scope: exec.agent, cwd }),
              { ...config, cwd, update: Boolean(args?.update) },
            ),
          );
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_explorer',
        description:
          'Generate a portable single-file style-explorer.html comparison page in the current working directory from a manifest or explore/a.html, b.html, c.html (or directions/a.html, b.html, c.html). Inlines local assets and stylesheets and returns the preview URL.',
        parameters: {
          manifest: { type: 'json' },
          out: { type: 'string' },
          title: { type: 'string' },
          brief: { type: 'string' },
          request: { type: 'string' },
        },
        output: nativeOutput,
        execute: async (args, exec) => json(await workbench.explorer(sessionCwd(exec, config.workspaceRoot), args)),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_shoot',
        timeoutMs: 905_000,
        description:
          'Capture screenshots, interactive state sequences, multi-viewport responsive checks, element crops, motion recordings, pixel comparisons, or stitched sheets using the active Skill screenshot engine in the current working directory. Local HTML files are served over a workspace-rooted HTTP server so relative paths like ../assets/ resolve cleanly.',
        parameters: {
          target: { type: 'string' },
          out: { type: 'string' },
          mode: { type: 'string', enum: ['shot', 'compare', 'evidence'] },
          before: { type: 'string' },
          after: { type: 'string' },
          compare: { type: 'string' },
          size: { type: 'string' },
          viewport: { type: 'string' },
          states: { type: 'json' },
          param: { type: 'string' },
          query: { type: 'string' },
          zoom: { type: 'json' },
          fullPage: { type: 'boolean' },
          mask: { type: 'boolean' },
          sheet: { type: 'boolean' },
          mark: { type: 'string' },
          selector: { type: 'string' },
          steps: { type: 'json' },
          record: { type: 'json' },
          entry: { type: 'boolean' },
          holdMs: { type: 'number' },
          motion: { type: 'json' },
          evidence: { type: 'boolean' },
          stitch: { type: 'json' },
          columns: { type: 'number' },
          frames: { type: 'json' },
          waitMs: { type: 'number' },
          timeoutScale: { type: 'number' },
          dryRun: { type: 'boolean' },
          timeoutMs: { type: 'number' },
        },
        output: nativeOutput,
        execute: async (args, exec) =>
          json(await workbench.shoot(sessionCwd(exec, config.workspaceRoot), args as Record<string, unknown>, exec.signal)),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_media',
        timeoutMs: 905_000,
        isConcurrencySafe: args =>
          Boolean(
            args &&
              typeof args === 'object' &&
              (args as { action?: unknown }).action === 'search' &&
              !(args as { out?: unknown }).out,
          ),
        description:
          'Search museum, open-access, photo, video and 3D/PBR asset providers, preview candidates on a numbered contact sheet, and download selected assets into the current working directory using the active Skill media engine. Inspect each item license and attribution.',
        parameters: {
          action: { type: 'string', enum: ['search', 'preview', 'fetch', 'search_and_fetch'] },
          query: { type: 'string' },
          refs: { type: 'json' },
          dir: { type: 'string' },
          out: { type: 'string' },
          kind: { type: 'string' },
          use: { type: 'string', enum: ['page', 'reference', 'all'] },
          limit: { type: 'number' },
          sources: { type: 'json' },
          sheet: { type: 'boolean' },
          maps: { type: 'json' },
          resolution: { type: 'string' },
          videoSize: { type: 'string' },
          note: { type: 'string' },
          refresh: { type: 'boolean' },
          timeoutMs: { type: 'number' },
        },
        output: nativeOutput,
        execute: async (args, exec) =>
          json(await workbench.media(sessionCwd(exec, config.workspaceRoot), args as Record<string, unknown>, exec.signal)),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_image',
        timeoutMs: 905_000,
        description:
          'Generate images or edit 1–16 local reference images in the current working directory using the locally installed image-gen Skill and python3. Defaults to edit when images are provided. Use background=transparent for cutout assets; the local service credentials and model apply.',
        parameters: {
          prompt: { type: 'string', required: true },
          mode: { type: 'string', enum: ['generate', 'edit'] },
          out: { type: 'string' },
          images: { type: 'array', items: { type: 'string' } },
          size: { type: 'string' },
          quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
          background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] },
          model: { type: 'string' },
          force: { type: 'boolean' },
          timeoutMs: { type: 'number' },
        },
        output: nativeOutput,
        execute: async (args, exec) =>
          json(await workbench.image(sessionCwd(exec, config.workspaceRoot), args, exec.signal)),
      }),
    );
  });

  ctx.inject(['skills'], async ctx => {
    if (typeof ctx.skills.registerProvider === 'function') {
      ctx.skills.registerProvider(control => {
        invalidateSkills = () => control.invalidate?.();
        return createSkillProvider(config, control);
      });
    } else {
      ctx.skills.register(await loadUpstreamSkill(config));
    }
  });

  ctx.inject(['commands', 'skills'], ctx => {
    if (!ctx.commands || typeof ctx.commands.register !== 'function') return;
    ctx.effect(() => {
      const disposeStatus = ctx.commands.register({
        name: 'oil-ui-status',
        description: '查看当前生效版本（oil-ui / oil-ui-pro）、更新状态与生图可用性（传入 update 可直接更新）',
        input: {
          hint: '[update]',
        },
        handler: async invocation => {
          const arg = invocation.rawInput.trim().toLowerCase();
          if (arg.length > 0 && arg !== 'update') {
            return {
              kind: 'error',
              text: '用法：/oil-ui-status [update]',
            };
          }
          invalidateSkills?.();
          const cwd = invocation.agent.session.header.cwd;
          const active = await resolveActiveSkill({ ...config, cwd });
          const status = await skillStatus(
            await ctx.skills.get(active.name, { scope: invocation.agent, cwd }),
            { ...config, cwd, update: arg === 'update' },
          );
          if (status.updated) {
            invalidateSkills?.();
          }
          const lines = [
            `当前生效 Skill：${status.activeSkillName}（${status.edition === 'pro' ? 'Pro' : 'Lite'}）v${status.activeVersion}`,
            `最新版本：${status.latestVersion ?? status.activeVersion}${status.updateAvailable ? '（有新版本可用，可运行 /oil-ui-status update 更新）' : ''}`,
            `本地 Pro：${status.proInstalled ? `已检测到（${status.proSourcePath}）` : '未安装'}`,
            `本地生图（image-gen）：${status.imageGenAvailable ? `可用（${status.imageGenScriptPath}）` : '未检测到'}`,
            ...(status.updateNotice ? [status.updateNotice] : []),
          ];
          return {
            kind: 'success',
            text: lines.join('\n'),
          };
        },
      });

      const disposeExplore = ctx.commands.register({
        name: 'oil-ui-explore',
        description: '探索 3 个不同设计方向并生成 style-explorer.html 同屏对比页',
        input: {
          hint: '<设计需求或目标页面>',
          attachments: true,
        },
        handler: invocation => {
          const brief = invocation.rawInput.trim();
          if (brief.length === 0 && invocation.attachments.length === 0) {
            return {
              kind: 'error',
              text: '用法：/oil-ui-explore <设计需求或目标页面>',
            };
          }
          const prompt = [
            'Call oil_ui_skill_status first and load the active Oil UI Skill using the skill tool.',
            'Explore 3 genuinely distinct design directions in explore/a.html, explore/b.html, and explore/c.html, package them into style-explorer.html with oil_ui_explorer, and inspect the comparison page and cards with oil_ui_shoot.',
            ...(brief ? ['', `Design brief: ${brief}`] : []),
          ].join('\n');
          invocation.agent.followup(
            createUserMessage({
              content: [...invocation.attachments, { type: 'text', text: prompt }],
              source: { kind: 'user' },
            }),
          );
          return {
            kind: 'success',
            text: '已发起 Oil UI 三方向设计探索。',
          };
        },
      });

      const disposeReview = ctx.commands.register({
        name: 'oil-ui-review',
        description: '截取真实页面画面，执行视觉层级与交互可用性双轨走查',
        input: {
          hint: '[文件、URL 或评审重点]',
          attachments: true,
        },
        handler: invocation => {
          const target = invocation.rawInput.trim();
          const prompt = [
            'Call oil_ui_skill_status first and load the active Oil UI Skill using the skill tool.',
            'Capture desktop and mobile screenshots and key interactive states with oil_ui_shoot, then conduct a two-track UI/UX review covering visual hierarchy/craft and usability/task flow.',
            ...(target ? ['', `Review target: ${target}`] : []),
          ].join('\n');
          invocation.agent.followup(
            createUserMessage({
              content: [...invocation.attachments, { type: 'text', text: prompt }],
              source: { kind: 'user' },
            }),
          );
          return {
            kind: 'success',
            text: '已发起 Oil UI 双轨 UI/UX 走查。',
          };
        },
      });

      return () => {
        disposeStatus?.();
        disposeExplore?.();
        disposeReview?.();
      };
    });
  });

  ctx.inject(['systemPrompt'], ctx => {
    ctx.systemPrompt.section({
      name: 'oil-ui',
      order: 70,
      interpolate: false,
      text: 'For UI tasks, call oil_ui_skill_status first to refresh discovery and read activeSkillName (local oil-ui-pro installs unlock without restarting), then load that Skill using the skill tool. Read and write project files directly in the current working directory. Use oil_ui_explorer for style-explorer.html comparison pages, oil_ui_shoot for screenshots/interactions/responsive checks/recordings, oil_ui_media for public-domain and museum media search/preview/fetch, and oil_ui_image for generating or editing visual assets.',
    });
  });
}

