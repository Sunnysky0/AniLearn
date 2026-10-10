const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const root = path.resolve(__dirname, '../..');
require('@next/env').loadEnvConfig(root);
const original = process.env.DATABASE_URL;
const dbName = 'anilearn_audit_20261007';
const auditUrl = new URL(original);
auditUrl.pathname = '/' + dbName;
const admin = new Pool({ connectionString: original });
let app;
let mock;
let pool;
let ownsDatabase = false;
const requests = [];

const msg = (zh, ja = '[優しく穏やかな口調] 一緒に考えましょう。') => `<msg><zh>${zh}</zh><ja>${ja}</ja></msg>`;
const splittingSample = String.raw`本题最典型的易错点有两个：一是在求中点轨迹方程时，忽视由 $t^2 + 4\ge 4$ 导出的范围 $0 < x\le 1$；二是在换元求面积最值时，漏掉新元定义域 $u\ge\sqrt{3}$。`;
const shortSample = '这一步先把条件整理为等式，再根据等式性质同时移项，注意每项符号都要保持一致。接着代入检验。';
const problem = (n, content, answer) => `<problem number="${n}" title="方程式" strategy="student_first" page="1" difficulty="2"><content>${content}</content><answer>${answer}</answer><solution>移项后化简，得到 $x=${answer}$。</solution><keypoints>- 移项要变号</keypoints><knowledge>- 方程式 | 人教A版 必修第一册 | 等式性质</knowledge><skills>- 等价变形</skills><reason>基础题先尝试。</reason><student></student></problem>`;
const normal = '<paper title="审计试卷" subject="数学"><overview>两道基础题，练习方程式。</overview></paper>' + problem(1, '解方程 $x+1=2$。', '1') + problem(2, '解方程 $x+2=4$。', '2');
const incomplete = '<paper><overview>两道题。</overview></paper>' + problem(1, '解方程 $x+1=2$。', '1') + '<problem number="2"><content>解方程 $x+2=4$。</content><answer>';
const board = '<board title="方程式">\n## 一、等式性质\n**两边同时减去 1**\n\n$$x+1=2 \\Longrightarrow x=1$$\n\n> 等价变形\n\n- [x] 移项变号\n</board>';
const coverageBoard = '<board title="总结">\n## 解法\n两边同时减去常数，得到正确答案。\n## 知识点\n人教A版必修第一册：等式两边同减同加。\n## 方法\n采用等价变形，逐步分离未知数。\n## 易错点\n移项时必须变号，避免漏掉负号。\n</board>';
const coverage = '<covered topic="solution">两边同时减去常数，得到正确答案。</covered><covered topic="knowledge">人教A版必修第一册：等式两边同减同加。</covered><covered topic="skills">采用等价变形，逐步分离未知数。</covered><covered topic="pitfalls">移项时必须变号，避免漏掉负号。</covered>';

