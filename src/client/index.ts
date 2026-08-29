/**
 * dsh-capture-window · client 捕获窗 + 对话视图
 *
 * 与动态插件 capt-1/pkg-16 语义对齐。数据层全部走官方 ctx.connection.api(IApiClient):
 *   - 提交想法:api.sessions.prompt('/recall ...') 触发 host 命令
 *   - 读消息:api.sessions.history
 *   - 发消息:api.sessions.prompt({ mode: 'queue' | 'steer' })
 *   - 列模型 / 设模型:api.sessions.models / api.sessions.selectModel
 *   - running / pending:api.events.host / api.events.mux 流
 *
 * 正式包 client 是真实浏览器 CJS bundle,setTimeout/document/fetch 均可用
 * (不像动态插件 vm 闭包那样遮蔽)。
 */
import React from 'react';

const PLUGIN = 'dsh-capture-window';

const HOTKEY = (e: KeyboardEvent) => e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k');

const MODES: Record<string, { label: string; title: string }> = {
  paper: { label: '白纸', title: '不带上文：只把这条想法作为新会话首条消息' },
  select: { label: '选择', title: '手动勾选要带过去的消息（默认折叠，点开展开全文）' },
  recall: { label: '近 10 条对话', title: '自动压缩最近 10 句上下文注入新会话（默认）' },
};

function timeNow(): string {
  const d = new Date();
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function pickPreview(t: any): string {
  const one = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return one.length > 80 ? one.slice(0, 80) + '…' : one;
}

/** 解包 RpcResponse<RpcResult<T>> → T,失败抛错。 */
function unwrap<T>(res: any): T {
  const result = res && res.result ? res.result : res;
  if (result && result.ok === false) {
    throw new Error(result.error?.message ?? '请求失败');
  }
  return (result && result.value) as T;
}

function injectStyle(css: string): () => void {
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
  return () => el.remove();
}

/* ---------------- 窗口坐标持久化(localStorage,重启后回到上次摆放位置) ---------------- */

const POS_KEY = 'dsh-capture:pos';
const PANEL_W = 380;
const MARGIN = 8;

/** 读取上次落点,并 clamp 到当前可视区;无记录或读失败则返回 null(用默认位)。 */
function readSavedPos(): { left: number; top: number } | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    const left = Number(p && p.left), top = Number(p && p.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    const w = window.innerWidth, h = window.innerHeight;
    // 若上次坐标已跑出当前视口(窗口/分辨率变化),拉回可视区内
    const cl = Math.max(MARGIN, Math.min(left, w - PANEL_W - MARGIN));
    const ct = Math.max(MARGIN, Math.min(top, h - 160 - MARGIN));
    return { left: cl, top: ct };
  } catch { return null; }
}

function savePos(pos: { left: number; top: number }): void {
  try { window.localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* 忽略 */ }
}

/* ---------------- markdown 渲染(与 pkg-16 一致) ---------------- */

