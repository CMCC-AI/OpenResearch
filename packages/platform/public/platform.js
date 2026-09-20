const app = document.querySelector("#app"),
  account = document.querySelector("#account"),
  dialog = document.querySelector("#detail"),
  detail = document.querySelector("#detail-body");
let me,
  workspaces = [];
const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
if (invite) history.replaceState(null, "", location.pathname);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const roles = { owner: "管理员", editor: "研究成员", viewer: "只读成员" };
let noticeTimer;
function notice(message) {
  document.querySelector("#notice").textContent = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(
    () => (document.querySelector("#notice").textContent = ""),
    7000,
  );
}
async function api(path, method = "GET", data) {
  const r = await fetch(`/api/platform${path}`, {
    method,
    headers: data ? { "content-type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "请求失败");
  return result;
}
function show(html) {
  detail.innerHTML = html;
  if (!dialog.open) dialog.showModal();
}
document.querySelector("#close-dialog").onclick = () => dialog.close();
function form(id, callback) {
  document.querySelector(id).onsubmit = async (e) => {
    e.preventDefault();
    const button = e.currentTarget.querySelector("button[type=submit]");
    if (button) button.disabled = true;
    try {
      await callback(Object.fromEntries(new FormData(e.currentTarget)));
    } catch (error) {
      notice(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  };
}
function login() {
  account.innerHTML = "";
  app.innerHTML = `<section class="auth card"><span class="eyebrow">YOUR RESEARCH, CONNECTED</span><h1>登录科研工作空间</h1><p>团队协作、文献发现与实验执行，从这里开始。</p><form id="login"><label>邮箱<input name="email" type="email" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button type="submit" class="primary">登录平台 →</button></form><p class="muted">平台采用邀请制。首次使用请联系团队管理员。</p>${invite ? '<button id="join">使用邀请创建账户</button>' : ""}</section>`;
  form("#login", async (data) => {
    await api("/login", "POST", data);
    await load();
    if (invite) acceptInvite();
  });
  if (invite) document.querySelector("#join").onclick = acceptInvite;
}
function acceptInvite() {
  show(
    `<h2>加入科研团队</h2><p>${me ? "将使用当前已登录邮箱接受邀请。" : "请填写姓名和新密码。邮箱由邀请确定；已有账户请先登录。"}</p><form id="accept" class="stack">${me ? "" : '<label>姓名<input name="name" required maxlength="120"></label><label>新密码<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></label>'}<button type="submit" class="primary">接受邀请</button></form>`,
  );
  form("#accept", async (data) => {
    await api("/invites/accept", "POST", { ...data, token: invite });
    dialog.close();
    notice("已加入团队，请登录或打开工作空间");
    await load();
  });
}
async function load() {
  try {
    me = await api("/me");
  } catch {
    me = null;
    login();
    return;
  }
  workspaces = await api("/workspaces");
  account.innerHTML = `<span class="muted">${esc(me.name)}</span> <button id="refresh">刷新状态</button> <button id="password">修改密码</button> <button id="logout">退出</button>`;
  document.querySelector("#refresh").onclick = () =>
    load().catch((e) => notice(e.message));
  document.querySelector("#logout").onclick = async () => {
    await api("/logout", "POST");
    me = null;
    login();
  };
  document.querySelector("#password").onclick = passwordDialog;
  app.innerHTML = `<div class="hero"><div><span class="eyebrow">RESEARCH TOGETHER</span><h1>你的团队科研空间</h1><p>每个空间拥有独立的研究环境。与团队协作，从论文走向实验与成果。</p></div><button class="primary" id="create">＋ 创建工作空间</button></div><div class="cards">${workspaces.map((w) => `<article class="card"><div class="row"><span class="badge">${roles[w.role]}</span><span class="badge ${w.online ? "" : "offline"}">${w.online ? "执行器在线" : "尚未连接执行器"}</span></div><h2>${esc(w.name)}</h2><p>${w.online ? "进入科研工作台，继续文献、Agent 对话和实验。" : "连接专属电脑或服务器后，即可开始科研任务。"}</p><div class="actions"><button class="primary" data-open="${w.id}">进入工作台 →</button>${w.role === "owner" ? `<button data-manage="${w.id}">空间管理</button>` : ""}</div></article>`).join("")}</div>${workspaces.length ? "" : '<div class="empty"><h2>创建你的第一个工作空间</h2><p>邀请团队成员，连接专属执行器，保留研究过程与结果。</p></div>'}<p class="muted">工作空间内成员共享全部项目。需要隔离的项目，请放入不同工作空间。</p>`;
  document.querySelector("#create").onclick = createDialog;
  document
    .querySelectorAll("[data-open]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          launch(b.dataset.open).catch((e) => notice(e.message))),
    );
  document
    .querySelectorAll("[data-manage]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          manage(b.dataset.manage).catch((e) => notice(e.message))),
    );
}
function createDialog() {
  show(
    '<h2>创建工作空间</h2><p>工作空间是数据、权限和执行环境的隔离边界。</p><form id="create-form" class="stack"><label>空间名称<input name="name" placeholder="例如：具身智能研究组" required maxlength="120"></label><button type="submit" class="primary">创建</button></form>',
  );
  form("#create-form", async (data) => {
    await api("/workspaces", "POST", data);
    dialog.close();
    await load();
  });
}
async function launch(id) {
  const result = await api(`/workspaces/${id}/launch`, "POST");
  const f = document.createElement("form");
  f.method = "POST";
  f.action = result.url;
  const i = document.createElement("input");
  i.type = "hidden";
  i.name = "ticket";
  i.value = result.ticket;
  f.append(i);
  document.body.append(f);
  f.submit();
}
function passwordDialog() {
  show(
    '<h2>修改密码</h2><form id="password-form" class="stack"><label>当前密码<input type="password" name="current" autocomplete="current-password" required></label><label>新密码<input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="256" required></label><button type="submit" class="primary">保存并重新登录</button></form>',
  );
  form("#password-form", async (data) => {
    await api("/password", "POST", data);
    dialog.close();
    await load();
  });
}
async function manage(id) {
  const w = workspaces.find((w) => w.id === id),
    members = await api(`/workspaces/${id}/members`);
  show(
    `<h2>${esc(w.name)}</h2><p>成员、执行器与访问记录</p><h3>成员权限</h3><table><tbody>${members
      .map(
        (m) =>
          `<tr><td>${esc(m.name)}<br><span class="muted">${esc(m.email)}</span></td><td><select data-role="${m.id}" aria-label="${esc(m.name)}的角色">${Object.entries(
            roles,
          )
            .map(
              ([k, v]) =>
                `<option value="${k}" ${k === m.role ? "selected" : ""}>${v}</option>`,
            )
            .join(
              "",
            )}</select></td><td><button class="danger" data-remove="${m.id}">移除</button></td></tr>`,
      )
      .join(
        "",
      )}</tbody></table><form id="invite-form" class="stack section"><h3>邀请成员</h3><label>受邀邮箱<input name="email" type="email" required></label><label>权限<select name="role"><option value="viewer">只读成员</option><option value="editor">研究成员（可执行代码）</option></select></label><button type="submit">生成 24 小时邀请链接</button><div id="invite-result"></div></form><section class="section"><h3>专属执行器</h3><p>每个空间必须使用独立 OS 用户或容器/VM、数据目录和凭据。不要连接存有其他用户资料的个人实例。</p><div class="actions"><button id="rotate">签发 / 轮换连接凭据</button><button id="revoke" class="danger">撤销执行器连接</button></div><div id="runner-result"></div></section><section class="section"><button id="audit">查看最近访问记录</button><div id="audit-result"></div></section>`,
  );
  document.querySelectorAll("[data-role]").forEach(
    (b) =>
      (b.onchange = async () => {
        try {
          await api(`/workspaces/${id}/members/${b.dataset.role}`, "PATCH", {
            role: b.value,
          });
          notice("权限已更新，现有连接将重新鉴权");
          await load();
          if (w.role === "owner") await manage(id);
        } catch (e) {
          notice(e.message);
        }
      }),
  );
  document.querySelectorAll("[data-remove]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (!confirm("移除此成员？该成员将失去整个工作空间的访问权限。"))
          return;
        try {
          await api(`/workspaces/${id}/members/${b.dataset.remove}`, "DELETE");
          await manage(id);
        } catch (e) {
          notice(e.message);
        }
      }),
  );
  form("#invite-form", async (data) => {
    const r = await api(`/workspaces/${id}/invites`, "POST", data);
    document.querySelector("#invite-result").innerHTML =
      `<p>请通过可信渠道发送给受邀人：</p><input class="wide" readonly value="${esc(r.url)}" aria-label="邀请链接">`;
  });
  document.querySelector("#rotate").onclick = async () => {
    if (!confirm("签发新凭据会断开当前执行器。继续？")) return;
    try {
      const r = await api(`/workspaces/${id}/runner`, "POST");
      document.querySelector("#runner-result").innerHTML =
        `<div class="secret"><p>凭据仅显示一次，90 天有效。保存为权限 0600 的文件，不要提交到 Git。</p><input class="wide" readonly aria-label="执行器凭据" value="${esc(r.token)}"><p class="muted">在专属环境安装 OpenResearch 和 platform package，启动本地 orx 后，按部署手册运行连接器。</p><pre>PLATFORM_ORIGIN=${esc(r.platform)}
export RUNNER_TOKEN_FILE=/secure/runner.token
export ORX_UPSTREAM=http://127.0.0.1:4791
export RUNNER_ISOLATION_ACK=dedicated-workspace
PLATFORM_ORIGIN=${esc(r.platform)} npm run runner</pre></div>`;
    } catch (e) {
      notice(e.message);
    }
  };
  document.querySelector("#revoke").onclick = async () => {
    if (
      !confirm(
        "撤销连接会中断当前访问，但不会自动停止已经提交的远端实验。继续？",
      )
    )
      return;
    try {
      await api(`/workspaces/${id}/runner`, "DELETE");
      notice("连接已撤销");
      await load();
      await manage(id);
    } catch (e) {
      notice(e.message);
    }
  };
  document.querySelector("#audit").onclick = async () => {
    try {
      const rows = await api(`/workspaces/${id}/audit`);
      document.querySelector("#audit-result").innerHTML =
        `<table>${rows.map((r) => `<tr><td>${esc(new Date(r.created_at).toLocaleString())}</td><td>${esc(r.action)}</td><td>${esc(r.resource || "")}</td></tr>`).join("")}</table>`;
    } catch (e) {
      notice(e.message);
    }
  };
}
load()
  .then(() => {
    if (invite) acceptInvite();
  })
  .catch((e) => notice(e.message));
