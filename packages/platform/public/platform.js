const app = document.querySelector("#app");
const account = document.querySelector("#account");
const dialog = document.querySelector("#detail");
const detail = document.querySelector("#detail-body");
let me = null;

const invite = new URLSearchParams(location.hash.slice(1)).get("invite");
const continuePath = new URLSearchParams(location.search).get("continue");
const safeContinue =
  continuePath &&
  /^\/api\/auth\/sso\/authorize\?/.test(continuePath) &&
  !continuePath.startsWith("//")
    ? continuePath
    : null;
if (invite) history.replaceState(null, "", location.pathname + location.search);

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
      <p class="auth-lead">${registering ? "创建账号后即可进入你的科研工作台。" : "登录后进入产品主页，并自动同步文献服务。"}</p>
      ${safeContinue ? '<p class="continue-tip">验证完成后将自动继续当前操作</p>' : ""}
      <form id="auth-form">
        ${registering ? '<label>姓名<input name="name" autocomplete="name" placeholder="请输入姓名" required maxlength="120"></label>' : ""}
        <label>邮箱<input name="email" type="email" autocomplete="username" placeholder="name@example.com" required></label>
        <label>密码<input name="password" type="password" autocomplete="${registering ? "new-password" : "current-password"}" placeholder="${registering ? "至少 12 个字符" : "请输入密码"}" ${registering ? 'minlength="12"' : ""} maxlength="256" required></label>
        <button type="submit" class="primary auth-submit">${registering ? "创建账号并进入" : "登录并进入"}<span>→</span></button>
      </form>
      <button class="auth-switch" id="auth-switch">${registering ? "已有账号？返回登录" : "第一次使用？创建账号"}</button>
    </section>
  </section>`;
  bindForm("#auth-form", async (data) => {
    await api(registering ? "/register" : "/login", "POST", data);
    await load();
    if (invite) await acceptInvite();
  });
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
      <label>当前密码<input type="password" name="current" autocomplete="current-password" required></label>
      <label>新密码<input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="256" required></label>
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
  account.innerHTML = `<span class="muted">${esc(me.name)}</span> <button id="password">修改密码</button> <button id="logout">退出</button>`;
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
  if (!new URLSearchParams(location.search).has("account")) {
    const capabilities = await api("/capabilities");
    if (capabilities.deepLiteratureUrl) {
      const login = new URL(
        "/api/auth/openresearch/start",
        capabilities.deepLiteratureUrl,
      );
      login.searchParams.set("returnTo", "/api/auth/openresearch/complete");
      location.replace(login.href);
      return;
    }
    location.replace(capabilities.openResearchAppUrl);
    return;
  }
  renderAccount();
}

load()
  .then(async () => {
    if (invite && me) await acceptInvite();
  })
  .catch((error) => notice(error.message));
