/**
 * dsh-capture-window · host 引擎 (/recall)
 *
 * 与动态插件 capt-1/pkg-16 语义对齐:
 *   把一个「旁路想法」投进一个安静的新会话,不触碰主线上下文。
 *   上下文来源 = 压缩当前会话最近 10 句(近10条) / 白纸 / 手动选择(按 seq)。
 *
 * 命令契约(薄壳客户端共用本引擎):
 *   /recall <text>                        近 10 条:压缩当前会话最近 10 句 → 注入新会话
 *   /recall --paper <text>                白纸:不带上文,只带想法首条
 *   /recall --from <seq,seq> <text>       选择:读取指定 seq 的消息文本注入
 *
 * 新会话落地规则(与 pkg-16 一致):
 *   - cwd 继承当前会话目录(经 workspace / parent.header.cwd)
 *   - parentSession 血缘指向当前会话
 *   - agentPreset 继承部署默认
 *   - 召回上下文以 plugin/recall 来源注入(非回复 prelude),想法作首条 followup
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { randomUUID } from 'node:crypto';

const PLUGIN = 'dsh-capture-window';

/** 压缩指令:固定忠实摘要,不接受改写(防注入) */
const SUMMARIZE_PROMPT =
  '你是会话压缩器。把下面的对话片段压缩成一段忠实、精简、保留关键决策与术语的中文摘要（不超过 400 字）。' +
  '不要演绎、不要加新信息、不要输出任何额外格式。';

export interface RecallOpts {
  paper?: boolean;   // 白纸:不带上文
  from?: number[];   // 选择:读取指定 seq
}

/** 从 content blocks 提取纯文本。 */
function blocksText(blocks: any): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('').trim();
}

/** 从单条事件提取可见文本(user/assistant)。 */
function eventText(e: any): string {
  if (!e) return '';
  if (e.type === 'user/message') return blocksText(e.data && e.data.content);
  if (e.type === 'assistant/message') return blocksText(e.data && e.data.message && e.data.message.content);
  return '';
}

/** 读最近 max 句(倒序遍历,保序)。 */
function extractRecentTexts(events: any[], max: number): string[] {
  const out: string[] = [];
  if (!Array.isArray(events)) return out;
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    const t = eventText(events[i]);
    if (t) out.unshift(t);
  }
  return out;
}

/** 读 live session.events(getter 实时快照,避开 readSession 的 replay 校验)。 */
function liveEvents(sessions: any, sessionId: string): any[] {
  const session = sessions ? sessions.get(sessionId) : undefined;
  return session && Array.isArray(session.events) ? session.events : [];
}

/** 选择:按 seq 读取当前会话的消息文本。 */
function readSegments(sessions: any, sessionId: string, seqs: number[]): string[] {
  const events = liveEvents(sessions, sessionId);
  const bySeq = new Map<number, any>(events.map((e: any) => [e.seq, e]));
  const out: string[] = [];
  for (const s of seqs) {
    const e = bySeq.get(s);
    if (!e) continue;
    const t = eventText(e);
    if (t) out.push(t);
  }
  return out;
}

/** 一次性摘要调用(读 agentDefaultModel 选模型,purpose 'compaction')。 */
async function summarize(ctx: any, llm: any, segments: string[]): Promise<string> {
  let provider: string | undefined;
  let model: string | undefined;
  try {
    const selSvc = ctx.get('agentDefaultModel');
    if (selSvc && typeof selSvc.currentSelection === 'function') {
      const sel = selSvc.currentSelection();
      if (sel) { provider = sel.provider; model = sel.model; }
    }
  } catch { /* ignore */ }
  if (!provider || !model) {
    let providers: any[] = [];
    try { providers = llm.listProviders() || []; } catch { providers = []; }
    if (providers.length) { provider = provider || providers[0].id; model = model || 'deepseek-chat'; }
  }
  if (!provider || !model) return segments.join('\n---\n');

  const body = `${SUMMARIZE_PROMPT}\n\n<segments>\n${segments.join('\n---\n')}\n</segments>`;
  const message = createUserMessage({
    content: [{ type: 'text', text: body }],
    source: { kind: 'user' },
  });
  try {
    const stream: AsyncIterable<any> = llm.stream({
      provider,
      model,
      messages: [message],
      maxTokens: 2048,
      purpose: 'compaction',
    });
    let out = '';
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
    }
    const text = out.trim();
    return text || segments.join('\n---\n');
  } catch {
    return segments.join('\n---\n');
  }
}

