import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import nextEnv from '@next/env';
import dotenv from 'dotenv';
import type { Config, Mode } from './types';

export function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}
export function saveJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}
export function configFor(root: string, args: string[]): Config {
  const projectArg = args.indexOf('--project');
  const project = projectArg >= 0 ? args[projectArg + 1] : 'anilearn';
  if (!project || !/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Compose 项目名无效。');
  const runtime = path.resolve(root, '.anilearn', project);
  const prefs = readJson<{ mode?: Mode; port?: number }>(path.join(runtime, 'preferences.json'));
  const arg = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
  const port = Number(arg('--port') ?? prefs?.port ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口须为 1024–65535 的整数。');
  const mode = arg('--mode') ?? prefs?.mode ?? 'production';
  if (mode !== 'production' && mode !== 'development') throw new Error('模式须为 production 或 development。');
  return { root, runtime, port, mode, envFile: path.resolve(root, arg('--env-file') ?? '.env.local'), composeFile: path.resolve(root, arg('--compose-file') ?? 'compose.yaml'), project };
}
export function loadEnvironment(config: Config) {
  Object.assign(process.env, { NODE_ENV: config.mode });
  nextEnv.loadEnvConfig(config.root, config.mode === 'development', console, true);
  Object.assign(process.env, { NODE_ENV: config.mode });
  // Explicit files are used for isolated lifecycle tests; normal starts retain Next's expansion.
  if (config.envFile !== path.join(config.root, '.env.local') && fs.existsSync(config.envFile)) {
    Object.assign(process.env, dotenv.parse(fs.readFileSync(config.envFile)));
  }
  return { ...process.env };
}
export function fingerprint(root: string) {
  const hash = crypto.createHash('sha256');
  const visit = (relative: string) => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(relative, entry));
    } else { hash.update(relative); hash.update(fs.readFileSync(absolute)); }
  };
  for (const target of ['src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json']) visit(target);
  for (const entry of fs.readdirSync(root).filter(name => /^(?:next|postcss|tailwind)\.config\.[cm]?[jt]s$/.test(name)).sort()) visit(entry);
  // Include configuration in the hash without persisting its content.
  for (const entry of fs.readdirSync(root).filter(name => /^\.env(?:\.|$)/.test(name)).sort()) visit(entry);
  return hash.digest('hex');
}
export function makeRedactor(env: NodeJS.ProcessEnv) {
  const secrets = Object.entries(env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL/i.test(key) && value && value.length >= 4).map(([, value]) => value!).sort((a, b) => b.length - a.length);
  return (input: string) => {
    let text = input.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    for (const secret of secrets) text = text.split(secret).join('[已隐藏]');
    return text.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s/@]+:[^\s/@]+@/gi, '[凭据已隐藏]@')
      .replace(/(?:sk-|xai-|ghp_|github_pat_)[\w-]{16,}/g, '[密钥已隐藏]')
      .replace(/AIza[\w-]{30,}/g, '[密钥已隐藏]')
      .replace(/(?:Bearer\s+|(?:api[_-]?key|password|token)["'\s:=]+)[\w./+=-]{8,}/gi, '[凭据已隐藏]')
      .replace(/([?&](?:key|token|api_key)=)[^&\s]+/gi, '$1[已隐藏]')
      .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[上传内容已隐藏]')
      .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, '[长载荷已隐藏]')
      .slice(0, 2000);
  };
}
export function databaseLog(input: string) {
  // PostgreSQL errors can include SQL, parameters and whole rows on subsequent lines.
  const match = input.match(/^(.*?\b(?:UTC|GMT|[+-]\d{2})\s+\[\d+\]\s+)(LOG|WARNING|ERROR|FATAL|PANIC|DETAIL|CONTEXT|STATEMENT|HINT):\s*(.*)$/);
  if (!match) return '';
  const [, prefix, level, text] = match;
  if (['WARNING', 'ERROR', 'FATAL', 'PANIC'].includes(level)) return `${prefix}${level}: 数据库报告异常，业务错误细节已隐藏。`;
  if (level !== 'LOG') return '';
  if (!/^(?:starting PostgreSQL|listening on|database system|checkpoint |received .*shutdown request|aborting any active|shutting down|background worker)/i.test(text)) return '';
  return input;
}
