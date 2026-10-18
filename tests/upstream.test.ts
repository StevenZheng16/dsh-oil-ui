import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { lstat, readFile, readdir, mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadUpstreamSkill, skillDirectory, skillStatus, resolveActiveSkill, resolveImageGenScript } from '../src/upstream.ts';
import { isHarnessNativeSkillMarkdown, transformSkillMarkdown } from '../src/transform.ts';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async original => ({ ...(await original<typeof import('node:os')>()), homedir: () => fixture.home }));

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'oil-upstream-')));
  fixture.home = root;
  vi.stubEnv('DSH_HOME', join(root, '.dsh'));
  vi.stubEnv('DSH_AGENTS_HOME', '');
  vi.stubEnv('OIL_UI_PRO_DIR', '');
  vi.stubEnv('OIL_UI_IMAGE_GEN_SCRIPT', '');
  vi.stubEnv('OIL_NO_UPDATE_CHECK', '1');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function pro(path: string, name = 'oil-ui-pro', rawBody = 'Local instructions\n') {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Local Skill\nmetadata:\n  version: '9.8.7'\n---\n${rawBody}`,
  );
  return path;
}

describe('bundled open-source Skill and local Pro activation', () => {
  it('registers the compiled native Harness open-source body and resource directory', async () => {
    const registered = await loadUpstreamSkill({ preferPro: false });
    const raw = await readFile(join(skillDirectory, 'SKILL.md'), 'utf8');
    expect(isHarnessNativeSkillMarkdown(raw)).toBe(true);
    expect(raw).not.toContain('check_update.sh');
    expect(raw).toContain('oil_ui_shoot');
    expect(registered.content).toBe(raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''));
    expect(registered.name).toBe('oil-ui');
    expect(registered.metadata?.version).toBe('0.23.6');
    expect(registered.resourceBase).toEqual({ kind: 'directory', path: skillDirectory });
    expect(registered.invocation).toEqual({ modelInvocable: true, userInvocable: true });

    const toolsMd = await readFile(join(skillDirectory, 'references/tools.md'), 'utf8');
    expect(toolsMd).toContain('oil_ui_shoot');
    expect(toolsMd).not.toContain('node scripts/shoot.mjs');
  });

  it('bundles[32] public files with matching offline manifest evidence and no Pro tree', async () => {
    const manifest = JSON.parse(await readFile(join(skillDirectory, '../oil-ui.manifest.json'), 'utf8'));
    expect(manifest.name).toBe('oil-ui');
    expect(manifest.version).toBe('0.23.6');
    expect(manifest.fileCount).toBe(32);
    const walk = async (directory: string): Promise<string[]> => {
      const paths: string[] = [];
      for (const row of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, row.name);
        const info = await lstat(path);
        expect(info.isSymbolicLink()).toBe(false);
        if (info.isDirectory()) paths.push(...(await walk(path)));
        else paths.push(relative(skillDirectory, path).split(sep).join('/'));
      }
      return paths;
    };
    expect((await walk(skillDirectory)).sort()).toEqual(manifest.files.map((f: { path: string }) => f.path).sort());
    expect(manifest.files).toHaveLength(32);
    for (const file of manifest.files) {
      expect(file.path).not.toMatch(/^(references\/(direction-concept|direction-workspace|cards)\.md|assets\/cards(?:\/|$))/);
      const bytes = await readFile(join(skillDirectory, file.path));
      const info = await lstat(join(skillDirectory, file.path));
      expect(bytes.length).toBe(file.size);
      expect(`0${(info.mode & 0o777).toString(8).padStart(3, '0')}`).toBe(file.mode);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    expect((await readdir(join(skillDirectory, '..'))).sort()).toEqual(['oil-ui', 'oil-ui.manifest.json']);
  });

  it('detects explicit Pro, compiles raw Pro Markdown into native Harness tools, and reports both versions', async () => {
    const rawProBody = '启动时后台静默运行更新检查（`bash "<skill-dir>/scripts/check_update.sh" >/dev/null 2>&1 &`）\n用 `scripts/shoot.mjs` 截图\n';
    const dir = await pro(join(root, 'explicit'), 'oil-ui-pro', rawProBody);
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'references/tools.md'), '# 工具参考\n`node scripts/shoot.mjs http://localhost:3000 --out ./shots`\n');
    const options = { proSkillDir: ` ${dir} ` };
    const resolved = await resolveActiveSkill(options);
    expect(resolved).toMatchObject({
      edition: 'pro',
      name: 'oil-ui-pro',
      sourceDirectory: dir,
      source: 'local-pro',
    });
    expect(resolved.directory).toContain(join(root, '.dsh/cache/dsh-oil-ui/oil-ui-pro-'));
    const registration = await loadUpstreamSkill(options);
    expect(registration.resourceBase).toEqual({ kind: 'directory', path: resolved.directory });
    expect(registration.content).toContain('oil_ui_skill_status');
    expect(registration.content).toContain('oil_ui_shoot');
    expect(registration.content).not.toContain('check_update.sh');
    const compiledTools = await readFile(join(resolved.directory, 'references/tools.md'), 'utf8');
    expect(compiledTools).toContain('oil_ui_shoot');
    expect(compiledTools).not.toContain('node scripts/shoot.mjs');

    const status = await skillStatus(
      { ...registration, invocation: registration.invocation!, source: registration.source!, provider: 'test' },
      options,
    );
    expect(status).toMatchObject({
      edition: 'pro',
      activeSkillName: 'oil-ui-pro',
      activeVersion: '9.8.7',
      bundledVersion: '0.23.6',
      proInstalled: true,
      proSourcePath: dir,
      activeResourceBase: resolved.directory,
      visibleMatchesOriginal: true,
    });
    expect(status.note).toContain('No hash gate is enforced during loading or execution.');
  });

  it('uses already-compiled Pro directory directly without re-caching', async () => {
    const nativeBody = transformSkillMarkdown('SKILL.md', '---\nname: oil-ui-pro\ndescription: Native Pro\n---\nCall `oil_ui_skill_status` and `oil_ui_shoot`.\n');
    const dir = join(root, 'native-pro');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), nativeBody);
    const resolved = await resolveActiveSkill({ proSkillDir: dir });
    expect(resolved.directory).toBe(dir);
    expect(resolved.sourceDirectory).toBe(dir);
  });

  it('falls back with no Pro and allows preferPro=false while still reporting an installed Pro', async () => {
    expect(await resolveActiveSkill()).toMatchObject({ edition: 'lite', source: 'bundled-lite', name: 'oil-ui' });
    expect(await skillStatus(null)).toMatchObject({ proInstalled: false, proSourcePath: null, visibleMatchesOriginal: false });
    const dir = await pro(join(root, 'explicit'));
    const status = await skillStatus(null, { proSkillDir: dir, preferPro: false });
    expect(status).toMatchObject({ edition: 'lite', activeSkillName: 'oil-ui', proInstalled: true, proSourcePath: dir });
    expect(status.upgradeHint).toContain('npx github:oil-oil/oil-cli install oil-ui-pro');
  });

  it('strictly follows DeepSeek Harness skill roots in priority order and ignores non-DSH hosts', async () => {
    for (const nonDshHost of ['.cursor', '.codex', '.claude']) {
      await pro(join(root, nonDshHost, 'skills/oil-ui-pro'));
    }
    expect((await resolveActiveSkill()).edition).toBe('lite');

    const agents = await pro(join(root, '.agents/skills/oil-ui-pro'));
    expect((await resolveActiveSkill()).sourceDirectory).toBe(agents);

    const dsh = await pro(join(root, '.dsh/skills/oil-ui-pro'));
    expect((await resolveActiveSkill()).sourceDirectory).toBe(dsh);

    const projectDir = join(root, 'workspace');
    const projectAgents = await pro(join(projectDir, '.agents/skills/oil-ui-pro'));
    expect((await resolveActiveSkill({ cwd: projectDir })).sourceDirectory).toBe(projectAgents);

    const projectDsh = await pro(join(projectDir, '.dsh/skills/oil-ui-pro'));
    expect((await resolveActiveSkill({ cwd: projectDir })).sourceDirectory).toBe(projectDsh);

    const env = await pro(join(root, 'env'));
    vi.stubEnv('OIL_UI_PRO_DIR', env);
    expect((await resolveActiveSkill({ cwd: projectDir })).sourceDirectory).toBe(env);

    const explicit = await pro(join(root, 'explicit'));
    expect((await resolveActiveSkill({ cwd: projectDir, proSkillDir: explicit })).sourceDirectory).toBe(explicit);
  });

  it('ignores wrong identity, malformed YAML and SKILL.md symlink escapes', async () => {
    const invalid = await pro(join(root, 'invalid'), 'other');
    expect((await resolveActiveSkill({ proSkillDir: invalid })).edition).toBe('lite');
    await writeFile(join(invalid, 'SKILL.md'), '---\nname: [invalid\n---\n');
    expect((await resolveActiveSkill({ proSkillDir: invalid })).edition).toBe('lite');
    const valid = await pro(join(root, 'valid'));
    await rm(join(invalid, 'SKILL.md'));
    await symlink(join(valid, 'SKILL.md'), join(invalid, 'SKILL.md'));
    expect((await resolveActiveSkill({ proSkillDir: invalid })).edition).toBe('lite');
  });
});