/** 复刻 api-proxy 的 composeAgent setup:装模型选择 + 挂载预设。 */
function buildSetup(ctx: any, presetId?: string, inheritedModel?: { provider: string; model: string }): (agentCtx: any) => Promise<void> {
  const selSvc = ctx.get('agentDefaultModel');
  const defaults = selSvc && typeof selSvc.currentSelection === 'function' ? selSvc.currentSelection() : undefined;
  return async function setup(agentCtx: any) {
    const agent = agentCtx && agentCtx.agent;
    if (agent) {
      let picked: any;
      const selection = {
        get current() {
          if (picked !== undefined) return picked;
          const logged = agent.session && typeof agent.session.requestHeader === 'function'
            ? agent.session.requestHeader()
            : undefined;
          if (logged && logged.config && logged.config.provider && logged.config.model) {
            return { provider: logged.config.provider, model: logged.config.model };
          }
          if (inheritedModel) return inheritedModel; // 继承当前会话的 model
          return defaults;
        },
        set current(v: any) { picked = v; },
        assembled: undefined as any,
      };
      try { installModelSelection(agentCtx, selection); } catch { /* ignore */ }
    }
    const presets = ctx.get('agentPresets');
    if (presets && presetId && typeof presets.mount === 'function') {
      try { await presets.mount(agentCtx, presetId); } catch { /* ignore */ }
    }
  };
}

/**
 * /recall 主流程:
 *   1. 收集上下文段(白纸跳过 / 选择读 seq / 近10条读最近 10 句)
 *   2. llm.stream 压缩 → 摘要
 *   3. agents.create 新建会话(安静、空闲 Agent,cwd 继承,parentSession 血缘)
 *   4. workspace.attachSession 挂到当前目录组
 *   5. 摘要以 plugin/recall 来源 inject(非回复 prelude)+ 想法作首条 followup
 */
export async function runRecall(
  ctx: any,
  agent: { id: string },
  idea: string,
  opts: RecallOpts,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const sessions = ctx.get('sessions');
  const agents = ctx.get('agents');
  const llm = ctx.get('llm');
  if (!sessions) return { kind: 'error', text: 'sessions 服务不可用' };
  if (!agents) return { kind: 'error', text: 'agents 服务不可用' };

  try {
    // 1. 上下文段
    let segments: string[] = [];
    if (opts.paper) {
      segments = [];
    } else if (opts.from && opts.from.length) {
      segments = readSegments(sessions, agent.id, opts.from);
    } else {
      segments = extractRecentTexts(liveEvents(sessions, agent.id), 10);
    }

    // 2. 压缩
    let summary = '';
    if (segments.length && llm) summary = await summarize(ctx, llm, segments);

    // 3. 新建会话
    const targetId = `recall-${randomUUID()}`;
    const parent = sessions.get(agent.id);

    // 继承当前会话的 preset id(复刻 resolveSessionPreset:agent-preset/selected 事件选定胜,退 header)
    let parentPresetId: string | undefined = parent && parent.header && parent.header.agentPreset;
    if (parent && Array.isArray(parent.events)) {
      for (let i = parent.events.length - 1; i >= 0; i--) {
        const ev = parent.events[i];
        if (ev && ev.type === 'agent-preset/selected' && ev.data && ev.data.agentPreset) {
          parentPresetId = ev.data.agentPreset; break;
        }
      }
    }

    let presetId: string | undefined;
    const presets = ctx.get('agentPresets');
    if (presets && typeof presets.resolve === 'function') {
      try { const r = await presets.resolve(parentPresetId); presetId = r && r.id; } catch { /* ignore */ }
    }

    // 继承当前会话的 model(取 parent requestHeader 的 provider/model,否则退部署默认)
    let inheritedModel: { provider: string; model: string } | undefined;
    const parentHeader = parent && typeof parent.requestHeader === 'function' ? parent.requestHeader() : undefined;
    const headCfg = parentHeader && parentHeader.config;
    if (headCfg && headCfg.provider && headCfg.model) inheritedModel = { provider: headCfg.provider, model: headCfg.model };
    const selSvc = ctx.get('agentDefaultModel');
    const sel = selSvc && typeof selSvc.currentSelection === 'function' ? selSvc.currentSelection() : undefined;
    const agentOptions = inheritedModel ?? (sel && sel.provider && sel.model ? { provider: sel.provider, model: sel.model } : undefined);

    const meta: Record<string, unknown> = {};
    if (agent.id) meta.parentSession = agent.id;

    // 找到当前会话所在 workspace,继承其 path 作为 cwd(否则退到 parent.header.cwd)
    let workspace: any;
    try {
      const workspaceRegistry = ctx.get('workspaceRegistry');
      if (workspaceRegistry && typeof workspaceRegistry.list === 'function') {
        const list = workspaceRegistry.list() || [];
        workspace = list.find((w: any) => w && w.sessionIds && w.sessionIds.indexOf(agent.id) >= 0);
      }
    } catch { /* ignore */ }
    const cwd = (workspace && workspace.path) || (parent && parent.header && parent.header.cwd);
    if (cwd) meta.cwd = cwd;
    if (presetId) meta.agentPreset = presetId;

    const handle = await agents.create({
      sessionId: targetId,
      agentOptions,
      meta: Object.keys(meta).length ? meta : undefined,
      setup: buildSetup(ctx, presetId, inheritedModel),
    });
    const target = handle && handle.agent ? handle.agent : agents.get(targetId);
    if (!target) return { kind: 'error', text: '创建会话失败' };

    if (workspace && typeof workspace.attachSession === 'function') {
      try { await workspace.attachSession(targetId); } catch { /* ignore */ }
    }

    // 4. 注入:召回上下文(非回复 prelude)+ 想法首条
    if (segments.length && summary) {
      const recallText = `【跨会话召回上下文】来自会话 ${agent.id} 的压缩背景，仅供参考，无需回复：\n${summary}`;
      target.inject(createUserMessage({
        content: [{ type: 'text', text: recallText }],
        source: { kind: 'plugin', plugin: PLUGIN, form: 'recall' },
      }));
    }
    target.followup(createUserMessage({
      content: [{ type: 'text', text: idea }],
      source: { kind: 'user' },
    }));

    const label = segments.length > 0 ? `压缩 ${segments.length} 句上下文` : '白纸';
    return {
      kind: 'success',
      text: `已创建新会话 ${targetId}（${label}）。发送后才会跑 agent。`,
    };
  } catch (err: any) {
    return { kind: 'error', text: `recall 失败：${err?.message ?? String(err)}` };
  }
}

