import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesignWorkbench } from '../src/workbench.ts';
import { ManagedProcesses } from '../src/processes.ts';
import type { ImageRequest } from '../src/tool-requests.ts';

const localHome = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => localHome.path || os.homedir() };
});

const instances: DesignWorkbench[] = [];
const roots: string[] = [];

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-ui-test-')));
  roots.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const w = new DesignWorkbench(0, { preferPro: false });
  instances.push(w);
  return { w, cwd, root };
}

beforeEach(async () => {
  localHome.path = await realpath(await mkdtemp(join(tmpdir(), 'oil-workbench-home-')));
  roots.push(localHome.path);
  vi.stubEnv('DSH_HOME', join(localHome.path, '.dsh'));
  vi.stubEnv('OIL_UI_PRO_DIR', '');
  vi.stubEnv('OIL_UI_IMAGE_GEN_SCRIPT', '');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  localHome.path = '';
  for (const w of instances.splice(0)) await w.dispose();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

function explorerData(html: string): {
  edition: string;
  fingerprint: string;
  candidates: { content: string; kind: string; id: string }[];
} {
  const payload = /const DATA = ([\s\S]*?);\n/.exec(html) ?? /const DATA=([\s\S]*?);\n/.exec(html);
  if (!payload) throw new Error('Explorer data marker not found');
  return JSON.parse(payload[1]!);
}

async function scriptedWorkbench(script: string, mediaScript?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-native-')));
  roots.push(root);
  const skill = join(root, 'pro');
  const cwd = join(root, 'workspace');
  await mkdir(join(skill, 'scripts'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: oil-ui-pro\ndescription: Test local tools\n---\nInstructions');
  await writeFile(join(skill, 'scripts/shoot.mjs'), script);
  await writeFile(join(skill, 'scripts/curate-media.mjs'), mediaScript ?? script);
  await writeFile(join(cwd, 'index.html'), '<title>Native page</title>');
  const w = new DesignWorkbench(0, { proSkillDir: skill });
  instances.push(w);
  return { w, cwd, root, skill };
}

describe('workspace-rooted preview server and security boundaries', () => {
  it('serves workspace files and subdirectory relative assets, then closes on dispose', async () => {
    const { w, cwd } = await setup();
    await mkdir(join(cwd, 'explore'), { recursive: true });
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'index.html'), '<!doctype html><title>Workspace page</title>');
    await writeFile(join(cwd, 'explore/a.html'), '<!doctype html><title>Candidate A</title><img src="../assets/hero.png">');
    await writeFile(join(cwd, 'assets/font.ttf'), Buffer.from([0, 1, 0, 0]));

    const base = await w.preview(cwd);
    const res = await fetch(`${base}/index.html`);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Workspace page');
    expect(res.headers.get('content-security-policy')).toContain("'unsafe-eval'");

    const sub = await fetch(`${base}/explore/a.html`);
    expect(sub.status).toBe(200);
    expect(await sub.text()).toContain('Candidate A');

    const font = await fetch(`${base}/assets/font.ttf`);
    expect(font.headers.get('content-type')).toBe('font/ttf');

    await w.dispose();
    await expect(fetch(`${base}/index.html`)).rejects.toThrow();
  });

  it('refuses hidden files and symlink escapes over HTTP', async () => {
    const { w, cwd } = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'oil-ui-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.html'), 'private');
    await symlink(outside, join(cwd, 'linked'));
    await writeFile(join(cwd, '.hidden.json'), 'secret');

    const base = await w.preview(cwd);
    expect((await fetch(`${base}/linked/secret.html`)).status).toBe(404);
    expect((await fetch(`${base}/.hidden.json`)).status).toBe(404);
  });
});

