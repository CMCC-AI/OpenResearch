const app = document.querySelector("#app");
const account = document.querySelector("#account");
const dialog = document.querySelector("#detail");
const detail = document.querySelector("#detail-body");
let me = null;
let runtimeTimer;
window.addEventListener("pagehide", () => clearTimeout(runtimeTimer));

async function hostedHome(capabilities) {
  renderAccount();
  const space = await api("/personal-space", "POST");
  app.innerHTML = `<section class="auth card account-card"><h1>我的科研空间</h1><p id="runtime-status" role="status">正在准备运行环境…</p><button id="enter-space" class="primary" disabled>进入科研工作台</button><button id="retry-space" hidden>重新准备环境</button>${capabilities.deepLiteratureUrl ? '<button id="literature">进入论文精读</button>' : ""}</section>`;
  document.querySelector("#enter-space").onclick = async () => {
    try {
      const launch = await api(`/workspaces/${space.id}/launch`, "POST");
      location.assign(
        `${launch.url}#ticket=${encodeURIComponent(launch.ticket)}`,
      );
    } catch (error) {
      notice(error.message);
    }
  };
  document.querySelector("#retry-space").onclick = async () => {
    try {
      await api(`/workspaces/${space.id}/runtime`, "POST");
      await refresh();
    } catch (error) {
      notice(error.message);
    }
  };
  if (capabilities.deepLiteratureUrl)
    document.querySelector("#literature").onclick = () =>
      location.assign(
        `${capabilities.deepLiteratureUrl}/api/auth/openresearch/start?returnTo=/library`,
      );
  async function refresh() {
    clearTimeout(runtimeTimer);
    if (!document.querySelector("#runtime-status")) return;
    try {
      const runtime = await api(`/workspaces/${space.id}/runtime`);
      const ready = runtime.status === "ready" && runtime.online;
      document.querySelector("#runtime-status").textContent = ready
        ? "环境已就绪，可使用服务器上的科研工具。"
        : runtime.status === "failed"
          ? runtime.error || "环境准备失败，请重试。"
          : "正在准备运行环境，请稍候…";
      document.querySelector("#enter-space").disabled = !ready;
      document.querySelector("#retry-space").hidden =
        runtime.status !== "failed";
    } catch (error) {
      notice(error.message);
    }
    if (document.querySelector("#runtime-status"))
      runtimeTimer = setTimeout(refresh, 5000);
  }
  await refresh();
}

let resetToken = new URLSearchParams(location.hash.slice(1)).get("reset");
const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
const continuePath = new URLSearchParams(location.search).get("continue");
const safeContinue =
  continuePath &&
  /^\/api\/auth\/sso\/authorize\?/.test(continuePath) &&
  !continuePath.startsWith("//")
    ? continuePath
    : null;
if (invite || resetToken)
  history.replaceState(null, "", location.pathname + location.search);

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );

let noticeTimer;
function notice(message) {
  document.querySelector("#notice").textContent = message;
  const error = document.querySelector("#dialog-error");
  if (dialog.open && error) {
    error.hidden = false;
    error.textContent = message;
  }
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(
    () => (document.querySelector("#notice").textContent = ""),
    7000,
  );
}

