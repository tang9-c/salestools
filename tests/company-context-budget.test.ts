import { expect, it, vi } from "vitest";
import {
  createMaterialReadContext,
  readSelectedReport,
  selectReportForQuestion,
} from "../src/companies/company-evidence.js";
import { AT, CODE, createContextFixture } from "./fixtures/company-context.js";
it("fixes the newest report and caches absence and failure", () => {
  const reports = ["old", "new"].map((id, i) => ({
    assessment_id: id,
    generated_at: `2026-10-${10 + i}T00:00:00Z`,
    collected_at: AT,
    overall_opportunity: "中",
    recommended_product: null,
  }));
  const c = createMaterialReadContext(
    new AbortController().signal,
    selectReportForQuestion(reports),
  );
  const load = vi.fn(() => null);
  readSelectedReport(c, load);
  readSelectedReport(c, load);
  expect(load).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledWith("new");
  expect(selectReportForQuestion(reports, "old")).toBe("old");
  const failed = createMaterialReadContext(c.signal, "bad");
  expect(() =>
    readSelectedReport(failed, () => {
      throw Error("failed");
    }),
  ).toThrow("failed");
  expect(readSelectedReport(failed, load)).toBeNull();
  expect(load).toHaveBeenCalledOnce();
});
it("adapts real SQLite profile with shared material budget", async () => {
  const f = createContextFixture();
  try {
    f.profiles.upsert({
      ...f.profiles.findByCreditCodes([CODE])[0],
      basicProfile: {
        ...f.profiles.findByCreditCodes([CODE])[0].basicProfile,
        industry: "装备制造",
      },
    });
    const c = createMaterialReadContext(new AbortController().signal, null);
    c.remaining_materials = 1;
    const r = await f.service.materials(CODE, "公司行业", c);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].statement).toContain("装备制造");
    expect(c.remaining_materials).toBe(0);
    expect((await f.service.materials(CODE, "公司行业", c)).items).toEqual([]);
  } finally {
    f.db.close();
  }
});
it("aborts before reading sources", async () => {
  const f = createContextFixture();
  try {
    const a = new AbortController();
    a.abort();
    await expect(
      f.service.materials(
        CODE,
        "行业",
        createMaterialReadContext(a.signal, null),
      ),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});
const meta = { version: 1, created_at: AT, updated_at: AT };
const work = (id: string, person: string) => ({
  relation_id: id,
  source_id: person,
  target_id: "o1",
  relation_type: "worksFor",
  properties: { role: { "@type": "OrganizationRole", roleName: "工程师" } },
  metadata: { ...meta, employment_status: "unknown" },
});
const proof = (id: string, r: string) => ({
  evidence_id: id,
  subject_kind: "relation",
  subject_id: r,
  field_path: "$relation",
  value: { relation_type: "worksFor" },
  quote: "测试人任职测试装备有限公司工程师",
  source_type: "manual",
  locator_status: "not_applicable",
  collected_at: AT,
});
function graphRecords(
  f: ReturnType<typeof createContextFixture>,
  n = 1,
  conflicts: unknown[] = [],
) {
  const rows = Array.from({ length: n }, (_, i) => work(`r${i}`, `p${i}`));
  f.request.mockImplementation(async (op, payload) => {
    if (op === "company_organizations")
      return { items: [f.org], next_offset: null, complete: true, total: 1 };
    if (op === "company_relations")
      return {
        items: rows,
        next_offset: null,
        complete: true,
        total: rows.length,
      };
    const id = (payload as { entity_id: string }).entity_id;
    if (id === "o1")
      return {
        entity: {
          entity_id: id,
          label: "Organization",
          properties: { name: f.org.name },
          metadata: meta,
        },
        relations: [],
        evidence: [],
        conflicts: [],
        version: 1,
      };
    const i = Number(id.slice(1));
    return {
      entity: {
        entity_id: id,
        label: "Person",
        properties: { name: "测试人" },
        extensions: { hobbies: [], instantMessaging: [] },
        metadata: meta,
      },
      relations: [rows[i]],
      evidence: [proof(`e${i}`, `r${i}`)],
      conflicts,
      version: 1,
    };
  });
}
it("shares twelve reads across calls, reuses cache and never promotes unknown employment", async () => {
  const f = createContextFixture();
  try {
    graphRecords(f, 14);
    const c = createMaterialReadContext(new AbortController().signal, null);
    const result = await f.service.materials(CODE, "任职", c);
    expect(result.contacts_read).toBe(12);
    expect(c.contacts.size).toBe(12);
    expect(result.items).toHaveLength(11);
    expect(
      result.items.every((i) => i.statement.includes("当前状态未知")),
    ).toBe(true);
    const calls = f.request.mock.calls.filter(
      ([op]) => op === "get_contact",
    ).length;
    await f.service.materials(CODE, "任职", c);
    expect(
      f.request.mock.calls.filter(([op]) => op === "get_contact"),
    ).toHaveLength(calls);
  } finally {
    f.db.close();
  }
});
it("omits disputed relations but preserves the independent employer facts", async () => {
  const f = createContextFixture();
  try {
    graphRecords(f, 2, [proof("disputed", "r0")]);
    const result = await f.service.materials(
      CODE,
      "任职",
      createMaterialReadContext(new AbortController().signal, null),
    );
    expect(result.items.map((i) => i.citation.relation_id)).toEqual(["r1"]);
    expect(result.warnings.join(" ")).toContain("存在冲突，无法确认");
  } finally {
    f.db.close();
  }
});
it("stops at five contact pages and preserves partial warning", async () => {
  const f = createContextFixture();
  try {
    graphRecords(f);
    const old = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op, payload, signal) => {
      const raw = await old(op, payload, signal);
      if (
        op !== "get_contact" ||
        (payload as { entity_id: string }).entity_id !== "p0"
      )
        return raw;
      const offset =
        (payload as { evidence_offset?: number }).evidence_offset ?? 0;
      return {
        ...(raw as object),
        pagination: {
          evidence: { total: 1000, next_offset: offset + 1 },
          relations: { total: 1, next_offset: null },
        },
      };
    });
    const r = await f.service.materials(
      CODE,
      "任职",
      createMaterialReadContext(new AbortController().signal, null),
    );
    expect(
      f.request.mock.calls.filter(
        ([op, p]) =>
          op === "get_contact" &&
          (p as { entity_id: string }).entity_id === "p0",
      ),
    ).toHaveLength(5);
    expect(r.state).toBe("partial");
    expect(r.warnings).toContain("CONTACT_PAGES_INCOMPLETE");
  } finally {
    f.db.close();
  }
});
it("does not reread selected SQLite report across company material calls", async () => {
  const f = createContextFixture();
  try {
    f.db
      .prepare(
        `INSERT INTO assessments (assessment_id,cache_key,requested_by,legal_name,credit_code,status,created_at,completed_at) VALUES ('r',?,'test','测试装备有限公司',?,'completed',?,?)`,
      )
      .run(CODE, CODE, AT, AT);
    const get = vi.spyOn(f.assessments, "get");
    const c = createMaterialReadContext(new AbortController().signal, "r");
    await f.service.materials(CODE, "行业", c);
    await f.service.materials(CODE, "行业", c);
    expect(get).toHaveBeenCalledOnce();
    expect(c.report_reads).toBe(1);
  } finally {
    f.db.close();
  }
});
function projectRecords(
  f: ReturnType<typeof createContextFixture>,
  clientQuote = "测试项目客户为测试装备有限公司",
  clientValue: unknown = { relation_type: "clientOrganization" },
) {
  const client = {
    relation_id: "client",
    source_id: "proj",
    target_id: "o1",
    relation_type: "clientOrganization",
    properties: {},
    metadata: meta,
  };
  const member = {
    relation_id: "member",
    source_id: "p",
    target_id: "proj",
    relation_type: "memberOf",
    properties: {},
    metadata: meta,
  };
  const clientProof = {
    ...proof("client-proof", "client"),
    quote: clientQuote,
    value: clientValue,
  };
  const memberProof = {
    ...proof("member-proof", "member"),
    quote: "测试人是测试项目成员",
    value: { relation_type: "memberOf" },
  };
  const records: Record<string, unknown> = {
    o1: {
      entity: {
        entity_id: "o1",
        label: "Organization",
        properties: { name: f.org.name },
        metadata: meta,
      },
      evidence: [],
      relations: [],
      conflicts: [],
    },
    proj: {
      entity: {
        entity_id: "proj",
        label: "Project",
        properties: { name: "测试项目" },
        metadata: meta,
      },
      evidence: [clientProof],
      relations: [client],
      conflicts: [],
    },
    p: {
      entity: {
        entity_id: "p",
        label: "Person",
        properties: { name: "测试人" },
        extensions: { hobbies: [], instantMessaging: [] },
        metadata: meta,
      },
      evidence: [memberProof],
      relations: [member],
      conflicts: [],
    },
  };
  f.request.mockImplementation(async (op, p) =>
    op === "company_organizations"
      ? { items: [f.org], complete: true, next_offset: null }
      : op === "company_relations"
        ? { items: [client, member], complete: true, next_offset: null }
        : records[(p as { entity_id: string }).entity_id],
  );
}
it("accepts both project links together and never returns a one-link conclusion", async () => {
  const f = createContextFixture();
  try {
    projectRecords(f);
    const c = createMaterialReadContext(new AbortController().signal, null);
    c.remaining_materials = 1;
    const result = await f.service.materials(CODE, "谁参与了客户项目", c);
    expect(result.items).toEqual([]);
    expect(result.omitted_count).toBe(2);
    const full = await f.service.materials(
      CODE,
      "谁参与了客户项目",
      createMaterialReadContext(c.signal, null),
    );
    expect(full.items.map((i) => i.predicate)).toEqual([
      "clientOrganization",
      "memberOf",
    ]);
  } finally {
    f.db.close();
  }
});
it("never uses a stale, foreign or unconfirmed snapshot", async () => {
  const f = createContextFixture();
  try {
    const snapshot = {
      collectedAt: AT,
      items: [
        {
          evidenceId: "s",
          title: "装备制造行业资料",
          url: null,
          originalPublisher: null,
          originalDomain: null,
          publishedAt: null,
          collectedAt: AT,
          mentionedName: "测试装备有限公司",
          entityScope: "legal_entity",
          entityMatch: "confirmed",
          matchBasis: [],
          source: "qcc",
          sourceKind: "company",
          excerpt: "装备制造",
          excerptTruncated: false,
        },
      ],
      facts: [
        {
          factId: "f",
          statement: "已有装备制造业务",
          kind: "industry",
          productTags: [],
          strength: "direct",
          evidenceIds: ["s"],
          entityScope: "legal_entity",
          entityMatch: "confirmed",
          matchBasis: [],
        },
      ],
    };
    f.db
      .prepare(
        `INSERT INTO assessments (assessment_id,cache_key,requested_by,legal_name,credit_code,status,evidence_snapshot_json,created_at,completed_at) VALUES ('r',?,'test','测试装备有限公司',?,'completed',?,?,?)`,
      )
      .run(CODE, CODE, JSON.stringify(snapshot), AT, AT);
    const c = createMaterialReadContext(new AbortController().signal, "r");
    expect(
      (await f.service.materials(CODE, "装备制造行业资料", c)).items.some(
        (i) => i.citation.source_type === "assessment",
      ),
    ).toBe(true);
    expect(
      (await f.service.materials("foreign", "装备制造行业资料", c)).items,
    ).toEqual([]);
    expect(
      (await f.service.materials(CODE, "最新装备制造行业资料", c)).items,
    ).toEqual([]);
    f.db
      .prepare(
        "UPDATE assessments SET evidence_snapshot_json=? WHERE assessment_id='r'",
      )
      .run(
        JSON.stringify({
          ...snapshot,
          collectedAt: "2026-08-01T00:00:00.000Z",
        }),
      );
    expect(
      (
        await f.service.materials(
          CODE,
          "装备制造行业资料",
          createMaterialReadContext(c.signal, "r"),
        )
      ).items,
    ).toEqual([]);
    f.db
      .prepare(
        "UPDATE assessments SET evidence_snapshot_json=? WHERE assessment_id='r'",
      )
      .run(
        JSON.stringify({
          ...snapshot,
          facts: [{ ...snapshot.facts[0], entityMatch: "unverified" }],
        }),
      );
    expect(
      (
        await f.service.materials(
          CODE,
          "装备制造行业资料",
          createMaterialReadContext(c.signal, "r"),
        )
      ).items,
    ).toEqual([]);
  } finally {
    f.db.close();
  }
});
it("rejects a career edge when graph entity labels contradict it", async () => {
  const f = createContextFixture();
  try {
    graphRecords(f);
    const old = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op, payload, signal) => {
      const raw = await old(op, payload, signal);
      if (
        op === "get_contact" &&
        (payload as { entity_id: string }).entity_id === "p0"
      )
        return {
          ...(raw as object),
          entity: {
            entity_id: "p0",
            label: "Project",
            properties: { name: "测试人" },
            metadata: meta,
          },
        };
      return raw;
    });
    expect(
      (
        await f.service.materials(
          CODE,
          "任职",
          createMaterialReadContext(new AbortController().signal, null),
        )
      ).items,
    ).toEqual([]);
  } finally {
    f.db.close();
  }
});
it("warns when a disputed relation field is absent from the main evidence page", async () => {
  const f = createContextFixture();
  try {
    graphRecords(f, 1, [
      {
        ...proof("role-conflict", "r0"),
        field_path: "properties.role.roleName",
        value: "采购主管",
      },
    ]);
    const result = await f.service.materials(
      CODE,
      "任职",
      createMaterialReadContext(new AbortController().signal, null),
    );
    expect(result.items).toEqual([]);
    expect(result.warnings.join(" ")).toContain(
      "properties.role.roleName 存在冲突，无法确认",
    );
  } finally {
    f.db.close();
  }
});
it("marks a normal profile source failure partial instead of throwing", async () => {
  const f = createContextFixture();
  try {
    vi.spyOn(f.profiles, "findByCreditCodes").mockImplementation(() => {
      throw Error("SQLite source failed");
    });
    const result = await f.service.materials(
      CODE,
      "行业",
      createMaterialReadContext(new AbortController().signal, null),
    );
    expect(result.items).toEqual([]);
    expect(result.state).toBe("partial");
    expect(result.warnings).toContain("PROFILE_UNAVAILABLE");
  } finally {
    f.db.close();
  }
});

