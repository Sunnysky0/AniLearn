import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { powershell, processes } from './processes';

const windowsOnly = { skip: process.platform !== 'win32', timeout: 30_000 };

test('PowerShell JSON preserves Chinese, Japanese, quotes and Windows paths', windowsOnly, async () => {
  const command = 'node "D:\\学习\\日本語\\AniLearn" --title “牧濑红莉栖” --note \'こんにちは\' ‘引用’';
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  const output = await powershell(`$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); ConvertTo-Json -InputObject ([pscustomobject]@{command=$value}) -Compress`);
  assert.ok(!output.startsWith('\uFEFF'), 'PowerShell output must not contain a BOM');
  assert.deepEqual(JSON.parse(output), { command });
});

test('Windows process enumeration preserves a real Unicode command line', windowsOnly, async () => {
  const marker = 'AniLearn 进程探针 “日本語” C:\\学习\\测试';
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { windowsHide: true, stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    const rows = await processes();
    assert.ok(Array.isArray(rows));
    assert.ok(rows.some(row => row.pid === process.pid), 'The current process must be present');
    const probe = rows.find(row => row.pid === child.pid);
    assert.ok(probe, 'The owned probe process must be present');
    assert.equal(probe.parentPid, process.pid);
    assert.ok(Number.isFinite(Date.parse(probe.created)));
    assert.ok(probe.command.includes(marker), 'The Unicode command line must remain intact');
    assert.ok(Number.isFinite(probe.cpuSeconds) && Number.isFinite(probe.memory));
  } finally {
    if (child.pid && child.exitCode === null && !child.signalCode) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
});
