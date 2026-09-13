// Shared helpers for route handlers: JSON error mapping, zod validation.

import { NextResponse } from "next/server";
import { ZodSchema } from "zod";
import { EngineError } from "./engine";

export function ok(data: unknown, init?: number) {
  return NextResponse.json({ ok: true, ...(data as object) }, { status: init ?? 200 });
}

export function fail(code: string, message: string, status = 400) {
  return NextResponse.json({ ok: false, code, message }, { status });
}

export function handleError(e: unknown) {
  if (e instanceof EngineError) return fail(e.code, e.message);
  const err = e as Error;
  return fail("INTERNAL", err.message ?? "服务器内部错误", 500);
}

export async function parseBody<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new EngineError("BAD_JSON", "请求体不是合法 JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new EngineError("VALIDATION", `输入校验失败：${msg}`);
  }
  return parsed.data;
}
