const app = document.querySelector("#app");
const account = document.querySelector("#account");
const dialog = document.querySelector("#detail");
const detail = document.querySelector("#detail-body");
let me = null;
let runtimeTimer;
window.addEventListener("pagehide", () => clearTimeout(runtimeTimer));

async function hostedHome(capabilities) {
  renderAccount(capabilities);
  const space = await api("/personal-space", "POST", {});
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
const continuePath = new URLSearchParams(location.search).get("continue");
const safeContinue =
  continuePath &&
  /^\/api\/auth\/sso\/authorize\?/.test(continuePath) &&
  !continuePath.startsWith("//")
    ? continuePath
    : null;
if (resetToken)
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
    await load();
  });
  if (!registering)
    document.querySelector("#forgot-password").onclick = () =>
      recovery("forgot");
  document.querySelector("#auth-switch").onclick = () =>
    authentication(registering ? "login" : "register");
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

function administrationUrl(capabilities) {
  const destination = new URL(capabilities.openResearchAppUrl);
  destination.pathname = destination.pathname.replace(
    /\/projects\/?$/,
    "/admin/users",
  );
  destination.search = "";
  destination.hash = "";
  return destination.href;
}

function renderAccount(capabilities) {
  document.body.classList.remove("auth-page");
  account.innerHTML = `<span class="muted">${esc(me.name)}</span> ${me.isAdmin ? `<a class="admin-link" href="${esc(administrationUrl(capabilities))}">系统管理</a>` : ""} <button id="token-quota">Token 额度</button> <button id="password">修改密码</button> <button id="logout">退出</button>`;
  document.querySelector("#token-quota").onclick = quotaDialog;
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

async function administration(capabilities) {
  if (!me.isAdmin) {
    app.innerHTML =
      '<section class="card"><h1>无权访问系统管理</h1><p>此页面仅对系统管理员开放。</p><a href="/">返回主页</a></section>';
    return;
  }
  location.replace(administrationUrl(capabilities));
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
  const capabilities = await api("/capabilities");
  if (
    new URLSearchParams(location.search).has("admin") ||
    (me.isAdmin && !new URLSearchParams(location.search).has("account"))
  ) {
    renderAccount(capabilities);
    await administration(capabilities);
    return;
  }
  if (!new URLSearchParams(location.search).has("account")) {
    if (capabilities.privateSpaces && !capabilities.sharedOriginSpaces)
      return hostedHome(capabilities);
    location.replace(capabilities.openResearchAppUrl);
    return;
  }
  renderAccount(capabilities);
}

function quotaRequestKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function quotaDialog() {
  dialog.showModal();
  detail.innerHTML = '<p role="status">正在加载额度…</p>';
  try {
    const own = await api("/token-quota");
    if (!own.enabled) {
      detail.innerHTML =
        "<h2>Token 额度</h2><p>当前部署尚未启用平台模型额度。</p>";
      return;
    }
    const usage = (q) =>
      `<dl class="account-details"><div><dt>当前月份</dt><dd>${esc(q.period)}（上海时间）</dd></div><div><dt>月额度</dt><dd>${esc(q.monthlyLimit.toLocaleString())}</dd></div><div><dt>已用</dt><dd>${esc(q.used.toLocaleString())}</dd></div><div><dt>在途及待确认</dt><dd>${esc(q.reserved.toLocaleString())}</dd></div><div><dt>可用</dt><dd>${esc(q.available.toLocaleString())}</dd></div></dl>`;
    detail.innerHTML = `<h2>Token 额度</h2>${usage(own)}<p>每月重置，余额不累积。仅计入平台提供的模型；在途请求按发起月份结算。调用前按模型上下文和输出上限预占，完成后退回差额；余额不足预占时需要调整额度或选择上限较小的模型。</p>${me.isAdmin ? '<hr><h3>配置用户月额度</h3><form id="quota-user" class="stack"><label>用户邮箱<input name="email" type="email" required></label><button type="submit">查询用户</button></form><section id="quota-user-result"></section>' : ""}`;
    if (me.isAdmin)
      bindForm("#quota-user", async (value) => {
        const load = () =>
          api("/admin/token-quotas?email=" + encodeURIComponent(value.email));
        const show = async () => {
          const q = await load();
          const result = document.querySelector("#quota-user-result");
          result.innerHTML = `<h3>${esc(q.user.name)} · ${esc(q.user.email)}</h3>${usage(q)}<form id="quota-config" class="stack"><label>每月 token 额度<input name="monthlyLimit" type="number" min="0" max="9007199254740991" step="1" value="${q.monthlyLimit}" required></label><label>调整原因<input name="reason" maxlength="500" required></label><button type="submit">保存月额度</button></form><h3>待确认请求</h3><p>请先核实供应商用量，再补账；填 0 表示确认未产生用量。不会自动退回不明消费。</p><div id="quota-pending"></div>`;
          const key = quotaRequestKey();
          bindForm("#quota-config", async (data) => {
            await api("/admin/token-quotas", "POST", {
              email: q.user.email,
              monthlyLimit: Number(data.monthlyLimit),
              reason: data.reason,
              idempotencyKey: key,
            });
            await show();
            notice("月额度已保存，已用和在途消费保留");
          });
          const pending = result.querySelector("#quota-pending");
          for (const request of q.requests.filter(
            (r) => r.state !== "settled",
          )) {
            const form = document.createElement("form");
            form.className = "stack";
            form.innerHTML = `<p class="quota-request">${esc(request.period)} · ${esc(request.model)} · ${esc(request.id)} · 上游 ${esc(request.upstream_request_id || "未返回")} · 预占 ${esc(request.reserved)}</p><label>实际 token<input name="actualTokens" type="number" min="0" step="1" max="9007199254740991" required></label><label>补账依据<input name="reason" maxlength="500" required></label><button type="submit">确认并补账</button>`;
            form.onsubmit = async (event) => {
              event.preventDefault();
              const button = form.querySelector("button");
              button.disabled = true;
              try {
                const data = Object.fromEntries(new FormData(form));
                await api("/admin/token-quotas/reconcile", "POST", {
                  email: q.user.email,
                  requestId: request.id,
                  actualTokens: Number(data.actualTokens),
                  reason: data.reason,
                });
                await show();
              } catch (error) {
                notice(error.message);
                button.disabled = false;
              }
            };
            pending.append(form);
          }
          if (!pending.children.length) pending.textContent = "暂无待确认请求";
        };
        await show();
      });
  } catch (error) {
    detail.textContent = error.message;
  }
}

(resetToken ? Promise.resolve(recovery("reset")) : load()).catch((error) =>
  notice(error.message),
);