/** 硬依赖:commands 服务就绪后才会 apply(避免 ctx.get 时序竞态)。 */
export const inject = ['commands'];

/** cordis 插件入口:注册 /recall 命令 + 选择模式的轻量消息列表 RPC */
export function apply(ctx: any): void {
  const commands = ctx.commands;
  if (commands) {
    commands.register({
      name: 'recall',
      description: '把想法投进一个安静的旁路新会话(压缩当前会话最近 10 句作为背景,不进主线上下文)',
      input: { hint: '<想法文本> [--paper] [--from <seq,seq>]' },
      handler: async (inv: CommandInvocation): Promise<CommandResult> => {
        const argv = parseArgs(inv.rawInput);
        if (!argv.idea) {
          return {
            kind: 'error',
            text: '用法：/recall <想法文本> [--paper] [--from <seq,seq>]',
          };
        }
        return runRecall(ctx, inv.agent, argv.idea, argv, inv.signal);
      },
    });
  }

  // 选择模式的「只回对话消息」轻量接口:host 侧直接读 session.events 过滤 user/assistant,
  // 只回 text+seq,避免把整条事件流(含几十万条 assistant/chunk 碎片)下发到浏览器。
  ctx.inject(['connection'], (connCtx: any) => {
    const connection = connCtx.connection;
    if (!connection || typeof connection.rpc?.handle !== 'function') return;
    connection.rpc.handle('/capture', async (endpoint: string, payload: any) => {
      if (endpoint !== 'list-messages') {
        return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${endpoint}` } };
      }
      try {
        const sessions = ctx.get('sessions');
        if (!sessions) return { ok: false, error: { code: 'unavailable', message: 'sessions 服务不可用' } };
        const sessionId = payload && payload.sessionId;
        if (typeof sessionId !== 'string' || !sessionId) {
          return { ok: false, error: { code: 'bad-request', message: '缺少 sessionId' } };
        }
        const events = liveEvents(sessions, sessionId);
        const msgs: { role: string; text: string; seq: number }[] = [];
        for (const e of events) {
          const role = e.type === 'user/message' ? 'user' : e.type === 'assistant/message' ? 'assistant' : '';
          if (!role) continue;
          const text = eventText(e);
          if (!text) continue;
          msgs.push({ role, text, seq: e.seq });
        }
        return { ok: true, value: msgs };
      } catch (err: any) {
        return { ok: false, error: { code: 'internal', message: String(err?.message ?? err) } };
      }
    }, {});
  });
}

/** 极简参数解析:--paper 标志 / --from seq,seq,剩余为想法文本 */
function parseArgs(raw: string): RecallOpts & { idea: string } {
  const tokens = raw.trim().split(/\s+/);
  const out: RecallOpts & { idea: string } = { idea: '' };
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--from' && tokens[i + 1]) {
      out.from = tokens[++i].split(',').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
    } else if (t === '--paper') {
      out.paper = true;
    } else {
      rest.push(t);
    }
  }
  out.idea = rest.join(' ');
  return out;
}
