import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ProcessIdentity } from './types';

const execute = promisify(execFile);
export interface ProcessRecord { pid: number; created: string; root: string; commandHash: string }
export function recordProcess(identity: ProcessIdentity, root: string): ProcessRecord {
  return { pid: identity.pid, created: identity.created, root: path.resolve(root), commandHash: createHash('sha256').update(identity.command).digest('hex') };
}
export function matchesRecord(identity: ProcessIdentity, record: ProcessRecord, root: string) {
  return record.root?.toLowerCase() === path.resolve(root).toLowerCase() && record.pid === identity.pid && record.created === identity.created && record.commandHash === recordProcess(identity, root).commandHash;
}
export async function powershell(script: string) {
  const encoded = Buffer.from("$ErrorActionPreference='Stop'; " + script, 'utf16le').toString('base64');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15_000, maxBuffer: 4_000_000 });
  return stdout.trim();
}
export async function processes(): Promise<ProcessIdentity[]> {
  if (process.platform !== 'win32') return [];
  const result = await powershell(`$all = Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate, CommandLine, KernelModeTime, UserModeTime, WorkingSetSize FROM Win32_Process'; $rows = @($all | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');command=[string]$_.CommandLine;cpuSeconds=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000;memory=[double]$_.WorkingSetSize} }); ConvertTo-Json -InputObject $rows -Compress`);
  return JSON.parse(result || '[]') as ProcessIdentity[];
}
export function descendants(all: ProcessIdentity[], root: ProcessIdentity) {
  const selected = all.filter(p => sameProcess(p, root));
  for (let index = 0; index < selected.length; index++) {
    for (const p of all) if (p.parentPid === selected[index].pid && Date.parse(p.created) >= Date.parse(selected[index].created) && !selected.some(s => s.pid === p.pid)) selected.push(p);
  }
  return selected;
}
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity) {
  return a.pid === b.pid && a.created === b.created && a.command === b.command;
}
export function belongsToProject(p: ProcessIdentity, root: string) {
  const command = p.command?.toLowerCase().replaceAll('/', '\\') ?? '';
  const project = root.toLowerCase().replaceAll('/', '\\');
  const index = command.indexOf(project);
  const wrapper = project + '\\scripts\\launcher\\server-child.cjs';
  const wrapperIndex = command.indexOf(wrapper);
  const executable = /(?:[\\/]|\b)next[\\/]dist[\\/](?:bin[\\/]next(?:[\s"']|$)|server[\\/]lib[\\/]start-server\.js(?:[\s"']|$))/.test(command)
    || (wrapperIndex >= 0 && /[\s"']|^$/.test(command[wrapperIndex + wrapper.length] ?? ''));
  return index >= 0 && /[\\\s"']|^$/.test(command[index + project.length] ?? '') && executable;
}
export async function terminateTree(identity: ProcessIdentity) {
  const all = await processes();
  const selected = descendants(all, identity).reverse();
  for (const p of selected) {
    const current = (await processes()).find(row => sameProcess(row, p));
    if (!current) continue;
    try { process.kill(current.pid, 'SIGTERM'); } catch { /* Process may exit between inspection and termination. */ }
  }
}
export function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
export async function portOwner(port: number): Promise<number | null> {
  try { return Number(await powershell(`Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`)) || null; } catch { return null; }
}
