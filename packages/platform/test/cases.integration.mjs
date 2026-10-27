import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { createPool, migrate } from "../src/db.mjs";
import { configuration, createPlatform } from "../src/server.mjs";

test(
  "reviewed research snapshots isolate published conversations and files from private workspaces",
  { timeout: 60000 },
  async (t) => {
    assert.ok(process.env.DATABASE_URL, "Use the dedicated test database");
    const owner = createPool(process.env.DATABASE_URL),
      schema = `cases_${randomUUID().replaceAll("-", "")}`;
    await owner.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = createPool(url.href);
    let app;
    try {
      await migrate(pool);
      await migrate(pool);
      const config = configuration({
        DATABASE_URL: url.href,
        PLATFORM_ORIGIN: "http://localhost:5300",
        PLATFORM_RESEARCH_OWNER_EMAIL: "owner@cases.invalid",
      });
      app = await createPlatform(config, pool);
      app.server.listen(0, "127.0.0.1");
      await once(app.server, "listening");
      const origin = `http://localhost:${app.server.address().port}`;
      config.origin = new URL(origin);
      config.appOrigin = origin;
      async function request(
        path,
        {
          method = "GET",
          data,
          cookie,
          origin: source = origin,
          bytes,
          name,
        } = {},
      ) {
        const headers = {
          ...(source ? { origin: source } : {}),
          ...(cookie ? { cookie } : {}),
          ...(bytes
            ? { "content-type": "application/octet-stream" }
            : data
              ? { "content-type": "application/json" }
              : {}),
        };
        const response = await fetch(
          origin + path + (name ? `?name=${encodeURIComponent(name)}` : ""),
          {
            method,
            headers,
            body: bytes ?? (data ? JSON.stringify(data) : undefined),
          },
        );
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          status: response.status,
          headers: response.headers,
          cookie: response.headers.get("set-cookie")?.split(";")[0],
          bytes: buffer,
          data: response.headers
            .get("content-type")
            ?.includes("application/json")
            ? JSON.parse(buffer.toString())
            : null,
        };
      }
      async function register(email) {
        const result = await request("/api/platform/register", {
          method: "POST",
          data: { name: email, email, password: "Test account password 2026!" },
        });
        assert.equal(result.status, 201);
        return result.cookie;
      }
      const admin = await register("admin@cases.invalid"),
        reader = await register("reader@cases.invalid"),
        researchOwner = await register("owner@cases.invalid");
      await pool.query(
        "UPDATE platform_users SET is_admin=true WHERE email='admin@cases.invalid'",
      );
      let caseId, fileId;
      const snapshot = {
        sessions: [
          {
            title: "完整的既有研究",
            messages: [
              { id: "one", role: "user", createdAt: 1, content: "真实目标" },
              {
                id: "two",
                parentId: "one",
                role: "assistant",
                createdAt: 2,
                content: "完整的工具记录与结果\n<script>alert('text')</script>",
              },
            ],
          },
        ],
      };
      const draft = {
        sourceProjectId: "private-project",
        title: "公开案例",
        summary: "真实项目过程",
        category: "研究实践",
        snapshot,
        expectedFileCount: 1,
      };
      await t.test(
        "native project copies retain API records and safely serve the original files",
        async () => {
          const content = Buffer.from("original project file\n");
          const name = `native-${createHash("sha256").update(content).digest("hex")}.txt`;
          const materialId = randomUUID();
          const workspace = {
            version: 1,
            projectId: "private-project",
            sessionId: "source-session",
            responses: {
              "/api/projects": {
                projects: [{ id: "private-project", name: "原项目" }],
              },
              "/api/chat/sessions?projectId=private-project": {
                sessions: [
                  {
                    id: "source-session",
                    projectId: "private-project",
                    busy: false,
                  },
                ],
              },
              "/api/chat/sessions/source-session/messages": {
                messages: [
                  {
                    id: "original",
                    role: "assistant",
                    createdAt: 1,
                    completedAt: 2,
                    parts: [
                      {
                        id: "part",
                        type: "text",
                        text: "original structured reply",
                      },
                      {
                        id: "material-part",
                        type: "material",
                        text: materialId,
                      },
                    ],
                  },
                ],
                queued: [],
                activeLeafId: "original",
              },
              [`/api/materials/${materialId}`]: {
                id: materialId,
                projectId: "private-project",
                files: [
                  {
                    id: "SRC-0001",
                    path: "输入/report.txt",
                    sha256: createHash("sha256").update(content).digest("hex"),
                    status: "ready",
                  },
                ],
              },
            },
            assets: {
              "/api/projects/private-project/file/raw?path=report.txt": name,
              [`/api/materials/${materialId}/SRC-0001/download`]: name,
            },
          };
          const created = await request("/api/platform/admin/cases", {
            method: "POST",
            cookie: admin,
            data: {
              ...draft,
              snapshot: { workspace, sessions: [] },
              expectedFileCount: 1,
            },
          });
          assert.equal(created.status, 201);
          const id = created.data.id;
          assert.equal(
            (
              await request(`/api/platform/cases/${id}/assets`, {
                cookie: reader,
                name,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${id}/files`, {
                method: "POST",
                cookie: admin,
                name,
                bytes: content,
              })
            ).status,
            201,
          );
          let current = (
            await request(`/api/platform/admin/cases/${id}`, { cookie: admin })
          ).data;
          assert.deepEqual(
            current.snapshot.workspace.responses,
            workspace.responses,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${id}/publish`, {
                method: "POST",
                cookie: admin,
                data: { revision: current.revision, reviewed: true },
              })
            ).status,
            200,
          );
          const file = await request(`/api/platform/cases/${id}/assets`, {
            cookie: reader,
            name,
          });
          assert.equal(file.status, 200);
          assert.deepEqual(file.bytes, content);
          const head = await request(`/api/platform/cases/${id}/assets`, {
            method: "HEAD",
            cookie: reader,
            name,
          });
          assert.equal(head.status, 200);
          assert.equal(
            Number(head.headers.get("content-length")),
            content.length,
          );
          const range = await fetch(
            `${origin}/api/platform/cases/${id}/assets?name=${name}`,
            { headers: { origin, cookie: reader, range: "bytes=0-7" } },
          );
          assert.equal(range.status, 206);
          assert.equal(await range.text(), "original");
          current = (
            await request(`/api/platform/admin/cases/${id}`, { cookie: admin })
          ).data;
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${id}/native`, {
                method: "POST",
                cookie: reader,
                data: { revision: current.revision, workspace, assets: [] },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${id}/native`, {
                method: "POST",
                cookie: admin,
                data: {
                  revision: current.revision,
                  workspace,
                  assets: [{ name, content: content.toString("base64") }],
                },
              })
            ).status,
            200,
          );
          current = (
            await request(`/api/platform/admin/cases/${id}`, { cookie: admin })
          ).data;
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${id}/unpublish`, {
                method: "POST",
                cookie: admin,
                data: { revision: current.revision },
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await request(`/api/platform/cases/${id}/assets`, {
                cookie: reader,
                name,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${id}`, {
                method: "DELETE",
                cookie: admin,
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        "ordinary accounts enter the catalog without gaining shared research access",
        async () => {
          const catalog = await request("/api/platform/catalog-session", {
            cookie: reader,
          });
          assert.equal(catalog.status, 200);
          assert.equal(catalog.data.canAccessResearch, false);
          assert.equal(catalog.data.user.isAdmin, false);
          assert.equal(
            (await request("/api/platform/browser-session", { cookie: reader }))
              .status,
            403,
          );
          assert.equal(
            (
              await request("/api/platform/browser-session", {
                cookie: researchOwner,
              })
            ).status,
            200,
          );
          assert.equal((await request("/api/platform/cases")).status, 401);
          assert.equal(
            (
              await request("/api/platform/cases", {
                cookie: reader,
                origin: "https://foreign.invalid",
              })
            ).status,
            403,
          );
          assert.equal(
            (await request("/api/platform/cases", { method: "OPTIONS" }))
              .status,
            204,
          );
          assert.equal(
            (
              await request("/api/platform/cases", {
                cookie: reader,
                origin: null,
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        "only system administrators create drafts; drafts never appear in public reads",
        async () => {
          for (const cookie of [reader, researchOwner])
            assert.equal(
              (
                await request("/api/platform/admin/cases", {
                  method: "POST",
                  cookie,
                  data: draft,
                })
              ).status,
              403,
            );
          assert.equal(
            (
              await request("/api/platform/admin/cases", {
                method: "POST",
                cookie: admin,
                origin: "https://foreign.invalid",
                data: draft,
              })
            ).status,
            403,
          );
          const created = await request("/api/platform/admin/cases", {
            method: "POST",
            cookie: admin,
            data: draft,
          });
          assert.equal(created.status, 201);
          caseId = created.data.id;
          assert.deepEqual(
            (await request("/api/platform/cases", { cookie: reader })).data
              .cases,
            [],
          );
          assert.equal(
            (await request(`/api/platform/cases/${caseId}`, { cookie: reader }))
              .status,
            404,
          );
          assert.equal(
            (await request("/api/platform/cases/not-an-id", { cookie: reader }))
              .status,
            404,
          );
          const detail = await request(`/api/platform/admin/cases/${caseId}`, {
            cookie: admin,
          });
          assert.equal(detail.data.source_project_id, "private-project");
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/publish`, {
                method: "POST",
                cookie: admin,
                data: { revision: detail.data.revision, reviewed: true },
              })
            ).status,
            409,
          );
        },
      );
      const content = Buffer.from(
        "<html><script>window.shouldNeverRun=true</script>科研结果</html>",
      );
      await t.test(
        "artifact bytes are copied and protected until all uploads and review complete",
        async () => {
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/files`, {
                method: "POST",
                cookie: reader,
                name: "result.html",
                bytes: content,
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/files`, {
                method: "POST",
                cookie: admin,
                name: "../secret",
                bytes: content,
              })
            ).status,
            400,
          );
          const saved = await request(
            `/api/platform/admin/cases/${caseId}/files`,
            {
              method: "POST",
              cookie: admin,
              name: "成果.html",
              bytes: content,
            },
          );
          assert.equal(saved.status, 201);
          fileId = saved.data.id;
          assert.equal(
            saved.data.sha256,
            createHash("sha256").update(content).digest("hex"),
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/files`, {
                method: "POST",
                cookie: admin,
                name: "成果.html",
                bytes: content,
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await request(`/api/platform/cases/${caseId}/files/${fileId}`, {
                cookie: reader,
              })
            ).status,
            404,
          );
          assert.deepEqual(
            (
              await request(
                `/api/platform/admin/cases/${caseId}/files/${fileId}`,
                { cookie: admin },
              )
            ).bytes,
            content,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/publish`, {
                method: "POST",
                cookie: admin,
                data: { revision: 1, reviewed: true },
              })
            ).status,
            409,
          );
          const current = (
            await request(`/api/platform/admin/cases/${caseId}`, {
              cookie: admin,
            })
          ).data;
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/publish`, {
                method: "POST",
                cookie: admin,
                data: { revision: current.revision },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/publish`, {
                method: "POST",
                cookie: admin,
                data: { revision: current.revision, reviewed: true },
              })
            ).status,
            200,
          );
        },
      );
      await t.test(
        "public readers get inert complete snapshots and downloads, never source identifiers or write access",
        async () => {
          const result = await request(`/api/platform/cases/${caseId}`, {
            cookie: reader,
          });
          assert.equal(result.status, 200);
          assert.deepEqual(result.data.snapshot, {
            sessions: [
              {
                title: snapshot.sessions[0].title,
                messages: snapshot.sessions[0].messages.map((m) => ({
                  ...m,
                  parentId: m.parentId ?? null,
                })),
              },
            ],
          });
          assert.equal("source_project_id" in result.data, false);
          assert.equal("created_by" in result.data, false);
          assert.equal(
            (await request("/api/platform/cases", { cookie: reader })).data
              .cases.length,
            1,
          );
          const file = await request(
            `/api/platform/cases/${caseId}/files/${fileId}`,
            { cookie: reader },
          );
          assert.deepEqual(file.bytes, content);
          assert.match(file.headers.get("content-disposition"), /^attachment;/);
          assert.equal(
            file.headers.get("content-type"),
            "application/octet-stream",
          );
          assert.match(file.headers.get("content-security-policy"), /sandbox/);
          assert.equal(file.headers.get("cache-control"), "private, no-store");
          assert.equal(
            (await request(`/api/platform/cases/${caseId}/files/${fileId}`))
              .status,
            401,
          );
          assert.equal(
            (
              await request(`/api/platform/cases/${caseId}`, {
                method: "DELETE",
                cookie: reader,
              })
            ).status,
            405,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/files`, {
                method: "POST",
                cookie: admin,
                name: "new.txt",
                bytes: Buffer.from("new"),
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}`, {
                method: "DELETE",
                cookie: admin,
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        "ordering, live administrator checks, unpublishing and session revocation are enforced",
        async () => {
          let current = (
            await request(`/api/platform/admin/cases/${caseId}`, {
              cookie: admin,
            })
          ).data;
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/order`, {
                method: "POST",
                cookie: admin,
                data: { revision: current.revision, order: -3 },
              })
            ).status,
            200,
          );
          await pool.query(
            "UPDATE platform_users SET is_admin=false WHERE email='admin@cases.invalid'",
          );
          assert.equal(
            (await request("/api/platform/admin/cases", { cookie: admin }))
              .status,
            403,
          );
          await pool.query(
            "UPDATE platform_users SET is_admin=true WHERE email='admin@cases.invalid'",
          );
          current = (
            await request(`/api/platform/admin/cases/${caseId}`, {
              cookie: admin,
            })
          ).data;
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}/unpublish`, {
                method: "POST",
                cookie: admin,
                data: { revision: current.revision },
              })
            ).status,
            200,
          );
          assert.equal(
            (await request(`/api/platform/cases/${caseId}`, { cookie: reader }))
              .status,
            404,
          );
          assert.equal(
            (
              await request(`/api/platform/cases/${caseId}/files/${fileId}`, {
                cookie: reader,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await request(`/api/platform/admin/cases/${caseId}`, {
                method: "DELETE",
                cookie: admin,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM featured_case_files WHERE case_id=$1",
                [caseId],
              )
            ).rows[0].count,
            0,
          );
          await request("/api/platform/logout", {
            method: "POST",
            cookie: reader,
            data: {},
          });
          assert.equal(
            (await request("/api/platform/cases", { cookie: reader })).status,
            401,
          );
        },
      );
    } finally {
      if (app) await app.close();
      else await pool.end();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      await owner.end();
    }
  },
);