async function api(path, method = "GET", data) {
  const response = await fetch(`/api/platform${path}`, {
    method,
    headers: data ? { "content-type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response
    .json()
    .catch(() => ({ error: "服务暂时不可用，请稍后重试" }));
  if (!response.ok) {
    const error = new Error(result.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return result;
}

function show(html) {
  detail.innerHTML = `<p id="dialog-error" role="alert" hidden></p>${html}`;
  if (!dialog.open) dialog.showModal();
}

document.querySelector("#close-dialog").onclick = () => dialog.close();

function bindForm(selector, callback) {
  document.querySelector(selector).onsubmit = async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    if (button) button.disabled = true;
    try {
      await callback(Object.fromEntries(new FormData(event.currentTarget)));
    } catch (error) {
      notice(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  };
}

function passwordField(label, name, autocomplete, minimum = false) {
  const fieldId = `password-${name}`;
  return `<label>${label}<span class="password-control"><input id="${fieldId}" name="${name}" type="password" autocomplete="${autocomplete}" ${minimum ? 'minlength="12"' : ""} maxlength="256" required><button type="button" data-password-toggle="${fieldId}" aria-controls="${fieldId}" aria-label="显示${label}" aria-pressed="false">显示</button></span></label>`;
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-password-toggle]");
  if (!button) return;
  const field = document.getElementById(button.dataset.passwordToggle);
  const visible = field.type === "password";
  field.type = visible ? "text" : "password";
  button.textContent = visible ? "隐藏" : "显示";
  button.setAttribute("aria-label", `${visible ? "隐藏" : "显示"}密码`);
  button.setAttribute("aria-pressed", String(visible));
});

function recovery(mode) {
  document.body.classList.add("auth-page");
  account.innerHTML = "";
  const resetting = mode === "reset";
  app.innerHTML = `<section class="auth card recovery-card"><span class="eyebrow">统一科研账号</span><h1>${resetting ? "设置新密码" : "找回密码"}</h1>
    <p>${resetting ? "链接有效期为 20 分钟，只能使用一次。重置后所有设备需要重新登录。" : "输入注册邮箱，我们会发送密码重置链接。"}</p>
    <form id="recovery-form" class="stack">
    ${resetting ? passwordField("新密码", "password", "new-password", true) + passwordField("确认新密码", "confirm", "new-password", true) : '<label>注册邮箱<input name="email" type="email" autocomplete="username" required></label>'}
    <button class="primary" type="submit">${resetting ? "保存新密码" : "发送重置邮件"}</button></form>
    <p id="recovery-status" role="status"></p><button id="back-login">返回登录</button></section>`;
  document.querySelector("#back-login").onclick = () => {
    resetToken = null;
    authentication();
  };
  if (!resetting) {
    api("/auth-options")
      .then((options) => {
        if (
          !options.passwordRecovery &&
          document.querySelector("#recovery-status")
        ) {
          document.querySelector("#recovery-status").textContent =
            "邮件找回尚未启用，请联系管理员协助恢复账号。";
          document.querySelector(
            "#recovery-form button[type=submit]",
          ).disabled = true;
        }
      })
      .catch((error) => notice(error.message));
  }
  bindForm("#recovery-form", async (data) => {
    if (resetting) {
      if (data.password !== data.confirm)
        throw new Error("两次输入的新密码不一致");
      await api("/password/reset", "POST", {
        token: resetToken,
        password: data.password,
      });
      resetToken = null;
      me = null;
      authentication();
      notice("密码已重置，请使用新密码登录。");
    } else {
      const result = await api("/password/forgot", "POST", data);
      document.querySelector("#recovery-status").textContent = result.message;
    }
  });
}

function authentication(mode = "login") {
  const registering = mode === "register";
  document.body.classList.add("auth-page");
  account.innerHTML = "";
  app.innerHTML = `<section class="auth-shell">
    <div class="auth-story">
      <span class="product-pill">AI 原生科研工作台</span>
      <h1>让科研智能体<br>与你共同推进<br><em>每一次研究</em></h1>
      <p>从论文发现、研究构思到实验验证与科学写作，在一个可追溯的工作台持续推进。</p>
      <div class="research-flow" aria-label="产品能力">
        <span><b>01</b> 发现论文</span>
        <span><b>02</b> 形成假设</span>
        <span><b>03</b> 执行实验</span>
        <span><b>04</b> 沉淀成果</span>
      </div>
    </div>
    <section class="auth card">
      <span class="eyebrow">统一科研账号</span>
      <h2>${registering ? "创建账号" : "欢迎回来"}</h2>
      <p class="auth-lead">${registering ? "创建账号后自动登录并进入科研主页。" : "登录后直接进入科研主页。"}</p>
      ${safeContinue ? '<p class="continue-tip">验证完成后将自动继续当前操作</p>' : ""}
      <form id="auth-form">
        ${registering ? '<label>姓名<input name="name" autocomplete="name" placeholder="请输入姓名" required maxlength="120"></label>' : ""}
        <label>邮箱<input name="email" type="email" autocomplete="username" placeholder="name@example.com" required></label>
        ${passwordField("密码", "password", registering ? "new-password" : "current-password", registering)}
        ${registering ? '<small class="muted">密码至少 12 个字符。</small>' : '<button type="button" class="auth-switch" id="forgot-password">忘记密码？</button>'}
        <button type="submit" class="primary auth-submit">${registering ? "创建账号并进入" : "登录并进入"}<span>→</span></button>
      </form>
      <button class="auth-switch" id="auth-switch">${registering ? "已有账号？返回登录" : "第一次使用？创建账号"}</button>
    </section>
  </section>`;
  bindForm("#auth-form", async (data) => {
    await api(registering ? "/register" : "/login", "POST", data);
    if (invite) await acceptInvite();
    await load();
  });
  if (!registering)
    document.querySelector("#forgot-password").onclick = () =>
      recovery("forgot");
  document.querySelector("#auth-switch").onclick = () =>
    authentication(registering ? "login" : "register");
}

async function acceptInvite() {
  try {
    await api("/invites/accept", "POST", { token: invite });
    notice("邀请已接受");
  } catch (error) {
    notice(error.message);
  }
}

function passwordDialog() {
  show(`<h2>修改密码</h2>
    <p>保存后会退出所有产品，需要重新登录。</p>
    <form id="password-form" class="stack">
      ${passwordField("当前密码", "current", "current-password")}
      ${passwordField("新密码", "password", "new-password", true)}
      <button type="submit" class="primary">保存并退出</button>
    </form>`);
  bindForm("#password-form", async (data) => {
    await api("/password", "POST", data);
    dialog.close();
    authentication();
  });
}

function renderAccount() {
  document.body.classList.remove("auth-page");
  account.innerHTML = `<span class="muted">${esc(me.name)}</span> ${me.isAdmin ? '<a class="admin-link" href="/_account/login?admin=1">系统管理</a>' : ""} <button id="password">修改密码</button> <button id="logout">退出</button>`;
  document.querySelector("#password").onclick = passwordDialog;
  document.querySelector("#logout").onclick = async () => {
    await api("/logout", "POST");
    me = null;
    authentication();
  };
  app.innerHTML = `<section class="auth card account-card">
    <span class="eyebrow">ACCOUNT</span>
    <h1>账号设置</h1>
    <dl class="account-details">
      <div><dt>姓名</dt><dd>${esc(me.name)}</dd></div>
      <div><dt>邮箱</dt><dd>${esc(me.email)}</dd></div>
    </dl>
  </section>`;
}

async function administration() {
  if (!me.isAdmin) {
    app.innerHTML =
      '<section class="card"><h1>无权访问系统管理</h1><p>此页面仅对系统管理员开放。</p><a href="/">返回主页</a></section>';
    return;
  }
  app.innerHTML = `<section class="card admin-panel"><div class="hero"><div><span class="eyebrow">系统管理</span><h1>注册用户</h1><p class="muted">查看账号注册和登录情况，不展示密码或科研内容。</p></div><button id="admin-workbench">进入科研主页</button></div>
    <div id="user-summary" class="admin-summary"></div>
    <form id="user-search" class="admin-search"><label>搜索用户<input name="q" type="search" maxlength="120" placeholder="姓名或邮箱"></label><button type="submit">搜索</button></form>
    <p id="users-status" role="status"></p><div class="table-scroll"><table><thead><tr><th>姓名</th><th>邮箱</th><th>角色</th><th>状态</th><th>注册时间</th><th>最近登录</th><th>空间数</th></tr></thead><tbody id="users-body"></tbody></table></div>
    <div class="admin-pagination"><button id="users-prev">上一页</button><span id="users-page"></span><button id="users-next">下一页</button></div></section>`;
  document.querySelector("#admin-workbench").onclick = async () => {
    try {
      const capabilities = await api("/capabilities");
      if (capabilities.privateSpaces) await hostedHome(capabilities);
      else location.assign(capabilities.openResearchAppUrl);
    } catch (error) {
      notice(error.message);
    }
  };
  let page = 1,
    query = "",
    loading = false;
  const date = (v) => (v ? new Date(v).toLocaleString("zh-CN") : "尚未登录");
  async function refresh() {
    if (loading) return;
    loading = true;
    document.querySelector("#users-status").textContent = "正在加载…";
    document.querySelector("#user-search button").disabled = true;
    document.querySelector("#users-prev").disabled = true;
    document.querySelector("#users-next").disabled = true;
    try {
      const result = await api(
        `/admin/users?page=${page}&q=${encodeURIComponent(query)}`,
      );
      document.querySelector("#user-summary").innerHTML = [
        ["注册用户", result.summary.total],
        ["正常账号", result.summary.enabled],
        ["停用账号", result.summary.disabled],
        ["管理员", result.summary.admins],
      ]
        .map(
          ([label, value]) =>
            `<div><span>${label}</span><strong>${value}</strong></div>`,
        )
        .join("");
      document.querySelector("#users-body").innerHTML = result.users
        .map(
          (u) =>
            `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.is_admin ? "管理员" : "普通用户"}</td><td>${u.disabled ? "已停用" : "正常"}</td><td>${esc(date(u.created_at))}</td><td>${esc(date(u.last_login_at))}</td><td>${u.workspace_count}</td></tr>`,
        )
        .join("");
      document.querySelector("#users-status").textContent = result.total
        ? `共找到 ${result.total} 位用户`
        : "没有匹配的用户";
      document.querySelector("#users-page").textContent =
        `第 ${page} / ${Math.max(1, Math.ceil(result.total / result.pageSize))} 页`;
      document.querySelector("#users-prev").disabled = page === 1;
      document.querySelector("#users-next").disabled =
        page * result.pageSize >= result.total;
    } catch (error) {
      document.querySelector("#users-status").textContent = error.message;
    } finally {
      loading = false;
      document.querySelector("#user-search button").disabled = false;
    }
  }
  document.querySelector("#user-search").onsubmit = (event) => {
    event.preventDefault();
    if (loading) return;
    query = new FormData(event.currentTarget).get("q");
    page = 1;
    void refresh();
  };
  document.querySelector("#users-prev").onclick = () => {
    if (!loading) {
      page--;
      void refresh();
    }
  };
  document.querySelector("#users-next").onclick = () => {
    if (!loading) {
      page++;
      void refresh();
    }
  };
  await refresh();
}

async function load() {
  try {
    me = await api("/me");
  } catch (error) {
    if (error.status !== 401) throw error;
    me = null;
    authentication();
    return;
  }
  if (safeContinue) {
    location.replace(safeContinue);
    return;
  }
  if (
    new URLSearchParams(location.search).has("admin") ||
    (me.isAdmin && !new URLSearchParams(location.search).has("account"))
  ) {
    renderAccount();
    await administration();
    return;
  }
  if (!new URLSearchParams(location.search).has("account")) {
    const capabilities = await api("/capabilities");
    if (capabilities.privateSpaces) return hostedHome(capabilities);
    location.replace(capabilities.openResearchAppUrl);
    return;
  }
  renderAccount();
}

(resetToken ? Promise.resolve(recovery("reset")) : load())
  .then(async () => {
    if (invite && me) await acceptInvite();
  })
  .catch((error) => notice(error.message));