describe('native explorer and managed scripts in cwd', () => {
  it('synthesizes a manifest from explore/a.html, b.html, c.html and builds style-explorer.html in Node', async () => {
    const { w, cwd } = await setup();
    await mkdir(join(cwd, 'explore'), { recursive: true });
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'explore/theme.css'), '@import "base.css";body{background:url("../assets/pixel.png")}');
    await writeFile(join(cwd, 'explore/base.css'), '@font-face{font-family:Test;src:url("../assets/font.woff2")}body{color:#123456}');
    await writeFile(join(cwd, 'assets/pixel.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await writeFile(join(cwd, 'assets/font.woff2'), 'font fixture');
    for (const id of ['a', 'b', 'c']) {
      await writeFile(
        join(cwd, `explore/${id}.html`),
        `<title>Direction ${id}</title><link rel=stylesheet href=theme.css><main>${id}: inline candidate</main><img src=../assets/pixel.png>`,
      );
    }

    const result = await w.explorer(cwd, { title: 'Compare styles', request: 'Choose a clear layout' });
    expect(result.explorerPath).toBe('style-explorer.html');
    expect(result.explorerUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/style-explorer\.html$/);

    const html = await readFile(join(cwd, result.explorerPath), 'utf8');
    expect(html).toContain('style-explorer');
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('/*__OIL_UI_DATA__*/ null');
    const data = explorerData(html);
    expect(data.edition).toBe('open');
    expect(data.fingerprint).toMatch(/^[a-f0-9]{24}$/);
    expect(data.candidates).toHaveLength(3);
    expect(data.candidates[0]?.content).toContain('a: inline candidate');
    expect(data.candidates[0]?.content).toContain('data:font/woff2;base64,');
    expect(data.candidates[0]?.content).not.toContain('@import');
    expect(data.candidates[0]?.content).toContain("script-src 'none'");
    expect(JSON.parse(await readFile(join(cwd, 'explore/manifest.json'), 'utf8')).candidates[0].name).toBe('Direction a');

    const res = await fetch(result.explorerUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).not.toContain("connect-src 'self'");

    const rerun = await w.explorer(cwd, {});
    expect(explorerData(await readFile(join(cwd, rerun.explorerPath), 'utf8')).fingerprint).toBe(data.fingerprint);
  });

  it('accepts JSON manifests, embeds scripts/images, constrains URLs and escapes injected metadata', async () => {
    const { w, cwd, root } = await setup();
    await mkdir(join(cwd, 'explore'), { recursive: true });
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'explore/a.html'), '<title>Interactive</title><script src="app.js" defer></script><button>Test</button>');
    await writeFile(join(cwd, 'explore/app.js'), 'localStorage.setItem("loaded","true");document.body.dataset.ready="yes";');
    await writeFile(join(cwd, 'assets/pixel.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const c = {
      id: 'a',
      name: '</script><script>escape</script>',
      concept: 'Compare',
      typography: 'System',
      palette: ['#123'],
      traits: ['Clear'],
      source: 'explore/a.html',
      interactive: true,
    };
    const manifest = {
      schemaVersion: 1,
      project: 'Mixed',
      brief: 'Test',
      candidates: [
        c,
        { ...c, id: 'b', kind: 'image', interactive: false, source: 'assets/pixel.png' },
        { ...c, id: 'c', kind: 'url', interactive: false, url: 'http://127.0.0.1:5173/page' },
      ],
    };
    await w.explorer(cwd, { manifest: JSON.stringify(manifest) });
    const html = await readFile(join(cwd, 'style-explorer.html'), 'utf8');
    const data = explorerData(html);
    expect(html).toContain('connect-src http://127.0.0.1:5173');
    expect(html).not.toContain('</script><script>escape');
    expect(data.candidates[0]?.content).toContain('Object.defineProperty(window');
    expect(data.candidates[0]?.content).toContain('localStorage.setItem');
    expect(data.candidates[0]?.content).not.toContain('src="app.js"');
    expect(data.candidates[1]?.content).toContain('data:image/png;base64,');

    (manifest.candidates[2] as { url: string }).url = 'https://example.com/page';
    await expect(w.explorer(cwd, { manifest })).rejects.toThrow('loopback');
    expect(await readFile(join(cwd, 'style-explorer.html'), 'utf8')).toBe(html);

    await writeFile(join(root, 'external.png'), 'private');
    await writeFile(join(cwd, 'explore/a.html'), '<img src="../../external.png">');
    await expect(w.explorer(cwd, { manifest: { ...manifest, candidates: [c] } })).rejects.toThrow('within the project');
  });

  it('uses local Pro templates and reports Pro edition', async () => {
    const { w, cwd, skill } = await scriptedWorkbench('');
    await mkdir(join(skill, 'assets'), { recursive: true });
    await writeFile(
      join(skill, 'assets/style-explorer.html'),
      '<html><head><meta content="connect-src \'none\'"></head><body>PRO TEMPLATE<script>const DATA = /*__OIL_UI_DATA__*/ null;\n</script></body></html>',
    );
    await mkdir(join(cwd, 'explore'), { recursive: true });
    for (const id of ['a', 'b', 'c']) await writeFile(join(cwd, `explore/${id}.html`), `<title>${id}</title>`);
    await w.explorer(cwd, {});
    const html = await readFile(join(cwd, 'style-explorer.html'), 'utf8');
    expect(html).toContain('PRO TEMPLATE');
    expect(explorerData(html).edition).toBe('pro');
  });

  it('validates script parameters and workspace boundaries before execution', async () => {
    const { w, cwd } = await scriptedWorkbench('throw new Error("must not run");');
    for (const input of [
      { viewport: 'bad' },
      { viewport: '0x900' },
      { waitMs: -1 },
      { timeoutMs: 0 },
      { mode: 'compare' as const },
      { out: '../escape.png' },
      { selector: '.x; click .y' },
    ]) {
      await expect(w.shoot(cwd, input)).rejects.toThrow();
    }
    for (const input of [
      { query: '' },
      { query: 'test', limit: 0 },
      { query: 'test', sources: 'unknown' },
      { query: 'test', dir: '../escape' },
    ]) {
      await expect(w.media(cwd, input)).rejects.toThrow();
    }
  });

  it('serves subdirectory targets from workspace root, forwards full shoot flags, and cleans up .shoot-tmp-* when out is a .png file', async () => {
    const { w, cwd } = await scriptedWorkbench(
      `import{writeFile,mkdir}from'node:fs/promises';import{join}from'node:path';const args=process.argv.slice(2),dir=args[args.indexOf('--out')+1];await mkdir(dir,{recursive:true});await writeFile(join(dir,'idle.png'),'image bytes');console.log(JSON.stringify(args));console.log('idle.png 默认做法提示（不是报错，按设计意图判断）：small text');`,
    );
    await mkdir(join(cwd, 'explore'), { recursive: true });
    await writeFile(join(cwd, 'explore/a.html'), '<title>Candidate A</title>');

    const result = await w.shoot(cwd, {
      target: 'explore/a.html',
      out: 'shots/candidate-a.png',
      size: '1440x900,390x844',
      states: 'default,empty',
      param: 'view',
      query: 'tab=settings;tab=billing',
      zoom: '#hero',
      fullPage: true,
      mask: true,
      sheet: true,
      mark: 'button,a',
      steps: 'click #open; wait 200; shot modal',
      waitMs: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.outputFiles).toEqual([join(cwd, 'shots/candidate-a.png')]);
    expect(await readFile(join(cwd, 'shots/candidate-a.png'), 'utf8')).toBe('image bytes');
    const shotsEntries = await readdir(join(cwd, 'shots'));
    expect(shotsEntries).toEqual(['candidate-a.png']);

    expect(result.domHints[0]).toContain('默认做法提示');
    const args = JSON.parse(result.stdout.split('\n')[0]!);
    expect(args[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/explore\/a\.html$/);
    expect(args).toContain('--size');
    expect(args).toContain('1440x900,390x844');
    expect(args).toContain('--states');
    expect(args).toContain('default,empty');
    expect(args).toContain('--param');
    expect(args).toContain('view');
    expect(args).toContain('--query');
    expect(args).toContain('tab=settings;tab=billing');
    expect(args).toContain('--zoom');
    expect(args).toContain('#hero');
    expect(args).toContain('--full');
    expect(args).toContain('--mask');
    expect(args).toContain('--sheet');
    expect(args).toContain('--mark');
    expect(args).toContain('button,a');
    expect(args).toContain('--steps');
    expect(args).toContain('click #open; wait 200; shot modal');
  });

  it('supports search, preview, fetch and search_and_fetch in oil_ui_media', async () => {
    const script = `import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';const a=process.argv.slice(2);if(a[0]==='search'){console.log(JSON.stringify({items:[{ref:'M1',provider:'met',use:'page',license:'CC0'},{ref:'V1',provider:'vam',use:'reference'}]}));}else if(a[0]==='preview'){const out=a[a.indexOf('--out')+1];await mkdir(join(out,'..'),{recursive:true});await writeFile(out,'preview-sheet');console.log(JSON.stringify({ok:true,sheetImage:out,items:[{ref:'M1',provider:'met',license:'CC0'}]}));}else{const dir=a[a.indexOf('--dir')+1];await mkdir(dir,{recursive:true});await writeFile(join(dir,'M1.png'),'asset');if(a.includes('--sheet'))await writeFile(join(dir,'sheet.png'),'sheet');console.log(JSON.stringify({files:[{ref:'M1',saved:join(dir,'M1.png')}],...(a.includes('--sheet')?{sheetImage:join(dir,'sheet.png')}:{})}));}`;
    const { w, cwd } = await scriptedWorkbench('', script);

    const searched = await w.media(cwd, { action: 'search', query: 'ceramic', sources: 'met' });
    expect(searched).toMatchObject({ ok: true, action: 'search', count: 1 });

    const previewed = await w.media(cwd, { action: 'preview', query: 'ceramic', out: 'shots/candidates.png' });
    expect(previewed).toMatchObject({ ok: true, action: 'preview', sheetPath: join(cwd, 'shots/candidates.png') });
    expect(await readFile(previewed.sheetPath!, 'utf8')).toBe('preview-sheet');

    const fetched = await w.media(cwd, { action: 'fetch', refs: 'M1', dir: 'assets/media', sheet: false });
    expect(fetched).toMatchObject({ ok: true, action: 'fetch', count: 1, outputDir: join(cwd, 'assets/media'), sheetPath: null });

    const combined = await w.media(cwd, { query: 'bridge | landscape', sources: 'met' });
    expect(combined).toMatchObject({
      ok: true,
      action: 'search_and_fetch',
      count: 1,
      outputDir: join(cwd, 'assets/media'),
      sheetPath: join(cwd, 'shots/media-sheet.png'),
    });
    expect(combined.items[0]).toMatchObject({ license: 'CC0', provider: 'met' });
    expect(await readFile(combined.sheetPath!, 'utf8')).toBe('sheet');
  });

  it('terminates timed-out scripts and kills active scripts when disposed', async () => {
    const { w, cwd } = await scriptedWorkbench(`console.log('started');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
    const result = await w.shoot(cwd, { timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('timed out');
    const running = w.shoot(cwd, { timeoutMs: 10000 });
    for (let i = 0; i < 100; i++) {
      if ((w as unknown as { processes: { active: Set<unknown> } }).processes.active.size) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await w.dispose();
    expect((await running).ok).toBe(false);
    await expect(w.shoot(cwd, {})).rejects.toThrow('disposed');
  });
});

it('honors Harness cancellation and reports malformed media output as structured failure', async () => {
  const { w, cwd } = await scriptedWorkbench(
    `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
    `console.log('not JSON');process.exitCode=1;`,
  );
  const controller = new AbortController();
  const running = w.shoot(cwd, { timeoutMs: 10000 }, controller.signal);
  for (let i = 0; i < 100; i++) {
    if ((w as unknown as { processes: { active: Set<unknown> } }).processes.active.size) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  controller.abort();
  expect(await running).toMatchObject({ ok: false, outputFiles: [] });
  const media = await w.media(cwd, { query: 'landscape' });
  expect(media).toMatchObject({ ok: false, count: 0, items: [], sheetPath: null });
  expect(media.errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Media script returned invalid JSON' })]));
});

it('hot-switches explorer templates and scripts on one workbench after Pro is installed', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'oil-hot-cwd-')));
  roots.push(cwd);
  const w = new DesignWorkbench(0);
  instances.push(w);
  await mkdir(join(cwd, 'explore'), { recursive: true });
  await writeFile(join(cwd, 'index.html'), '<title>Home</title>');
  for (const id of ['a', 'b', 'c']) await writeFile(join(cwd, `explore/${id}.html`), `<title>${id}</title>`);
  await w.explorer(cwd, {});
  expect(explorerData(await readFile(join(cwd, 'style-explorer.html'), 'utf8')).edition).toBe('open');

  const pro = join(localHome.path, '.dsh/skills/oil-ui-pro');
  await mkdir(join(pro, 'assets'), { recursive: true });
  await mkdir(join(pro, 'scripts'), { recursive: true });
  await writeFile(join(pro, 'SKILL.md'), '---\nname: oil-ui-pro\ndescription: Hot Pro\n---\nPro instructions');
  await writeFile(
    join(pro, 'assets/style-explorer.html'),
    '<meta content="connect-src \'none\'"><main>HOT PRO</main><script>const DATA = /*__OIL_UI_DATA__*/ null;\n</script>',
  );
  await writeFile(
    join(pro, 'scripts/shoot.mjs'),
    `import{writeFile}from'node:fs/promises';import{join}from'node:path';const args=process.argv.slice(2);await writeFile(join(args[args.indexOf('--out')+1],'pro.png'),'pro image');console.log('Hot Pro script');`,
  );
  await w.explorer(cwd, {});
  const html = await readFile(join(cwd, 'style-explorer.html'), 'utf8');
  expect(html).toContain('HOT PRO');
  expect(explorerData(html).edition).toBe('pro');
  expect(await w.shoot(cwd, {})).toMatchObject({ ok: true, stdout: 'Hot Pro script\n' });

  await rm(pro, { recursive: true });
  await w.explorer(cwd, {});
  expect(explorerData(await readFile(join(cwd, 'style-explorer.html'), 'utf8')).edition).toBe('open');
});

const IMAGE_MOCK = `const fs=require('node:fs');const a=process.argv.slice(2);const value=k=>a[a.indexOf(k)+1];const promptFile=value('--prompt-file'),out=value('--out');const prompt=fs.readFileSync(promptFile,'utf8');fs.writeFileSync(out,'image fixture');console.log(JSON.stringify({outputs:[out],model:a.includes('--model')?value('--model'):'mock-image-model',promptFile,prompt,mode:a[0],args:a}));`;

async function imageWorkbench(body = IMAGE_MOCK) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oil-image-')));
  roots.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd, { recursive: true });
  const script = join(root, 'mock-image.cjs');
  await writeFile(script, body);
  const runCommand = ManagedProcesses.prototype.runCommand;
  vi.spyOn(ManagedProcesses.prototype, 'runCommand').mockImplementation(function (
    this: ManagedProcesses,
    executable,
    args,
    execCwd,
    timeoutMs,
    signal,
  ) {
    if (executable === 'python3') return runCommand.call(this, process.execPath, args, execCwd, timeoutMs, signal);
    return runCommand.call(this, executable, args, execCwd, timeoutMs, signal);
  });
  const w = new DesignWorkbench(0, { preferPro: false, imageGenScript: script });
  instances.push(w);
  return { w, cwd };
}