function splitRow(line: string): string[] {
  return String(line == null ? '' : line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function renderInline(text: any): React.ReactNode[] {
  const s = String(text == null ? '' : text);
  const out: React.ReactNode[] = [];
  let i = 0;
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpMatchArray | null;
    if (rest[0] === '`') {
      const end = rest.indexOf('`', 1);
      if (end > 0) {
        flush();
        out.push(React.createElement('code', { className: 'cap-code' }, rest.slice(1, end)));
        i += end + 1;
        continue;
      }
    }
    m = rest.match(/^\*\*\*([^*]+)\*\*\*/);
    if (m) { flush(); out.push(React.createElement('strong', null, React.createElement('em', null, m[1]))); i += m[0].length; continue; }
    m = rest.match(/^\*\*([^*]+)\*\*/);
    if (m) { flush(); out.push(React.createElement('strong', null, m[1])); i += m[0].length; continue; }
    m = rest.match(/^\*([^*\n]+)\*/);
    if (m) { flush(); out.push(React.createElement('em', null, m[1])); i += m[0].length; continue; }
    m = rest.match(/^~~([^~]+)~~/);
    if (m) { flush(); out.push(React.createElement('s', null, m[1])); i += m[0].length; continue; }
    m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
    if (m) {
      flush();
      const href = /^(https?:|mailto:)/i.test(m[2]) ? m[2] : '#';
      out.push(React.createElement('a', { className: 'cap-md-link', href, target: '_blank', rel: 'noopener noreferrer' }, m[1]));
      i += m[0].length;
      continue;
    }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}

function renderMarkdown(text: any): React.ReactNode[] {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return [];
  const lines = s.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) { buf.push(lines[i]); i++; }
      i++;
      out.push(React.createElement('pre', { className: 'cap-pre' }, React.createElement('code', null, buf.join('\n'))));
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && lines[i + 1].trim().match(/^\|[\s:|-]+\|$/)) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      out.push(React.createElement('table', { className: 'cap-table' },
        React.createElement('thead', null, React.createElement('tr', null, header.map((c, ci) => React.createElement('th', { key: ci }, renderInline(c))))),
        React.createElement('tbody', null, rows.map((r, ri) => React.createElement('tr', { key: ri }, r.map((c, ci) => React.createElement('td', { key: ci }, renderInline(c)))))),
      ));
      continue;
    }
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      const lvl = hm[1].length;
      out.push(React.createElement('div', { className: 'cap-h cap-h' + lvl }, renderInline(hm[2])));
      i++;
      continue;
    }
    if (line.match(/^\s*[-*]\s+/)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && lines[i].match(/^\s*[-*]\s+/)) {
        const im = lines[i].match(/^\s*[-*]\s+(.*)$/)!;
        items.push(React.createElement('li', { key: i }, renderInline(im[1])));
        i++;
      }
      out.push(React.createElement('ul', { className: 'cap-list' }, items));
      continue;
    }
    if (line.match(/^\s*\d+[.)]\s+/)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && lines[i].match(/^\s*\d+[.)]\s+/)) {
        const im = lines[i].match(/^\s*\d+[.)]\s+(.*)$/)!;
        items.push(React.createElement('li', { key: i }, renderInline(im[1])));
        i++;
      }
      out.push(React.createElement('ol', { className: 'cap-list' }, items));
      continue;
    }
    if (line.match(/^\s*>\s?/)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].match(/^\s*>\s?/)) {
        buf.push(lines[i].match(/^\s*>\s?(.*)$/)![1]); i++;
      }
      out.push(React.createElement('blockquote', { className: 'cap-quote' }, renderInline(buf.join('\n'))));
      continue;
    }
    if (line.trim().match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      out.push(React.createElement('hr', { className: 'cap-hr' }));
      i++;
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trimStart().startsWith('```') && !lines[i].match(/^(#{1,4})\s/) && !lines[i].match(/^\s*[-*]\s+/) && !lines[i].match(/^\s*\d+[.)]\s+/) && !lines[i].match(/^\s*>\s?/) && !lines[i].trim().startsWith('|') && !lines[i].trim().match(/^(-{3,}|\*{3,}|_{3,})$/)) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) out.push(React.createElement('div', { className: 'cap-p' }, renderInline(buf.join('\n'))));
  }
  return out;
}

const CSS = `
.cap-fab{position:absolute;right:16px;bottom:16px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-floating-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:auto}
.cap-fab:hover{background:var(--dsw-alias-button-floating-hover)}
.cap-panel{position:absolute;width:380px;max-width:calc(100vw - 32px);max-height:calc(100vh - 96px);z-index:2147483000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,.45);overflow:hidden;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;pointer-events:auto}
.cap-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:grab;user-select:none}
.cap-head:active{cursor:grabbing}
.cap-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary);box-shadow:0 0 8px var(--dsw-alias-state-business-primary);flex:0 0 auto}
.cap-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary)}
.cap-spacer{flex:1}
.cap-x{border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;padding:2px 7px;border-radius:6px}
.cap-x:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.cap-body{padding:12px;display:flex;flex-direction:column;gap:10px;overflow-y:auto}
.cap-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;resize:vertical;min-height:64px;outline:none;display:block}
.cap-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.cap-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.cap-mode-row{display:flex;gap:6px}
.cap-mode{flex:1;padding:5px 6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;text-align:center;white-space:nowrap}
.cap-mode:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.cap-mode.active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.cap-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.cap-actions{display:flex;gap:8px}
.cap-primary{flex:1.4;padding:8px 12px;border-radius:8px;border:1px solid transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-weight:600;font-size:13px;cursor:pointer}
.cap-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.cap-primary:disabled{opacity:.55;cursor:default}
.cap-ghost{flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.cap-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cap-status{font-size:12px;color:var(--dsw-alias-state-success-primary);line-height:1.4;word-break:break-word}
.cap-status-err{color:var(--dsw-alias-state-error-primary)}
.cap-recent{display:flex;flex-direction:column;gap:6px}
.cap-recent-head{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cap-recent-head::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1);min-width:20px}
.cap-recent-note{font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.cap-empty{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.cap-item{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.cap-item-text{font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-word;white-space:pre-wrap;max-height:64px;overflow:hidden}
.cap-item-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.cap-item-time{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.cap-item-op{font-size:11px;color:var(--dsw-alias-label-secondary);padding:1px 7px;border-radius:5px;cursor:pointer;border:none;background:none;font:inherit}
.cap-item-op:hover{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cap-item-op.del:hover{color:var(--dsw-alias-state-error-primary)}
.cap-picker{display:flex;flex-direction:column;gap:4px;max-height:420px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px;background:var(--dsw-alias-bg-layer-1)}
.cap-pick{display:flex;flex-direction:column;padding:5px 6px;border-radius:6px;border:1px solid transparent;background:none;font:inherit;text-align:left;width:100%}
.cap-pick.on{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.cap-pick-row{display:flex;align-items:flex-start;gap:6px;cursor:pointer;width:100%}
.cap-pick-role{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-state-business-primary);padding:0 5px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:4px}
.cap-pick-preview{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-size:12px}
.cap-pick-toggle{border:none;background:none;font:inherit;font-size:10.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0 2px;align-self:flex-start}
.cap-pick-toggle:hover{color:var(--dsw-alias-state-business-primary)}
.cap-pick-full{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);font-size:12px;margin-top:4px;max-height:200px;overflow-y:auto;border-top:1px solid var(--dsw-alias-border-l1);padding-top:4px}
.cap-chat-log{display:flex;flex-direction:column;gap:8px;overflow-y:auto;min-height:120px;max-height:320px;padding:2px}
.cap-msg{max-width:92%;padding:7px 10px;border-radius:10px;font-size:12.5px;word-break:break-word;line-height:1.5}
.cap-msg-user{align-self:flex-end;background:var(--dsw-alias-state-business-primary);color:#fff;white-space:pre-wrap}
.cap-msg-assistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.cap-msg-context{align-self:flex-start;background:var(--dsw-alias-bg-layer-1);border:1px dashed var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-secondary);font-size:11.5px;max-width:100%;white-space:pre-wrap}
.cap-p{margin:0 0 6px;white-space:pre-wrap}
.cap-p:last-child{margin-bottom:0}
.cap-h1{font-size:15px;font-weight:700;margin:8px 0 4px}
.cap-h2{font-size:14px;font-weight:700;margin:8px 0 4px}
.cap-h3{font-size:13px;font-weight:700;margin:6px 0 3px}
.cap-h4{font-size:12.5px;font-weight:600;margin:4px 0 2px}
.cap-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px}
.cap-pre{margin:6px 0;padding:8px 10px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow-x:auto}
.cap-pre code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:pre;color:var(--dsw-alias-label-primary)}
.cap-list{margin:4px 0;padding-left:20px}
.cap-list li{margin:2px 0}
.cap-md-link{color:var(--dsw-alias-state-business-primary);text-decoration:none}
.cap-md-link:hover{text-decoration:underline}
.cap-table{border-collapse:collapse;margin:6px 0;width:100%;font-size:12px}
.cap-table th,.cap-table td{border:1px solid var(--dsw-alias-border-l1);padding:4px 8px;text-align:left;color:var(--dsw-alias-label-primary)}
.cap-table th{background:var(--dsw-alias-bg-layer-3);font-weight:600}
.cap-quote{margin:6px 0;padding:4px 10px;border-left:3px solid var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-secondary)}
.cap-hr{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0}
.cap-pending{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-1)}
.cap-pending-text{flex:1;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary)}
.cap-pending-btn{flex:0 0 auto;padding:5px 10px;border-radius:6px;border:1px solid var(--dsw-alias-state-business-primary);background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;cursor:pointer}
.cap-pending-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cap-composer{display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}
.cap-composer:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.cap-chat-input{width:100%;box-sizing:border-box;border:none;background:transparent;padding:9px 11px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;resize:none;min-height:56px;max-height:140px;outline:none;display:block}
.cap-chat-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.cap-composer-bar{display:flex;align-items:center;gap:8px;padding:4px 6px 6px 6px;border-top:1px solid var(--dsw-alias-border-l1)}
.cap-model-select{min-width:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:3px 7px;outline:none;cursor:pointer;max-width:240px}
.cap-model-select option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.cap-chat-send{padding:6px 12px;border-radius:7px;border:1px solid transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-weight:600;font-size:12px;cursor:pointer}
.cap-chat-send:disabled{opacity:.55;cursor:default}
.cap-back{border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:6px}
.cap-back:hover{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
`;

interface CaptureItem {
  id: string;
  kind: 'stash' | 'session';
  text: string;
  time: string;
  sessionId?: string;
  segments?: number;
  summary?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'context';
  text: string;
}

interface PickMessage {
  role: string;
  text: string;
  seq: number;
}

function RecentItem(props: {
  item: CaptureItem;
  onOpen: (sid: string) => void;
  onChat: (sid: string) => void;
  onPromote: (text: string) => void;
  onRemove: (id: string) => void;
}) {
  const item = props.item;
  const isSession = item.kind === 'session';
  return React.createElement('div', { className: 'cap-item' },
    React.createElement('div', { className: 'cap-item-text' }, item.text),
    React.createElement('div', { className: 'cap-item-meta' },
      React.createElement('span', { className: 'cap-item-time' }, item.time + (isSession && (item.segments ?? 0) > 0 ? ' · 带召回 ' + item.segments + ' 段' : '')),
      isSession
        ? React.createElement('button', { className: 'cap-item-op', onClick: () => props.onChat(item.sessionId!) }, '继续聊')
        : React.createElement('button', { className: 'cap-item-op', onClick: () => props.onPromote(item.text) }, '开启对话'),
      (isSession && item.sessionId) ? React.createElement('button', { className: 'cap-item-op', onClick: () => props.onOpen(item.sessionId!) }, '打开') : null,
      React.createElement('button', { className: 'cap-item-op del', onClick: () => props.onRemove(item.id) }, '删除'),
    ),
  );
}

export function apply(ctx: any): void {
  const slots = ctx.get('slots');
  if (!slots) return;
  const connection = ctx.get('connection');
  const api = connection?.api;
  const sessionsSvc = ctx.get('sessions');

  // ---- 会话实时状态(running / pending),由 events 流维护 ----
  interface LiveState { running: boolean; pending: 'approval' | 'question' | null; }
  const liveState = new Map<string, LiveState>();
  const liveListeners = new Set<() => void>();
  const notifyLive = () => { for (const l of Array.from(liveListeners)) l(); };
  const getLive = (sid: string): LiveState => liveState.get(sid) || { running: false, pending: null };

  let ac: AbortController | null = null;
  if (api) {
    ac = new AbortController();
    const signal = ac.signal;
    (async () => {
      try {
        for await (const frame of api.events.host({}, signal)) {
          const f = frame?.payload;
          if (f?.type === 'host/session-status') {
            liveState.set(f.sessionId, { ...getLive(f.sessionId), running: f.running });
            notifyLive();
          }
        }
      } catch { /* stream closed */ }
    })();
    (async () => {
      try {
        for await (const frame of api.events.mux({}, signal)) {
          const f = frame?.payload;
          if (!f) continue;
          if (f.type === 'approval/requested' || f.type === 'question/requested') {
            liveState.set(f.sessionId, { ...getLive(f.sessionId), pending: f.type === 'approval/requested' ? 'approval' : 'question' });
            notifyLive();
          } else if (f.type === 'approval/resolved' || f.type === 'question/resolved') {
            liveState.set(f.sessionId, { ...getLive(f.sessionId), pending: null });
            notifyLive();
          }
        }
      } catch { /* stream closed */ }
    })();
    ctx.effect(() => () => { if (ac) ac.abort(); });
  }

  // ---- 开合状态 ----
  let open = false;
  const listeners = new Set<() => void>();
  const store = {
    get: () => open,
    set: (v: boolean) => { open = !!v; for (const l of Array.from(listeners)) l(); },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    toggle: () => store.set(!open),
  };

  const onKey = (e: KeyboardEvent) => {
    if (HOTKEY(e)) { e.preventDefault(); e.stopPropagation(); store.toggle(); }
    else if (e.key === 'Escape' && store.get()) { e.preventDefault(); store.set(false); }
  };
  document.addEventListener('keydown', onKey, true);
  ctx.effect(() => () => document.removeEventListener('keydown', onKey, true));
  ctx.effect(() => injectStyle(CSS));

  function useStoreValue(): boolean {
    const [v, setV] = React.useState(store.get());
    React.useEffect(() => store.subscribe(() => setV(store.get())), []);
    return v;
  }

  /** 从命令成功文本里提取 recall-* 会话 id。 */
  function extractSessionId(text: string): string | undefined {
    const m = (text || '').match(/recall-[0-9a-f-]+/i);
    return m ? m[0] : undefined;
  }

  /** 从 history events 提取消息(识别 plugin/recall 上下文)。 */
  function eventsToMessages(entries: any[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const entry of entries || []) {
      const e = entry?.event ?? entry;
      if (!e) continue;
      if (e.type === 'user/message') {
        const src = e.data && e.data.source;
        const role = (src && src.kind === 'plugin' && src.form === 'recall') ? 'context' : 'user';
        const text = blocksTextFromEvent(e, 'user');
        if (text) out.push({ role: role as ChatMessage['role'], text });
      } else if (e.type === 'assistant/message') {
        const text = blocksTextFromEvent(e, 'assistant');
        if (text) out.push({ role: 'assistant', text });
      }
    }
    return out;
  }

  function blocksTextFromEvent(e: any, kind: 'user' | 'assistant'): string {
    const blocks = kind === 'user' ? e?.data?.content : e?.data?.message?.content;
    if (!Array.isArray(blocks)) return '';
    return blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text).join('').trim();
  }

  function CaptureApp(props: any) {
    const isOpen = useStoreValue();
    const [recent, setRecent] = React.useState<CaptureItem[]>([]);
    const [idea, setIdea] = React.useState('');
    const [mode, setMode] = React.useState('recall');
    const [busy, setBusy] = React.useState(false);
    const [status, setStatus] = React.useState('');
    const [error, setError] = React.useState('');
    const [pickMsgs, setPickMsgs] = React.useState<PickMessage[]>([]);
    const [picked, setPicked] = React.useState<number[]>([]);
    const [expandedPick, setExpandedPick] = React.useState<Record<number, boolean>>({});
    const [view, setView] = React.useState<'capture' | 'chat'>('capture');
    const [chatSessionId, setChatSessionId] = React.useState<string | null>(null);
    const [chatMessages, setChatMessages] = React.useState<ChatMessage[]>([]);
    const [chatInput, setChatInput] = React.useState('');
    const [chatBusy, setChatBusy] = React.useState(false);
    const [chatPending, setChatPending] = React.useState<'approval' | 'question' | null>(null);
    const [models, setModels] = React.useState<{ provider: string; providerName: string; model: string; name: string }[]>([]);
    const [currentModel, setCurrentModel] = React.useState<{ provider: string; model: string } | null>(null);
    const [pos, setPos] = React.useState(() => {
      const saved = readSavedPos();
      if (saved) return saved;
      const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
      return { left: Math.max(12, w - 380 - 16), top: 140 };
    });
    const dragRef = React.useRef<{ dx: number; dy: number } | null>(null);
    const pickerRef = React.useRef<HTMLDivElement | null>(null);
    const chatLogRef = React.useRef<HTMLDivElement | null>(null);
    // 是否「贴底」：滚回底部为 true，往上翻为 false（避免轮询强制把用户拉回底部）
    const stickToBottomRef = React.useRef(true);
    const onChatLogScroll = () => {
      const el = chatLogRef.current;
      if (!el) return;
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };

    const current: string | undefined = props?.useSessions ? props.useSessions((s: any) => s?.current) : undefined;

    // 选择模式:通过 host 的 webServer 路由拉取对话消息(host 侧已过滤,只回 user/assistant 文本,
    // 避免下发 chunk 碎片;旧 connection.rpc 通道已随 dsh 0.1.1-rc.2 移除)
    React.useEffect(() => {
      if (mode === 'select' && current) {
        let dead = false;
        (async () => {
          try {
            const res = await fetch(`/plugins/capture-window/messages?sessionId=${encodeURIComponent(current)}`, { cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data?.ok === false) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
            const msgs: PickMessage[] = ((data?.value) ?? []).map((m: any) => ({ role: m.role, text: m.text, seq: m.seq }));
            if (!dead) setPickMsgs(msgs);
          } catch (err) { console.error('[dsh-capture] 选择消息拉取失败', err); if (!dead) setPickMsgs([]); }
        })();
        return () => { dead = true; };
      }
    }, [mode, current]);

    React.useEffect(() => {
      if (mode === 'select' && pickerRef.current) {
        pickerRef.current.scrollTop = pickerRef.current.scrollHeight;
      }
    }, [mode, pickMsgs]);

    // 对话日志自动滚动到最新：仅当用户本来就贴底时才跟随，往上翻则不打扰
    React.useEffect(() => {
      const el = chatLogRef.current;
      if (el && stickToBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    }, [chatMessages, chatBusy, chatPending]);

    // chat 视图:轮询 history 读消息 + 读 liveState 的 running/pending
    React.useEffect(() => {
      if (!chatSessionId || !api) return;
      let dead = false;
      let timer: any = null;
      const poll = async () => {
        if (dead) return;
        try {
          const value = unwrap<any>(await api.sessions.history({ sessionId: chatSessionId, maxMessages: 40 }));
          const msgs = eventsToMessages(value?.events ?? []);
          if (!dead) {
            setChatMessages(msgs.slice(-40));
            const live = getLive(chatSessionId);
            setChatBusy(live.running);
            setChatPending(live.pending);
          }
        } catch { /* ignore */ }
        if (!dead) timer = setTimeout(poll, 700);
      };
      poll();
      return () => { dead = true; if (timer) clearTimeout(timer); };
    }, [chatSessionId, api]);

    // chat 视图:列模型
    React.useEffect(() => {
      if (view === 'chat' && chatSessionId && api) {
        (async () => {
          try {
            const value = unwrap<any>(await api.sessions.models({ sessionId: chatSessionId }));
            const groups = value?.groups ?? [];
            const flat: { provider: string; providerName: string; model: string; name: string }[] = [];
            for (const g of groups) {
              for (const m of (g.models ?? [])) {
                flat.push({ provider: g.id, providerName: g.name || g.id, model: m.id, name: m.name || m.id });
              }
            }
            setModels(flat);
            if (value?.current) setCurrentModel({ provider: value.current.provider, model: value.current.model });
          } catch { /* ignore */ }
        })();
      }
    }, [view, chatSessionId, api]);

    const doPromote = async (text: string, enterChatAfter: boolean) => {
      if (busy) return;
      if (!current) { setError('没有当前会话，请先选中一个会话'); setStatus(''); return; }
      const remoteCommands = ctx.get('remote.commands');
      if (!remoteCommands || typeof remoteCommands.execute !== 'function') {
        setError('命令服务不可用（remote.commands）'); setStatus(''); return;
      }
      setBusy(true); setError(''); setStatus('压缩并创建中…');
      try {
        let line = `/recall ${text}`;
        if (mode === 'paper') line = `/recall --paper ${text}`;
        else if (mode === 'select') {
          const seqs = picked.map((i) => pickMsgs[i]?.seq).filter((n) => typeof n === 'number');
          line = seqs.length ? `/recall --from ${seqs.join(',')} ${text}` : `/recall --paper ${text}`;
        }
        const res = await remoteCommands.execute(current, line, []);
        if (!res || res.ok === false) throw new Error(res?.error?.message ?? '命令执行失败');
        if (res.value == null) throw new Error('命令未识别');
        const outcome = res.value.result;
        if (!outcome || outcome.kind === 'error') throw new Error(outcome?.text ?? '命令返回错误');
        const cmdText: string = outcome.text ?? '';
        const sid = extractSessionId(cmdText);
        const item: CaptureItem = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind: 'session', text, time: timeNow(), sessionId: sid, segments: 0 };
        setRecent((r) => [item].concat(r).slice(0, 30));
        setPicked([]); setIdea('');
        setStatus(cmdText);
        if (enterChatAfter && sid) {
          const initial: ChatMessage[] = [{ role: 'user', text }];
          enterChat(sid, initial);
        }
      } catch (err: any) {
        setError(String(err?.message ?? err)); setStatus('');
      } finally { setBusy(false); }
    };

    const submit = async () => {
      const text = (idea || '').trim();
      if (!text) { setError('先写点东西 🙂'); setStatus(''); return; }
      await doPromote(text, true);
    };

    const stash = () => {
      const text = (idea || '').trim();
      if (!text) { setError('先写点东西 🙂'); setStatus(''); return; }
      setRecent((r) => [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind: 'stash', text, time: timeNow() }].concat(r).slice(0, 30));
      setIdea(''); setError('');
      setStatus('已存为便利贴（临时）');
    };

    const openSession = (sid: string) => { if (sessionsSvc && typeof sessionsSvc.open === 'function') sessionsSvc.open(sid); };
    const enterChat = (sid: string, initial: ChatMessage[]) => {
      stickToBottomRef.current = true;
      setChatSessionId(sid); setChatMessages(initial || []); setChatBusy(!!initial); setChatPending(null); setView('chat');
    };
    const backToCapture = () => { setView('capture'); setChatSessionId(null); };
    const removeItem = (id: string) => setRecent((r) => r.filter((x) => x.id !== id));
    const togglePicked = (i: number) => setPicked((prev) => prev.indexOf(i) >= 0 ? prev.filter((x) => x !== i) : prev.concat(i));
    const toggleExpand = (i: number) => setExpandedPick((prev) => { const next = { ...prev }; if (next[i]) delete next[i]; else next[i] = true; return next; });

    const changeModel = async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const parts = String(e.target.value || '').split('|');
      if (parts.length < 2 || !chatSessionId || !api) return;
      const provider = parts[0];
      const model = parts[1];
      try {
        const value = unwrap<any>(await api.sessions.selectModel({ sessionId: chatSessionId, provider, model }));
        if (value?.selected) setCurrentModel({ provider: value.selected.provider, model: value.selected.model });
      } catch { /* ignore */ }
    };

    const sendChat = async (steer: boolean) => {
      const text = (chatInput || '').trim();
      if (!text || !chatSessionId || !api) return;
      setChatInput('');
      setChatMessages((m) => m.concat([{ role: 'user', text }]));
      setChatBusy(true);
      try {
        await unwrap<any>(await api.sessions.prompt({ sessionId: chatSessionId, mode: steer ? 'steer' : 'queue', content: [{ type: 'text', text }] }));
      } catch (err: any) {
        setChatMessages((m) => m.concat([{ role: 'assistant', text: '⚠ ' + String(err?.message ?? err) }]));
        setChatBusy(false);
      }
    };

    const onHeadPointerDown = (e: React.PointerEvent) => {
      if ((e.target as HTMLElement)?.closest?.('.cap-x, .cap-back')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      const panel = (e.currentTarget as HTMLElement)?.closest?.('.cap-panel');
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      const move = (ev: PointerEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const w = panel.offsetWidth, h = panel.offsetHeight;
        let x = ev.clientX - d.dx, y = ev.clientY - d.dy;
        x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
        y = Math.max(8, Math.min(y, window.innerHeight - h - 8));
        setPos({ left: x, top: y });
      };
      const up = () => {
        dragRef.current = null;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        // 拖动结束落点持久化,下次重启回到此位置
        setPos((prev) => {
          savePos(prev);
          return prev;
        });
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    };

    if (!isOpen) {
      return React.createElement('button', { className: 'cap-fab', onClick: () => store.set(true), title: '想法捕获（Ctrl+Shift+K）' }, '⚡ 捕获');
    }

    const modeBtn = (m: string) => React.createElement('button', {
      key: m,
      className: 'cap-mode' + (mode === m ? ' active' : ''),
      title: MODES[m].title,
      onClick: () => setMode(m),
    }, MODES[m].label);

    const head = (title: string, isChat: boolean) => React.createElement('div', { className: 'cap-head', onPointerDown: onHeadPointerDown },
      React.createElement('span', { className: 'cap-dot' }),
      React.createElement('span', { className: 'cap-title' }, title),
      React.createElement('span', { className: 'cap-spacer' }),
      isChat ? React.createElement('button', { className: 'cap-back', onClick: backToCapture }, '← 捕获') : null,
      React.createElement('button', { className: 'cap-x', onClick: () => store.set(false), title: '关闭（Esc）' }, '✕'),
    );

    const body = view === 'chat'
      ? React.createElement('div', { className: 'cap-body' },
          chatPending ? React.createElement('div', { className: 'cap-pending' },
            React.createElement('span', { className: 'cap-pending-text' }, chatPending === 'approval' ? '⏸ 该会话等待审批，请在主界面确认' : '⏸ 该会话在等你回答提问，请在主界面选择'),
            React.createElement('button', { className: 'cap-pending-btn', onClick: () => openSession(chatSessionId!) }, '打开会话'),
          ) : null,
          React.createElement('div', { className: 'cap-chat-log', ref: chatLogRef, onScroll: onChatLogScroll },
            chatMessages.length === 0 ? React.createElement('div', { className: 'cap-empty' }, '加载中…') : null,
            chatMessages.map((m, i) => {
              if (m.role === 'assistant') {
                return React.createElement('div', { key: i, className: 'cap-msg cap-msg-assistant' }, renderMarkdown(m.text));
              }
              const cls = m.role === 'user' ? 'cap-msg cap-msg-user' : 'cap-msg cap-msg-context';
              return React.createElement('div', { key: i, className: cls }, m.role === 'context' ? ('📎 ' + m.text) : m.text);
            }),
            (chatBusy && !chatPending) ? React.createElement('div', { className: 'cap-msg cap-msg-assistant' }, '思考中…') : null,
          ),
          React.createElement('div', { className: 'cap-composer' },
            React.createElement('textarea', {
              className: 'cap-chat-input',
              placeholder: '继续聊… Enter 排队 / Ctrl+Enter 插队 / Shift+Enter 换行',
              value: chatInput,
              onChange: (e: any) => setChatInput(e.target.value),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' && e.shiftKey) return;
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(true); }
                else if (e.key === 'Enter') { e.preventDefault(); sendChat(false); }
              },
              rows: 2,
              autoFocus: true,
            }),
            React.createElement('div', { className: 'cap-composer-bar' },
              React.createElement('select', {
                className: 'cap-model-select',
                title: '模型',
                value: currentModel ? (currentModel.provider + '|' + currentModel.model) : '',
                onChange: changeModel,
              },
                models.length === 0 ? React.createElement('option', { value: '' }, currentModel ? currentModel.model : '加载中…') : null,
                models.map((m) => React.createElement('option', { key: m.provider + '|' + m.model, value: m.provider + '|' + m.model }, (m.providerName ? m.providerName + ' / ' : '') + m.name)),
              ),
              React.createElement('span', { className: 'cap-spacer' }),
              React.createElement('button', { className: 'cap-chat-send', onClick: () => sendChat(false), disabled: !chatInput.trim() }, '发送'),
            ),
          ),
        )
      : React.createElement('div', { className: 'cap-body' },
          React.createElement('textarea', {
            className: 'cap-input',
            placeholder: '把想法丢进来…（Enter 开启对话 / Shift+Enter 换行）',
            value: idea,
            onChange: (e: any) => setIdea(e.target.value),
            onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } },
            rows: 3,
            autoFocus: true,
          }),
          React.createElement('div', { className: 'cap-mode-row' }, modeBtn('paper'), modeBtn('select'), modeBtn('recall')),
          React.createElement('div', { className: 'cap-hint' }, MODES[mode].title),
          mode === 'select' ? React.createElement('div', { className: 'cap-picker', ref: pickerRef },
            React.createElement('div', { className: 'cap-recent-head' }, `共 ${pickMsgs.length} 条 · 点条目选中，点「展开」看全文`),
            pickMsgs.length === 0 ? React.createElement('div', { className: 'cap-empty' }, '没有可选的近期消息') : null,
            pickMsgs.map((m, i) => {
              const isOpen = !!expandedPick[i];
              return React.createElement('div', { key: i, className: 'cap-pick' + (picked.indexOf(i) >= 0 ? ' on' : '') },
                React.createElement('div', { className: 'cap-pick-row', onClick: () => togglePicked(i) },
                  React.createElement('span', { className: 'cap-pick-role' }, m.role === 'user' ? '我' : '助手'),
                  React.createElement('span', { className: 'cap-pick-preview' }, pickPreview(m.text)),
                ),
                React.createElement('button', { className: 'cap-pick-toggle', onClick: () => toggleExpand(i) }, isOpen ? '收起 ▴' : '展开 ▾'),
                isOpen ? React.createElement('div', { className: 'cap-pick-full' }, m.text) : null,
              );
            }),
          ) : null,
          React.createElement('div', { className: 'cap-actions' },
            React.createElement('button', { className: 'cap-ghost', onClick: stash, disabled: busy }, '存为便利贴'),
            React.createElement('button', { className: 'cap-primary', onClick: submit, disabled: busy }, busy ? '处理中…' : '开启对话'),
          ),
          (status || error) ? React.createElement('div', { className: error ? 'cap-status cap-status-err' : 'cap-status' }, error || status) : null,
          React.createElement('div', { className: 'cap-recent' },
            React.createElement('div', { className: 'cap-recent-head' },
              '便利贴' + (recent.length ? `（${recent.length}）` : ''),
              React.createElement('span', { className: 'cap-recent-note' }, '临时暂存 · 关闭窗口即清空'),
            ),
            recent.length === 0 ? React.createElement('div', { className: 'cap-empty' }, '还没有') : null,
            recent.map((item) => React.createElement(RecentItem, { key: item.id, item, onOpen: openSession, onChat: enterChat, onPromote: (t) => doPromote(t, true), onRemove: removeItem })),
          ),
        );

    return React.createElement('div', { className: 'cap-panel', style: { left: pos.left + 'px', top: pos.top + 'px' } },
      view === 'chat' ? head('想法对话', true) : head('想法捕获', false),
      body,
    );
  }

  slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'capture-panel', order: 50, label: '想法捕获' },
    (props: any) => React.createElement(CaptureApp, props),
  ));
}
