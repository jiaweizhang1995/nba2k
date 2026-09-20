// AI content service. GLM generates TEXT ONLY (news, chemistry explanations,
// trade suggestions as opinions, GM negotiation tone).
//
// Hard constraints enforced here:
//  - the model never supplies statistics, ratings or sim outcomes — those are
//    passed in as already-computed structured facts and clearly framed as such
//  - the model never decides trades (verdicts come from domain/trade.ts)
//  - all outputs are wrapped and errors degrade gracefully: the game runs
//    without AI features

import "server-only";
import { glmChat, parseJsonFromModel } from "@/lib/glm";

const SYSTEM = `你是篮球经理模拟游戏《NBA2K》的文案引擎。该联赛、所有球队和球员均为虚构演示数据。
规则：
1. 你只能基于用户提供的"已计算事实"写作，不得编造任何数字、评分、战绩或统计。
2. 引用数字时必须原样使用给定数值，不得自行推算新数字。
3. 不输出免责声明以外的额外解释；输出为简体中文，风格符合所请求的文体。`;

export interface NewsInput {
  headline: string;
  facts: string[];
  tone: "NEWS" | "RUMOR" | "ANALYSIS";
}

export async function generateNews(input: NewsInput): Promise<{ ok: boolean; text: string }> {
  const r = await glmChat([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `以下事实来自模拟引擎（可以直接引用）：\n${input.facts.map((f) => `- ${f}`).join("\n")}\n\n请写一篇${input.tone === "RUMOR" ? "联盟记者风格的流言短讯" : input.tone === "ANALYSIS" ? "专栏分析短文" : "新闻快讯"}，180字以内，标题：${input.headline}`,
    },
  ]);
  return { ok: r.ok, text: r.content ?? `（AI 功能暂不可用：${r.error?.message ?? "未知错误"}）` };
}

export interface ChemistryExplainInput {
  teamName: string;
  overall: number;
  factors: { label: string; score: number; note: string }[];
  recentMoves: string[];
}

export async function explainChemistry(input: ChemistryExplainInput): Promise<{ ok: boolean; text: string }> {
  const r = await glmChat([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `球队 ${input.teamName} 的化学反应由引擎计算如下（这些数字已定，不得改写）：\n总体 ${input.overall}/100\n${input.factors.map((f) => `- ${f.label}：${f.score}（${f.note}）`).join("\n")}\n近期阵容变化：${input.recentMoves.join("；") || "无"}\n\n请写一段150字以内的更衣室内部简报，解释当前化学反应的成因与隐患，直接引用给定分数。`,
    },
  ]);
  return { ok: r.ok, text: r.content ?? `（AI 功能暂不可用：${r.error?.message ?? "未知错误"}）` };
}

export interface TradeAdviceInput {
  userTeam: string;
  outgoing: { name: string; value: number; note: string }[];
  incoming: { name: string; value: number; note: string }[];
  engineVerdict: string;
  teamPhase: string;
}

export async function suggestTradeIdeas(input: TradeAdviceInput): Promise<{ ok: boolean; text: string }> {
  const r = await glmChat([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `你的球队：${input.userTeam}（阶段：${input.teamPhase}）\n可送出资产（估值由引擎计算）：${input.outgoing.map((o) => `${o.name}(${o.value}点,${o.note})`).join("、")}\n目标资产：${input.incoming.map((o) => `${o.name}(${o.value}点,${o.note})`).join("、")}\n规则引擎结论：${input.engineVerdict}\n\n请给出 2-3 条交易谈判思路（每条60字以内），只谈策略与筹码组合，不得声称交易已达成，不得修改估值。`,
    },
  ]);
  return { ok: r.ok, text: r.content ?? `（AI 功能暂不可用：${r.error?.message ?? "未知错误"}）` };
}

export interface NegotiationInput {
  counterpartTeam: string;
  counterpartPhase: string;
  engineFeedback: string;
  proposalSummary: string;
}

export async function gmNegotiationTone(input: NegotiationInput): Promise<{ ok: boolean; text: string }> {
  const r = await glmChat([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `你扮演虚构球队 ${input.counterpartTeam}（${input.counterpartPhase}）的总经理，与另一名GM谈判。\n提案要点：${input.proposalSummary}\n规则引擎对你方视角的评估：${input.engineFeedback}\n\n请用对方GM的口吻回复一段80字以内的谈判语气文案，表明态度但不得承诺或拒绝具体交易结果。`,
    },
  ]);
  return { ok: r.ok, text: r.content ?? `（AI 功能暂不可用：${r.error?.message ?? "未知错误"}）` };
}

/** Weekly digest item used on the GM home page. Returns structured headlines. */
export async function generateWeeklyDigest(facts: string[]): Promise<{ ok: boolean; headlines: string[] }> {
  const r = await glmChat([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `基于以下引擎事实，输出3条一句话新闻标题，JSON 数组格式：{"headlines": ["...", "...", "..."]}\n${facts.map((f) => `- ${f}`).join("\n")}`,
    },
  ]);
  if (!r.ok) return { ok: false, headlines: [] };
  const parsed = parseJsonFromModel<{ headlines?: string[] }>(r.content ?? "");
  if (parsed?.headlines?.length) return { ok: true, headlines: parsed.headlines.slice(0, 3) };
  return { ok: false, headlines: [] };
}
