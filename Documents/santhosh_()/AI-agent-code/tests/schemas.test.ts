import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AIParseError,
  AnalysisResultSchema,
  BreakingChangeResultSchema,
  SessionStateSchema,
  TechProfileSchema,
  parseAIJson,
} from "../src/schemas.js";
import { makeAnalysis, makeProfile } from "./helpers.js";

describe("parseAIJson", () => {
  const S = z.object({ n: z.number() });

  it("parses raw JSON, fenced JSON and JSON embedded in prose", () => {
    expect(parseAIJson('{"n":1}', S)).toEqual({ n: 1 });
    expect(parseAIJson('```json\n{"n":2}\n```', S)).toEqual({ n: 2 });
    expect(parseAIJson('```\n{"n":3}\n```', S)).toEqual({ n: 3 });
    expect(parseAIJson('Here you go:\n{"n":4}\nThanks', S)).toEqual({ n: 4 });
  });

  it("throws AIParseError with the raw output when nothing parses", () => {
    const err = (() => {
      try {
        parseAIJson("sorry, I can't", S);
      } catch (e) {
        return e as AIParseError;
      }
    })();
    expect(err).toBeInstanceOf(AIParseError);
    expect(err?.name).toBe("AIParseError");
    expect(err?.rawOutput).toBe("sorry, I can't");
    expect(err?.message).toMatch(/Could not extract JSON/);
  });

  it("distinguishes invalid extracted JSON from schema failures", () => {
    expect(() => parseAIJson("x {n: 1} y", S)).toThrow(/not valid JSON/);
    expect(() => parseAIJson('{"n":"1"}', S)).toThrow(/failed schema validation:\n\s+n:/);
  });
});

describe("schemas", () => {
  it("accept well-formed fixtures", () => {
    expect(TechProfileSchema.parse(makeProfile())).toBeTruthy();
    expect(AnalysisResultSchema.parse(makeAnalysis())).toBeTruthy();
  });

  it("AnalysisResultSchema rejects unknown component types", () => {
    const bad = makeAnalysis({ keyComponents: [{ name: "x", path: "p", purpose: "q", type: "widget" as any }] });
    expect(AnalysisResultSchema.safeParse(bad).success).toBe(false);
  });

  it("BreakingChangeResultSchema enforces enums and the full checklist", () => {
    const ok = {
      riskLevel: "HIGH",
      changeType: ["API", "Database"],
      affectedConsumers: [],
      findings: [{ file: "a.ts", change: "removed field", breaking: true, impact: "clients" }],
      recommendations: [],
      checklist: {
        dtosChecked: true, enumsChecked: true, typesChecked: true, defaultsChecked: true,
        databaseChecked: true, messagesChecked: true, consumersChecked: true, rollbackChecked: false,
      },
    };
    expect(BreakingChangeResultSchema.safeParse(ok).success).toBe(true);
    expect(BreakingChangeResultSchema.safeParse({ ...ok, riskLevel: "CRITICAL" }).success).toBe(false);
    expect(BreakingChangeResultSchema.safeParse({ ...ok, changeType: ["Network"] }).success).toBe(false);
    const { rollbackChecked, ...partial } = ok.checklist;
    expect(BreakingChangeResultSchema.safeParse({ ...ok, checklist: partial }).success).toBe(false);
  });

  it("SessionStateSchema defaults conversationHistory to []", () => {
    const parsed = SessionStateSchema.parse({
      sessionId: "s", chatId: 1, userId: 2, repoUrl: null, repoLocalPath: null,
      currentPhase: "idle", taskType: null, profileJson: null, analysisJson: null,
      createdAt: 1, updatedAt: 1,
    });
    expect(parsed.conversationHistory).toBe("[]");
  });
});
