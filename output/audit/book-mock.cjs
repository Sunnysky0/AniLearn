const msg = (zh, ja = '[calm] 本文を確かめながら、一緒に考えましょう。') => `<msg><zh>${zh}</zh><ja>${ja}</ja></msg>`;
function bookMockResponse(body, system, inputText) {
  if (system.includes('[BOOK_CHUNK]')) return { output: '<chunk-summary>本部分以对话提出概念，逐步检验定义与理由。依据正文块定位论证和转折。</chunk-summary>', ending: body.model === 'audit-book-chunk-once' && inputText.includes('LAST-BOOK-CHUNK-MARKER') ? 'length' : 'stop' };
  if (system.includes('[BOOK_MERGE]')) return { output: '<merged-summary>前文的概念辨析与反例相互联系，按原文顺序保存主要论证及定位。</merged-summary>', ending: 'stop' };
  if (system.includes('[BOOK_CONTEXT]')) return { output: '<book-context>本章从一个概念问题开始，经由对话检验定义，逐步说明论证前提。可结合提供的正文块回查依据。</book-context>', ending: 'stop' };
  if (system.includes('[BOOK_SUMMARY]')) return { output: '<book-summary>## 全书脉络\n五篇对话通过不同问题检验概念与理由。阅读时应区分提问、主张、论据和反例，并结合各篇原文核对。</book-summary>', ending: 'stop' };
  if (!system.includes('[BOOK_TURN]')) return null;
  if (body.model === 'audit-book-error') return { output: '', ending: 'error' };
  if (/告别|道别|goodbye/.test(system) && /本轮仅|仅简短|学生要结束|intent.*goodbye/.test(system)) return { output: msg('今天先读到这里。书签和笔记已经保留，下次可以继续。') + '<action>wait</action>', ending: 'stop' };
  const targetQuotes = [...system.matchAll(/<quote\s+[^>]*(?:block|paragraph)="([^"]+)"[^>]*>([\s\S]*?)<\/quote>/g)].filter(match => !/对应|稳定/.test(match[1]));
  if (targetQuotes.length && /划词|快捷|selectionTask/.test(system)) {
    let quotes = targetQuotes.map(match => match[0]).join('');
    if (body.model === 'audit-book-selection-wrong') quotes = quotes.replace(/>[^<]+<\/quote>/, '>invented phrase</quote>');
    return { output: quotes + msg('选中表达的含义需要结合当前语境理解。这里强调概念与具体论证之间的关系。') + msg('可以把它放回原句，检查它描述的是对象、理由还是结论。') + '<action>wait</action>', ending: 'stop' };
  }
  if (/chapter_summary|本章总结轮|生成本章总结|所有.*角度.*确认|各规定角度已由学生确认/.test(system)) return { output: msg('这一章通过提问和反例澄清核心概念，也检验了论证的前提。') + '<analysis-summary>## 本章总结\n明确核心概念，区分主张与理由，并用反例检验论证。相关依据可回到本章原文核对。</analysis-summary><action>wait</action>', ending: 'stop' };
  const focus = /<analysis-note focus="([^"]+)"/.exec(system)?.[1];
  return { output: msg('先看这一段提出的主张，再辨认支持它的理由。') + msg('两者之间是否还隐含了一个需要说明的前提？') + (focus && /chapter_analysis|本章导读|章节分析/.test(system) ? `<analysis-note focus="${focus}">## 导读要点\n区分主张与理由，核对其中的隐含前提，并回到本章正文确认。</analysis-note>` : '') + '<action>wait</action>', ending: 'stop' };
}
module.exports = { bookMockResponse };