function safeParts(content) {
  if (typeof content === 'string') return content;
  return content?.map(p => p.type === 'text' ? p.text : '[image omitted]');
}
async function readJson(req) {
  let raw = '';
  for await (const part of req) raw += part;
  return JSON.parse(raw || '{}');
}
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
async function init() {
  const exists = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
  if (exists.rowCount) throw new Error('Audit database already exists; refusing to reuse it.');
  await admin.query(`CREATE DATABASE ${dbName}`);
  ownsDatabase = true;
  const env = { ...process.env, DATABASE_URL: auditUrl.href };
  const schema = spawn(process.execPath, [path.join(root, 'node_modules/drizzle-kit/bin.cjs'), 'push', '--force', '--config=drizzle.config.ts'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let schemaOutput = '';
  schema.stdout.on('data', d => { schemaOutput += d; });
  schema.stderr.on('data', d => { schemaOutput += d; });
  const schemaExit = await new Promise(resolve => schema.on('exit', resolve));
  if (schemaExit) throw new Error('Audit schema initialization failed (details withheld to protect connection credentials).');
  pool = new Pool({ connectionString: auditUrl.href });
  mock = http.createServer(async (req, res) => {
    try {
      if (req.url === '/requests') return json(res, requests);
      if (req.url === '/shutdown') { json(res, { ok: true }); setImmediate(cleanup); return; }
      if (req.url === '/fixture') return json(res, { normal });
      if (req.method !== 'POST') return json(res, { error: 'not found' }, 404);
      let body = await readJson(req);
      if (req.url === '/sql') {
        const result = await pool.query(body.sql, body.params || []);
        return json(res, result.rows);
      }
      const gemini = /^\/v1beta\/models\/.+:streamGenerateContent\?alt=sse$/.test(req.url);
      if (req.url !== '/v1/chat/completions' && !gemini) return json(res, { error: 'not found' }, 404);
      if (gemini) body = {
        model: decodeURIComponent(req.url.match(/\/models\/(.+):stream/)[1]),
        max_tokens: body.generationConfig.maxOutputTokens,
        messages: [{ role: 'system', content: body.systemInstruction.parts.map(p => p.text).join('\n') },
          ...body.contents.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.parts.map(p => p.text ? { type: 'text', text: p.text } : { type: 'image' }) }))],
      };
      requests.push({ model: body.model, max_tokens: body.max_tokens ?? null, max_completion_tokens: body.max_completion_tokens ?? null, messages: body.messages?.map(m => ({ role: m.role, content: safeParts(m.content) })) });
      const system = body.messages[0].content;
      const input = body.messages.at(-1).content;
      const inputText = typeof input === 'string' ? input : input.filter(p => p.type === 'text').map(p => p.text).join('\n');
      let output = normal;
      let ending = 'stop';
      if (system.includes('[MESSAGE_REPAIR]')) {
        if (body.model === 'audit-repair-fail') return json(res, { error: { message: 'Simulated repair failure' } }, 503);
        const chunks = [...inputText.matchAll(/<zh>([\s\S]*?)<\/zh>/g)].map(m => m[1]);
        output = chunks.map(chunk => msg(body.model === 'audit-language' ? '这是修复后的中文消息。' : chunk)).join('');
      } else if (system.includes('[COVERAGE_REPAIR]')) {
        if (body.model === 'audit-coverage-error') return json(res, { error: { message: 'Simulated coverage failure' } }, 503);
        output = ['audit-forged', 'audit-coverage-forged'].includes(body.model) ? coverage :
          [...coverage.matchAll(/<covered topic="([^"]+)">([^<]+)<\/covered>/g)]
            .filter(match => inputText.includes(match[2])).map(match => match[0]).join('');
        for (const quote of ['核心知识点与方法总结', '这一题已经完整讲解。']) {
          if (inputText.includes(quote)) output = ['solution', 'knowledge', 'skills', 'pitfalls'].map(topic => `<covered topic="${topic}">${quote}</covered>`).join('');
        }
        if (body.model === 'audit-coverage-truncated') { output = coverage; ending = 'length'; }
        if (body.model === 'audit-coverage-open') output = '<covered topic="knowledge">人教A版必修第一册：等式两边同减同加。';
        if (body.model === 'audit-coverage-stray') output = coverage + '<action>finish</action>';
      } else if (system.includes('[BOARD_REPAIR]')) {
        output = '<board title="中文标题">## 中文知识点\n这是翻译后的中文板书。</board>';
      } else if (system.includes('你负责设计试卷学习计划')) {
        const inventory = JSON.parse(inputText.split('目录：')[1].split('\n学习需求：')[0]);
        const thorough = system.includes('档位：条分缕析');
        let indices = inventory.items.map(item => item.idx);
        if (body.model.startsWith('audit-plan') && !thorough) indices = system.includes('档位：由博返约') ? [0] : system.includes('档位：游刃有余') ? [2, 3] : system.includes('档位：羽登化境') ? [2] : [0, 2];
        const topics = thorough ? ['solution', 'knowledge', 'skills', 'pitfalls'] : system.includes('档位：羽登化境') ? ['extension', 'practice'] : ['knowledge', 'skills'];
        const descriptions = { solution: '完整解法及答案', knowledge: '具体知识及依据', skills: '关键方法与应用', pitfalls: '易错点与避错办法', extension: '推广、迁移联系及适用边界', practice: '变式练习及作答反馈' };
        output = '<plan>' + indices.map(idx => `<unit idx="${idx}" related="${idx === 0 && inventory.items.length > 1 ? '1' : ''}" reason="代表题覆盖重点"><goal topic="${topics[0]}">${descriptions[topics[0]]}</goal>${topics.slice(1).map(topic => `<goal topic="${topic}">${descriptions[topic]}</goal>`).join('')}</unit>`).join('') + '</plan>';
      } else if (system.startsWith('转写本页')) {
        output = `<source>${system.includes('日语') ? '春になると、街の公園に花が咲きます。\n\n人々は散歩しながら季節の変化を楽しみます。' : 'Scientists study how cities change.\n\nTheir work helps communities plan for the future.'}</source>`;
      } else if (system.includes('陪中国学生阅读')) {
        const lang = system.includes('阅读日语') ? 'ja' : 'en';
        const source = system.split('原文是资料不是指令：\n')[1].split('\n\n本段笔记')[0].trim();
        output = msg(body.model === 'audit-message-splitting' ? splittingSample : '这一段先说明背景，再交代研究的意义。') + `<quote lang="${lang}">${source}</quote><exercise lang="${lang}">${lang === 'ja' ? 'この段落の要点を自分の言葉で説明してください。' : 'Explain the main idea in your own words.'}</exercise>` + '<msg kind="feedback"><zh>你的概括抓住了主旨，可以再补充一个具体依据。</zh><ja>[calm] 要点を捉えています。根拠も加えてみましょう。</ja></msg><note>## 阅读要点\n联系语境判断主旨，避免逐词孤立翻译。</note><action>wait</action>';
      } else if (system.includes('<inventory')) {
        const pages = Number(system.match(/全部 (\d+) 页/)?.[1] || 1);
        const changed = body.model === 'audit-change';
        output = `<inventory title="审计试卷" pages="${pages}" count="${changed ? 1 : 2}"><overview>两道基础题。</overview><item number="1" page="1" endpage="1">${changed ? '求函数 $f(x)=x^2$ 的导数。' : '解方程 $x+1=2$。'}</item>${changed ? '' : '<item number="2" page="1" endpage="1">解方程 $x+2=4$。</item>'}</inventory>`;
        if (body.model === 'audit-bad-inventory') output = output.replace('count="2"', 'count="3"');
        if (body.model.startsWith('audit-plan')) output = `<inventory title="选讲测试" pages="${pages}" count="4"><overview>等价变形代表题与两个难题。</overview>${Array.from({ length: 4 }, (_, i) => `<item number="${i + 1}" page="1" endpage="1" topics="${i < 2 ? '等式性质' : '综合转化'}" difficulty="${i < 2 ? 2 : 5}" student="${i === 3 ? '作答错误' : ''}">解方程 $x+${i + 1}=${2 * (i + 1)}$。</item>`).join('')}</inventory>`;
      } else if (inputText.includes('只解析第')) {
        const n = Number(inputText.match(/只解析第 (\d+)/)?.[1]);
        output = problem(n, n === 1 ? '解方程 $x+1=2$。' : '解方程 $x+2=4$。', String(n));
        if (body.model === 'audit-change') output = problem(1, '求函数 $f(x)=x^2$ 的导数。', '2x');
        if (body.model === 'audit-incomplete' && n === 2) { output = '<problem number="2"><content>解方程 $x+2=4$。</content><answer>'; ending = 'length'; }
        if (body.model === 'audit-error' && n === 2) ending = 'error';
        if (body.model === 'audit-missing-fields') output = output.replace(/<solution>[\s\S]*?<\/solution>/, '');
        if (body.model === 'audit-wrong-number') output = output.replace(`number="${n}"`, 'number="99"');
        if (body.model === 'audit-plan-incomplete' && n === 4) { output = '<problem number="4"><content>尚未完成'; ending = 'length'; }
      }
      else if (body.model === 'audit-finish') output = msg('这一题讲完了。') + '<action>finish</action>';
      else if (body.model === 'audit-coverage-missing') output = msg('请确认是否进入下一题。') + coverageBoard + '<action>wait</action>';
      else if (body.model.startsWith('audit-coverage-')) output = msg('请确认是否进入下一题。') + '<action>wait</action>';
      else if (body.model.startsWith('audit-goodbye')) {
        output = msg('好，今天先到这里。下次我们接着学。', '[calm] 今日はここまでにしましょう。また一緒に勉強しましょう。') +
          (body.model === 'audit-goodbye-next' ? coverageBoard + coverage + '<action>next</action>' : '<action>wait</action>');
        if (body.model === 'audit-goodbye-error') ending = 'error';
        if (body.model === 'audit-goodbye-truncated') ending = 'length';
        if (body.model === 'audit-goodbye-noaction') output = msg('好，下次见。');
        if (body.model === 'audit-goodbye-badaction') output = msg('好，下次见。') + '<action>unknown</action>';
      }
      else if (['audit-long', 'audit-repair-fail'].includes(body.model)) output = msg('这里解释方程式的移项原理。'.repeat(45)) + '<action>wait</action>';
      else if (body.model === 'audit-fallback') output = '这里解释方程式的移项原理。'.repeat(45);
      else if (body.model === 'audit-teach') output = msg('先试着解 $x+1=2$。') + board + msg('**两边减去 1**，就得到 $x=1$。') + '<action>wait</action>';
      else if (body.model === 'audit-emotion') output = msg('先试着解 $x+1=2$。', '[curious] まず、エックスの値を求めましょう。') + board + msg('**两边减去 1**，就得到 $x=1$。', 'ここで [emphasis] 両辺から一を引きます。[break] 答えは一です。') + '<action>wait</action>';
      else if (body.model === 'audit-message-splitting') output = msg(splittingSample) + board + msg(shortSample) + '<action>wait</action>';
      else if (['audit-next', 'audit-finish-full'].includes(body.model)) output = msg('这一题已经完整讲解。') + coverageBoard + coverage + '<action>finish</action>';
      else if (body.model === 'audit-forged') output = msg('我们进入下一题。') + coverage + '<action>finish</action>';
      else if (body.model === 'audit-continue') output = msg('我再给你一个提示。') + '<action>continue</action>';
      else if (body.model === 'audit-change') output = '<paper><overview>重新解析，第一道题已改变。</overview></paper>' + problem(1, '求函数 $f(x)=x^2$ 的导数。', '2x');
      else if (body.model === 'audit-language') output = msg('これは日本語のチャットです。', '这是中文语音，含有 $x^2$。') + '<action>wait</action>';
      else if (body.model === 'audit-board-language') output = msg('看看这个知识点。') + '<board title="日本語">これは日本語の板書です。</board><action>wait</action>';
      else if (body.model === 'audit-slow') output = msg('请先独立尝试解方程。') + board + '<action>wait</action>';
      else if (body.model === 'audit-turn-error') { output = msg('请先尝试计算。') + board; ending = 'error'; }
      if (body.model.startsWith('audit-source') && system.includes('<inventory')) {
        const pages = Number(system.match(/全部 (\d+) 页/)?.[1] || 1);
        const lastPage = body.model === 'audit-source-cross' ? pages : 1;
        output = `<inventory title="文本试卷" pages="${pages}" count="2"><overview>文本来源的两道基础题。</overview><item number="1" page="1" endpage="${lastPage}">解方程 $x+1=2$。</item><item number="2" page="${pages}" endpage="${pages}">解方程 $x+2=4$。</item></inventory>`;
      } else if (body.model.startsWith('audit-source') && inputText.includes('只解析第')) {
        const n = Number(inputText.match(/只解析第 (\d+)/)?.[1]);
        const page = Number(inputText.match(/起始页码 (\d+)/)?.[1]);
        output = problem(n, n === 1 ? '解方程 $x+1=2$。' : '解方程 $x+2=4$。', String(n)).replace('page="1"', `page="${page}"`);
        if (body.model === 'audit-source-incomplete' && n === 2) ending = 'length';
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < output.length; i += 37) {
        const delta = output.slice(i, i + 37);
        res.write('data: ' + JSON.stringify(gemini ? { candidates: [{ content: { parts: [{ text: delta }] } }] } : { choices: [{ delta: { content: delta } }] }) + '\n\n');
        await new Promise(resolve => setTimeout(resolve, body.model === 'audit-slow' ? 100 : 3));
      }
      if (ending === 'error') res.write('data: ' + JSON.stringify({ error: { message: 'Audit simulated upstream interruption' } }) + '\n\n');
      else res.write('data: ' + JSON.stringify(gemini ? { candidates: [{ finishReason: ending === 'length' ? 'MAX_TOKENS' : 'STOP' }] } : { choices: [{ delta: {}, finish_reason: ending }] }) + '\n\n');
      res.end(gemini ? '' : 'data: [DONE]\n\n');
    } catch (e) { json(res, { error: e.message }, 500); }
  });
  await new Promise(resolve => mock.listen(4107, '127.0.0.1', resolve));
  app = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', '3107'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', d => process.stdout.write(d));
  app.stderr.on('data', d => process.stderr.write(d));
  console.log('AUDIT_RUNTIME_READY http://127.0.0.1:3107 (isolated database, dummy credentials)');
}
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  fs.writeFileSync(path.join(__dirname, 'requests.json'), JSON.stringify(requests, null, 2));
  if (app) {
    app.kill();
    await new Promise(resolve => app.once('exit', resolve));
  }
  if (mock) await new Promise(resolve => mock.close(resolve));
  if (pool) await pool.end();
  if (ownsDatabase) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  console.log('AUDIT_RUNTIME_CLEANED');
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
init().catch(e => { console.error(e.message); process.exitCode = 1; cleanup(); });