it.each(["missing", "unverified", "foreign"] as const)(
  "rejects the whole snapshot fact when one required reference is %s",
  async (invalid) => {
    const f = createContextFixture();
    try {
      const reference = {
        evidenceId: "valid",
        title: "装备制造行业资料",
        url: null,
        originalPublisher: null,
        originalDomain: null,
        publishedAt: null,
        collectedAt: AT,
        mentionedName: f.org.name,
        entityScope: "legal_entity",
        entityMatch: "confirmed",
        matchBasis: [],
        source: "qcc",
        sourceKind: "company",
        excerpt: "装备制造",
        excerptTruncated: false,
      };
      const snapshot = {
        collectedAt: AT,
        items:
          invalid === "missing"
            ? [reference]
            : [
                reference,
                {
                  ...reference,
                  evidenceId: "bad",
                  ...(invalid === "unverified"
                    ? { entityMatch: "unverified" }
                    : { mentionedName: "其他企业有限公司" }),
                },
              ],
        facts: [
          {
            factId: "mixed",
            statement: "完整事实依赖两条来源",
            kind: "industry",
            productTags: [],
            strength: "direct",
            evidenceIds: ["valid", "bad"],
            entityScope: "legal_entity",
            entityMatch: "confirmed",
            matchBasis: [],
          },
        ],
      };
      f.db
        .prepare(
          `INSERT INTO assessments
        (assessment_id,cache_key,requested_by,legal_name,credit_code,status,
          evidence_snapshot_json,created_at,completed_at)
        VALUES ('mixed',?,'test',? ,?,'completed',?,?,?)`,
        )
        .run(CODE, f.org.name, CODE, JSON.stringify(snapshot), AT, AT);
      const result = await f.service.materials(
        CODE,
        "装备制造行业资料",
        createMaterialReadContext(new AbortController().signal, "mixed"),
      );
      expect(result.items).toEqual([]);
    } finally {
      f.db.close();
    }
  },
);

it.each([
  "测试项目和测试装备有限公司出席交流会",
  "测试项目和测试装备有限公司讨论客户需求",
])(
  "does not infer a project customer from endpoint co-occurrence: %s",
  async (quote) => {
    const f = createContextFixture();
    try {
      projectRecords(f, quote, "交流会");
      const result = await f.service.materials(
        CODE,
        "谁参与了客户项目",
        createMaterialReadContext(new AbortController().signal, null),
      );
      expect(result.items).toEqual([]);
    } finally {
      f.db.close();
    }
  },
);

it.each([
  ["测试项目为测试装备有限公司提供服务", "服务记录"],
  [
    "测试项目和测试装备有限公司的关系记录",
    { relation_type: "clientOrganization" },
  ],
])(
  "supports project customer evidence with explicit semantics or a typed relation",
  async (quote, value) => {
    const f = createContextFixture();
    try {
      projectRecords(f, quote as string, value);
      const result = await f.service.materials(
        CODE,
        "谁参与了客户项目",
        createMaterialReadContext(new AbortController().signal, null),
      );
      expect(result.items.map((item) => item.predicate)).toEqual([
        "clientOrganization",
        "memberOf",
      ]);
    } finally {
      f.db.close();
    }
  },
);