async function promptsIn(directory: string) {
  return (await readdir(directory)).filter(name => name.startsWith('.prompt-'));
}

describe('managed image generation and editing in cwd', () => {
  it('validates prompts, modes, dimensions, output and reference paths before running', async () => {
    const { w, cwd } = await imageWorkbench();
    for (const invalid of [
      { prompt: '' },
      { mode: 'unknown' },
      { mode: 'edit' },
      { size: '0x100' },
      { size: 'wide' },
      { quality: 'ultra' },
      { background: 'blue' },
      { out: 'x.svg' },
      { background: 'transparent', out: 'x.jpg' },
      { timeoutMs: 900001 },
      { out: '../outside.png' },
      { images: Array(17).fill('x.png') },
      { images: ['missing.png'] },
      { images: ['../outside.png'] },
      { images: ['a.png'], mode: 'generate' },
    ]) {
      await expect(w.image(cwd, { prompt: 'Test', ...invalid } as ImageRequest)).rejects.toThrow();
    }
    expect(ManagedProcesses.prototype.runCommand).not.toHaveBeenCalled();
  });

  it('generates an asset using prompt-file and removes the temporary prompt', async () => {
    const { w, cwd } = await imageWorkbench();
    const prompt = 'A transparent porcelain vase. Literal shell text: $(echo untouched)';
    const result = await w.image(cwd, { prompt, background: 'transparent', model: 'test-model' });
    expect(result).toMatchObject({
      ok: true,
      mode: 'generate',
      model: 'test-model',
      size: '1024x1024',
      quality: 'medium',
      background: 'transparent',
      outputFiles: [join(cwd, 'assets/generated.png')],
    });
    expect(result.data).toMatchObject({ prompt, mode: 'generate' });
    const args = result.data?.args as string[];
    expect(args).toContain('--json');
    expect(args).toContain('--force');
    expect(args).toContain('--prompt-file');
    expect(args).not.toContain(prompt);
    expect(ManagedProcesses.prototype.runCommand).toHaveBeenCalledWith('python3', expect.any(Array), cwd, 180000, undefined);
    expect(await readFile(result.outputFiles[0]!, 'utf8')).toBe('image fixture');
    expect(await promptsIn(join(cwd, 'assets'))).toEqual([]);
    await expect(readFile(String(result.data?.promptFile))).rejects.toThrow();
    await expect(w.image(cwd, { prompt: 'Keep existing', force: false })).rejects.toThrow('already exists');
  });

  it('defaults to edit with media/screenshot references and supports explicit edit mode', async () => {
    const { w, cwd } = await imageWorkbench();
    await mkdir(join(cwd, 'assets/media'), { recursive: true });
    await mkdir(join(cwd, 'shots'), { recursive: true });
    await writeFile(join(cwd, 'assets/media/object.png'), 'reference one');
    await writeFile(join(cwd, 'shots/screen.png'), 'reference two');
    const images = ['assets/media/object.png', 'shots/screen.png'];
    const result = await w.image(cwd, {
      prompt: 'Use image 1 in the composition of image 2',
      images,
      out: 'assets/variant.webp',
      size: '1536x1024',
      quality: 'high',
    });
    expect(result).toMatchObject({ ok: true, mode: 'edit', size: '1536x1024', quality: 'high' });
    const args = result.data?.args as string[];
    expect(args.filter(arg => arg === '--image')).toHaveLength(2);
    for (const image of images) expect(args).toContain(join(cwd, image));
    const explicit = await w.image(cwd, {
      prompt: 'Edit',
      mode: 'edit',
      images: [images[0]!],
      out: 'assets/second.jpeg',
      size: 'auto',
      force: false,
    });
    expect(explicit.ok).toBe(true);
    expect(explicit.data?.args).not.toContain('--force');
    expect((await fetch(`${await w.preview(cwd)}/assets/second.jpeg`)).headers.get('content-type')).toBe('image/jpeg');
    expect(await promptsIn(join(cwd, 'assets'))).toEqual([]);
  });

  it('cleans prompts after a nonzero exit and malformed JSON', async () => {
    const { w, cwd } = await imageWorkbench(`console.error('mock generation failed');console.log('not JSON');process.exitCode=1;`);
    expect(await w.image(cwd, { prompt: 'Fail safely' })).toMatchObject({
      ok: false,
      outputFiles: [],
      data: null,
      stderr: expect.stringContaining('mock generation failed'),
    });
    expect(await promptsIn(join(cwd, 'assets'))).toEqual([]);
  });

  it('cleans prompts on timeout, cancellation and executor rejection', async () => {
    const { w, cwd } = await imageWorkbench(`setInterval(()=>{},1000);`);
    const result = await w.image(cwd, { prompt: 'Wait', timeoutMs: 50 });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('timed out');
    const controller = new AbortController();
    controller.abort();
    await expect(w.image(cwd, { prompt: 'Cancelled' }, controller.signal)).rejects.toThrow('aborted');
    vi.mocked(ManagedProcesses.prototype.runCommand).mockRejectedValueOnce(new Error('python3 unavailable'));
    await expect(w.image(cwd, { prompt: 'Unavailable' })).rejects.toThrow('python3 unavailable');
    expect(await promptsIn(join(cwd, 'assets'))).toEqual([]);
  });

  it('reports a missing local image-gen installation without starting an executor', async () => {
    const { w, cwd } = await setup();
    await expect(w.image(cwd, { prompt: 'An object' })).rejects.toThrow('Local image-gen script not found');
  });
});
