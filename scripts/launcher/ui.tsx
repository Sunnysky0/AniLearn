import { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { spawn } from 'node:child_process';
import type { Connection } from './ipc';
import type { Command, LogLine, Sample, ServiceState, Snapshot } from './types';

const cyan = '#78dce8', pink = '#ff79c6', muted = '#777b89', white = '#d8dbe2', green = '#60e69b';
const sourceNames = { app: '应用', database: '数据库', launcher: '启动器' };
const states: Record<ServiceState, string> = { stopped: '已停止', starting: '启动中', running: '运行中', error: '异常' };
const logo = [
  '    _          _ _',
  '   /_\\  _ __ (_) |    ___  __ _ _ __ _ __',
  "  / _ \\| '_ \\| | |   / _ \\/ _` | '__| '_ \\",
  ' /_/ \\_\\_| |_|_|_|___\\___/\\__,_|_|  |_| |_|',
];
export function bytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '不可用';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let n = value / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function filterLogs(logs: LogLine[], source: string, search: string, errors: boolean, ceiling: number | null) {
  return logs.filter(line => (source === 'all' || line.source === source) && (!search || line.text.toLowerCase().includes(search.toLowerCase())) && (!errors || line.level === 'error') && (ceiling === null || line.id <= ceiling));
}
function Panel({ title, color = muted, children, ...size }: { title: string; color?: string; children: React.ReactNode; width?: number | string; height?: number; flexGrow?: number }) {
  return <Box {...size} borderStyle="single" borderColor={color} flexDirection="column" paddingX={1} overflow="hidden"><Text color={color} bold>{title}</Text>{children}</Box>;
}
function Service({ name, state }: { name: string; state: ServiceState }) {
  return <Box justifyContent="space-between"><Text color={white}>{name}</Text><Text color={state === 'running' ? green : state === 'error' ? pink : muted}>{state === 'running' ? '●' : '○'} {states[state]}</Text></Box>;
}
function Graph({ samples, field, width, color, scale }: { samples: Sample[]; field: keyof Omit<Sample, 'time'>; width: number; color: string; scale?: number }) {
  const last = samples.at(-1)?.[field] ?? null;
  const size = Math.max(8, width - 2);
  const values = samples.length <= size ? samples.map(sample => sample[field]) : Array.from({ length: size }, (_, i) => samples[Math.min(samples.length - 1, Math.floor(i * samples.length / size))][field]);
  const max = scale ?? Math.max(1, ...values.map(value => value ?? 0));
  const blocks = ' ▁▂▃▄▅▆▇█';
  const chart = values.map(value => value === null ? '·' : blocks[Math.min(8, Math.ceil(value / max * 8))]).join('').padStart(size, ' ');
  return <Box flexDirection="column"><Text color={color}>{chart}</Text><Box justifyContent="space-between"><Text color={muted}>−2 分钟</Text><Text color={color}>{last === null ? '不可用' : scale === 100 ? `${last.toFixed(1)}%` : bytes(last) + (field.endsWith('Memory') ? '' : '/s')}</Text></Box></Box>;
}
function Resources({ state, width, height, metric }: { state: Snapshot; width: number; height: number; metric: 'cpu' | 'memory' | 'network' }) {
  const latest = state.samples.at(-1);
  return <Panel title="RESOURCE / 资源" color={cyan} width={width} height={height}>
    <Text color={muted}>C CPU · V 内存 · N 数据库流量</Text>
    <Text color={white}>{metric === 'network' ? '数据库容器 · 接收' : metric === 'memory' ? '应用内存' : '应用 CPU'}<Text color={muted}>{metric === 'cpu' ? ' · ' + bytes(latest?.appMemory ?? null) : ''}</Text></Text>
    <Graph samples={state.samples} field={metric === 'network' ? 'rx' : metric === 'memory' ? 'appMemory' : 'appCpu'} scale={metric === 'cpu' ? 100 : undefined} width={width - 4} color={cyan} />
    <Text color={white}>{metric === 'network' ? '数据库容器 · 发送' : metric === 'memory' ? 'PostgreSQL 内存' : 'PostgreSQL CPU'}<Text color={muted}>{metric === 'cpu' ? ' · ' + bytes(latest?.dbMemory ?? null) : ''}</Text></Text>
    <Graph samples={state.samples} field={metric === 'network' ? 'tx' : metric === 'memory' ? 'dbMemory' : 'dbCpu'} scale={metric === 'cpu' ? 100 : undefined} width={width - 4} color={green} />
    {height >= 15 && metric !== 'network' && <><Text color={white}>数据库容器流量 · 接收</Text><Graph samples={state.samples} field="rx" width={width - 4} color={cyan} />
      <Text color={muted}>发送 {latest?.tx === null || latest?.tx === undefined ? '不可用' : bytes(latest.tx) + '/s'}</Text></>}
  </Panel>;
}
function Database({ state, width, height, offset }: { state: Snapshot; width: number; height: number; offset: number }) {
  const stats = state.stats;
  const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);
  const row = (name: string, value: number | string) => <Box key={name} justifyContent="space-between"><Text color={white}>{name}</Text><Text color={cyan}>{value}</Text></Box>;
  const depths = new Map<number, number>();
  const processRows = state.processes.map(p => {
    const depth = depths.has(p.parentPid) ? depths.get(p.parentPid)! + 1 : 0;
    depths.set(p.pid, depth);
    return [`${'  '.repeat(Math.min(depth, 4))}${depth ? '└ ' : ''}PID ${p.pid}`, bytes(p.memory)] as [string, string];
  });
  const entries: Array<[string, string | number]> = stats ? [
    ['数据库大小', bytes(stats.size)], ['连接数', stats.connections], ['试卷', sum(stats.papers)],
    ['待解析 / 解析中', `${stats.papers.uploaded ?? 0} / ${stats.papers.analyzing ?? 0}`],
    ['就绪 / 失败', `${stats.papers.ready ?? 0} / ${stats.papers.failed ?? 0}`],
    ['课堂 · 未完成 / 已完成', `${stats.sessions.active ?? 0} / ${stats.sessions.completed ?? 0}`],
    ['导师 / 题目', `${stats.counts.tutors} / ${stats.counts.problems}`], ['消息 / 板书', `${stats.counts.messages} / ${stats.counts.boards}`],
    ['应用进程树', state.processes.length], ...processRows,
  ] : [];
  const capacity = Math.max(1, height - 4);
  const start = Math.min(offset, Math.max(0, entries.length - capacity));
  return <Panel title="DATABASE / 后台统计" width={width} height={height}>
    {!stats ? <Box flexGrow={1} justifyContent="center" alignItems="center"><Text color={muted}>{state.database === 'stopped' ? '数据库已停止' : '统计暂不可用'}</Text></Box> : <>
      {entries.slice(start, start + capacity).map(([label, value]) => row(label, value))}
      {entries.length > capacity && <Text color={muted}>↑↓ 统计 · {start + 1}–{Math.min(entries.length, start + capacity)} / {entries.length}</Text>}
    </>}
  </Panel>;
}
const menu: Array<{ label: string; key: string; command?: Command }> = [
  { label: '启动全部服务', key: 'S', command: 'start' }, { label: '停止全部服务', key: 'X', command: 'stop' },
  { label: '重启应用', key: 'R', command: 'restart' }, { label: '切换生产 / 开发', key: 'M', command: 'mode' },
  { label: '重新构建并启动', key: 'B', command: 'build' }, { label: '打开网页', key: 'O' },
  { label: '关闭全部并退出', key: 'Q', command: 'shutdown' }, { label: '保留后台并退出', key: 'D', command: 'detach' },
];
export function Dashboard({ connection }: { connection: Connection }) {
  const { stdout } = useStdout();
  const [state, setState] = useState(connection.snapshot!);
  const [size, setSize] = useState({ width: stdout.columns || 120, height: stdout.rows || 36 });
  const [now, setNow] = useState(() => Date.now());
  const [source, setSource] = useState('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState(false);
  const [offset, setOffset] = useState(0);
  const [ceiling, setCeiling] = useState<number | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [selected, setSelected] = useState(0);
  const [tab, setTab] = useState(0);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [metric, setMetric] = useState<'cpu' | 'memory' | 'network'>('cpu');
  const [statsOffset, setStatsOffset] = useState(0);
  useEffect(() => {
    const update = (snapshot: Snapshot) => setState({ ...snapshot });
    connection.on('snapshot', update);
    const resize = () => setSize({ width: stdout.columns || 120, height: stdout.rows || 36 });
    stdout.on('resize', resize);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { connection.off('snapshot', update); stdout.off('resize', resize); clearInterval(timer); };
  }, [connection, stdout]);
  const width = Math.max(30, size.width), height = Math.max(12, size.height - 1);
  const narrow = width < 110 || height < 32;
  const logs = filterLogs(state.logs, source, search, errors, ceiling);
  const leftWidth = narrow ? width : Math.floor(width * .64);
  const rightWidth = width - leftWidth;
  const statusHeight = narrow ? 4 : 9;
  const bodyHeight = height - statusHeight - 4;
  const resourceHeight = bodyHeight >= 30 ? 16 : 10;
  const capacity = Math.max(1, bodyHeight - 5);
  const end = Math.max(0, logs.length - offset), shown = logs.slice(Math.max(0, end - capacity), end);
  const act = (item: typeof menu[number]) => {
    if (!item.command) spawn('rundll32.exe', ['url.dll,FileProtocolHandler', `http://127.0.0.1:${state.port}`], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    else if (item.command === 'detach') { setConfirmDetach(true); return; }
    else connection.command(item.command);
    setShowMenu(false);
  };
  const menuCapacity = Math.max(1, bodyHeight - 4);
  const menuStart = Math.max(0, selected - menuCapacity + 1);
  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || (!editing && input.toLowerCase() === 'q')) { connection.command('shutdown'); return; }
    if (confirmDetach) { if (input.toLowerCase() === 'y') connection.command('detach'); if (key.escape || input.toLowerCase() === 'n') setConfirmDetach(false); return; }
    if (editing) {
      if (key.return || key.escape) setEditing(false);
      else if (key.backspace || key.delete) setSearch(value => Array.from(value).slice(0, -1).join(''));
      else if (!key.ctrl && input) setSearch(value => value + input);
      setOffset(0); return;
    }
    if (showMenu) {
      if (key.escape || input.toLowerCase() === 'h') setShowMenu(false);
      else if (key.upArrow) setSelected(value => (value + menu.length - 1) % menu.length);
      else if (key.downArrow) setSelected(value => (value + 1) % menu.length);
      else if (key.return) act(menu[selected]);
      else { const item = menu.find(item => item.key.toLowerCase() === input.toLowerCase()); if (item) act(item); }
      return;
    }
    const item = menu.find(item => item.key.toLowerCase() === input.toLowerCase());
    if (item) { act(item); return; }
    if (input.toLowerCase() === 'h') setShowMenu(true);
    if (key.tab) setTab(value => (value + 1) % 3);
    if (input === '/') setEditing(true);
    if (input.toLowerCase() === 'e') { setErrors(value => !value); setOffset(0); }
    if (input === ' ') { setCeiling(value => value === null ? (state.logs.at(-1)?.id ?? 0) : null); setOffset(0); }
    if (tab === 2 && (key.upArrow || key.downArrow || key.pageDown || key.pageUp)) {
      setStatsOffset(value => Math.max(0, Math.min(8 + state.processes.length, value + (key.upArrow || key.pageUp ? -1 : 1))));
    } else {
      if (key.upArrow || key.pageUp) { setCeiling(value => value ?? state.logs.at(-1)?.id ?? 0); setOffset(value => Math.max(0, Math.min(logs.length - 1, value + (key.pageUp ? capacity : 1)))); }
      if (key.downArrow || key.pageDown) setOffset(value => Math.max(0, value - (key.pageDown ? capacity : 1)));
    }
    if (key.end) { setCeiling(null); setOffset(0); }
    if (/^[1-4]$/.test(input)) { setSource(['all', 'app', 'database', 'launcher'][Number(input) - 1]); setOffset(0); }
    if (input.toLowerCase() === 'c') setMetric('cpu');
    if (input.toLowerCase() === 'v') setMetric('memory');
    if (input.toLowerCase() === 'n') setMetric('network');
  });
  const logView = <Panel title="LIVE LOG / 实时日志" color={pink} width={leftWidth} height={bodyHeight}>
    <Box gap={1}>{['全部', '应用', '数据库', '启动器'].map((name, i) => <Text key={name} color={source === ['all', 'app', 'database', 'launcher'][i] ? pink : muted}>{i + 1} {name}</Text>)}</Box>
    <Text color={editing ? cyan : muted} wrap="truncate-end">{editing ? '搜索 › ' : search ? '搜索 · ' : ''}{search}{editing ? '▌' : ''}{errors ? ' · 仅错误' : ''}{ceiling !== null ? ' · 已暂停' : ''}</Text>
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {!shown.length ? <Box flexGrow={1} alignItems="center" justifyContent="center"><Text color={cyan}>暂无匹配日志</Text></Box> : shown.map(line => <Text key={line.id} wrap="truncate-end" color={line.level === 'error' ? pink : white}><Text color={muted}>{new Date(line.time).toLocaleTimeString('zh-CN', { hour12: false })} </Text><Text color={line.source === 'app' ? cyan : line.source === 'database' ? green : muted}>[{sourceNames[line.source]}] </Text>{line.text}</Text>)}
    </Box>
    <Text color={muted} wrap="truncate-end">{logs.length} 条 · {ceiling === null ? '实时跟随' : `距底部 ${offset} 条`} · / 搜索 · 空格 暂停 · E 错误</Text>
  </Panel>;
  return <Box width={width} height={height} flexDirection="column" backgroundColor="#090a0d">
    {narrow ? <Box height={statusHeight} flexDirection="column" paddingX={1}>
      <Text color={pink} bold>ANILEARN <Text color={cyan}>/ {state.mode === 'production' ? '生产' : '开发'}</Text></Text>
      <Text color={white} wrap="truncate-end">应用 {states[state.app]} · 数据库 {states[state.database]} · Docker {states[state.docker]} · {state.startedAt ? duration(now - state.startedAt) : '未运行'}</Text>
      <Text color={cyan}>127.0.0.1:{state.port} <Text color={muted}>Tab · {['日志', '资源', '统计'][tab]}</Text></Text>
    </Box> : <Box height={statusHeight}>
      <Panel title="ANILEARN / 控制台" width={leftWidth} height={statusHeight}>
        <Box gap={3}>
          <Box width={44} flexShrink={0} flexDirection="column">{logo.map((line, i) => <Text key={i} color={pink} bold wrap="truncate-end">{line}</Text>)}<Text color={cyan}>EXAM PAPER DRIVEN LEARNING</Text></Box>
          <Box flexGrow={1} flexDirection="column"><Service name="AniLearn" state={state.app} /><Service name="PostgreSQL" state={state.database} /><Service name="Docker 引擎" state={state.docker} /><Text color={muted}>{state.mode === 'production' ? '生产模式' : '开发模式'} · {state.startedAt ? duration(now - state.startedAt) : '未运行'}</Text><Text color={cyan}>http://127.0.0.1:{state.port}</Text></Box>
        </Box>
      </Panel>
      <Panel title="ACTIVITY / 最近活动" width={rightWidth} height={statusHeight}>
        {state.logs.filter(line => line.source === 'launcher').slice(-5).map(line => <Text key={line.id} wrap="truncate-end" color={line.level === 'error' ? pink : cyan}>{line.text}</Text>)}
      </Panel>
    </Box>}
    {showMenu || confirmDetach ? <Panel title="OPERATIONS / 操作" color={pink} width={width} height={bodyHeight}>
      {confirmDetach ? <><Text color={white}>保留 AniLearn 和数据库在后台运行？</Text><Text color={cyan}>Y 保留并退出 · N / Esc 返回</Text></> : menu.slice(menuStart, menuStart + menuCapacity).map((item, i) => <Text key={item.key} color={i + menuStart === selected ? pink : white}>{i + menuStart === selected ? '›' : ' '} {item.key}  {item.label}</Text>)}
      <Text color={muted}>↑↓ 选择 · Enter 执行 · Esc 返回</Text>
    </Panel> : narrow ? tab === 0 ? logView : tab === 1 ? <Resources state={state} metric={metric} width={width} height={bodyHeight} /> : <Database state={state} offset={statsOffset} width={width} height={bodyHeight} /> : <Box height={bodyHeight}>
      {logView}<Box width={rightWidth} flexDirection="column"><Resources state={state} metric={metric} width={rightWidth} height={resourceHeight} /><Database state={state} offset={statsOffset} width={rightWidth} height={bodyHeight - resourceHeight} /></Box>
    </Box>}
    <Box height={4} flexDirection="column" paddingX={1}>
      <Text color={state.error ? pink : cyan} wrap="truncate-end">{state.busy ? '◌ ' : '● '}{state.phase}{state.busy ? ' · ' + duration(now - state.phaseAt) : ''}{state.error ? ' · ' + state.error : ''}</Text>
      <Text color={muted} wrap="truncate-end">S 启动 · X 停止 · R 重启 · M 模式 · B 构建 · O 网页</Text>
      <Text color={muted} wrap="truncate-end">H 操作菜单 · Q 关闭并退出 · D 保留后台 · Tab 面板</Text>
    </Box>
  </Box>;
}