async function imageScript(path: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '# local image script');
  return path;
}
describe('local image-gen discovery', () => {
  it('reports missing image-gen and discovers configured/env scripts without caching', async () => {
    expect(await resolveImageGenScript()).toBe(null);
    expect(await skillStatus(null, { preferPro: false })).toMatchObject({ imageGenAvailable: false, imageGenScriptPath: null });
    const env = await imageScript(join(root, 'env/image_gen.py'));
    vi.stubEnv('OIL_UI_IMAGE_GEN_SCRIPT', env);
    expect(await resolveImageGenScript()).toBe(env);
    const explicit = await imageScript(join(root, 'explicit/mock.py'));
    expect(await resolveImageGenScript({ imageGenScript: ' ' + explicit + ' ' })).toBe(explicit);
    expect(await skillStatus(null, { preferPro: false, imageGenScript: explicit })).toMatchObject({
      imageGenAvailable: true,
      imageGenScriptPath: explicit,
    });
  });

  it('strictly follows DeepSeek Harness image-gen skill roots and ignores non-DSH hosts', async () => {
    for (const nonDshHost of ['.cursor', '.claude', '.codex']) {
      await imageScript(join(root, nonDshHost, 'skills/image-gen/scripts/image_gen.py'));
      expect(await resolveImageGenScript()).toBeNull();
    }
    const projectDir = join(root, 'workspace');
    for (const dir of [
      join(root, '.agents/skills/image-gen/scripts/image_gen.py'),
      join(root, '.dsh/skills/image-gen/scripts/image_gen.py'),
      join(projectDir, '.agents/skills/image-gen/scripts/image_gen.py'),
      join(projectDir, '.dsh/skills/image-gen/scripts/image_gen.py'),
    ]) {
      const path = await imageScript(dir);
      expect(await resolveImageGenScript({ cwd: projectDir })).toBe(path);
    }
  });

  it('ignores directories and rejects escaping script symlinks', async () => {
    const escaped = await imageScript(join(root, 'outside/mock.py'));
    const target = join(root, '.dsh/skills/image-gen/scripts/image_gen.py');
    await mkdir(join(target, '..'), { recursive: true });
    await symlink(escaped, target);
    expect(await resolveImageGenScript()).toBe(null);
    const explicit = join(root, 'links/mock.py');
    await mkdir(join(explicit, '..'), { recursive: true });
    await symlink(escaped, explicit);
    expect(await resolveImageGenScript({ imageGenScript: explicit })).toBe(null);
    expect(await resolveImageGenScript({ imageGenScript: root })).toBe(null);
  });
});
