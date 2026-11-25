const app = document.querySelector("#app");
const account = document.querySelector("#account");
const dialog = document.querySelector("#detail");
const detail = document.querySelector("#detail-body");
let me = null;
let runtimeTimer;
let stageTimer;
window.addEventListener("pagehide", () => {
  clearTimeout(runtimeTimer);
  clearTimeout(stageTimer);
});

async function hostedHome(capabilities) {
  clearTimeout(stageTimer);
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

const SVG_MAIL =
  '<svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
const SVG_LOCK =
  '<svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const SVG_USER =
  '<svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>';
const SVG_SHIELD =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></svg>';

const RESEARCH_STAGES = [
  {
    code: "01",
    label: "发现论文",
    chip: "DeepXiv 文献层",
    title: "多源学术检索与深度精读",
    desc: "联动学术图谱与预印本库，自动提炼研究脉络、方法对比与关键缺口，将文献直接带入项目。",
    metrics: ["arXiv / PubMed 检索", "PDF 精读与问答", "自动生成文献笔记"],
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/></svg>',
  },
  {
    code: "02",
    label: "形成假设",
    chip: "专家协同规划",
    title: "拆解研究问题与实验方案",
    desc: "科研专家团协作梳理研究假设、变量控制与评估指标，形成结构化、可审核的研究路线图。",
    metrics: ["多角色专家评审", "研究计划版本化", "人工确认关键门控"],
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
  },
  {
    code: "03",
    label: "执行实验",
    chip: "隔离沙箱运行",
    title: "自动编写脚本并追踪实验指标",
    desc: "在独立科研工作区执行代码与仿真，完整记录命令、Diff、终端日志与每次实验的定量结果。",
    metrics: ["独立工作区与终端", "实时实验日志流", "可对比指标与 Diff"],
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/></svg>',
  },
  {
    code: "04",
    label: "沉淀成果",
    chip: "可复现研究档案",
    title: "整合图表、论文与精选案例",
    desc: "将推理过程、源码改动与可视化图表沉淀为可追溯的研究档案，支持一键分享为只读精选案例。",
    metrics: ["Markdown / LaTeX 报告", "证据链溯源记录", "只读精选案例发布"],
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>',
  },
];

function renderStagePanel(stage) {
  return `<div class="research-stage-head">
    <span class="research-stage-title"><span class="research-stage-icon">${stage.icon}</span>${stage.title}</span>
    <span class="research-stage-chip">${stage.chip}</span>
  </div>
  <p class="research-stage-desc">${stage.desc}</p>
  <div class="research-stage-metrics">${stage.metrics.map((metric) => `<span><i></i>${metric}</span>`).join("")}</div>`;
}

function passwordField(label, name, autocomplete, minimum = false) {
  const fieldId = `password-${name}`;
  return `<label for="${fieldId}">${label}<span class="auth-input-wrap password-control">${SVG_LOCK}<input id="${fieldId}" name="${name}" type="password" autocomplete="${autocomplete}" enterkeyhint="done" placeholder="${minimum ? "至少 12 个字符" : "请输入密码"}" ${minimum ? 'minlength="12"' : ""} maxlength="256" required><button type="button" data-password-toggle="${fieldId}" aria-controls="${fieldId}" aria-label="显示${label}" aria-pressed="false">显示</button></span></label>`;
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
  clearTimeout(stageTimer);
  document.body.classList.add("auth-page");
  account.innerHTML = "";
  const resetting = mode === "reset";
  app.innerHTML = `<section class="auth card recovery-card"><span class="eyebrow">统一科研账号</span><h1>${resetting ? "设置新密码" : "找回密码"}</h1>
    <p>${resetting ? "链接有效期为 20 分钟，只能使用一次。重置后所有设备需要重新登录。" : "输入注册邮箱，我们会发送密码重置链接。"}</p>
    <form id="recovery-form" class="stack">
    ${resetting ? passwordField("新密码", "password", "new-password", true) + passwordField("确认新密码", "confirm", "new-password", true) : `<label for="recovery-email">注册邮箱<span class="auth-input-wrap">${SVG_MAIL}<input id="recovery-email" name="email" type="email" autocomplete="username" spellcheck="false" autocapitalize="none" enterkeyhint="done" placeholder="name@example.com" required></span></label>`}
    <button class="primary auth-submit" type="submit">${resetting ? "保存新密码" : "发送重置邮件"}<span class="auth-submit-arrow" aria-hidden="true">→</span></button></form>
    <p id="recovery-status" role="status"></p><button class="auth-switch" id="back-login">返回登录</button></section>`;
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
  clearTimeout(stageTimer);
  const registering = mode === "register";
  let activeStage = 0;
  let stageLocked = false;
  document.body.classList.add("auth-page");
  account.innerHTML = "";
  app.innerHTML = `<section class="auth-shell">
    <div class="auth-story">
      <span class="product-pill">AI 原生科研工作台</span>
      <h1>让科研智能体<br>与你共同推进<br><em>每一次研究</em></h1>
      <p>从论文发现、研究构思到实验验证与科学写作，在一个可追溯的工作台持续推进。</p>
      <div class="research-stage" id="research-stage">
        <div class="research-stage-tabs" role="group" aria-label="产品能力">
          ${RESEARCH_STAGES.map((stage, index) => `<button type="button" class="research-stage-tab" data-stage-tab="${index}" aria-pressed="${index === 0 ? "true" : "false"}"><b>${stage.code}</b><span>${stage.label}</span></button>`).join("")}
        </div>
        <div class="research-stage-panel" id="research-stage-panel" aria-live="polite">
          ${renderStagePanel(RESEARCH_STAGES[0])}
        </div>
      </div>
    </div>
    <section class="auth card">
      <div class="auth-mode-tabs" role="group" aria-label="账号操作切换">
        <button type="button" class="auth-mode-tab" data-auth-mode="login" aria-pressed="${registering ? "false" : "true"}">登录账号</button>
        <button type="button" class="auth-mode-tab" data-auth-mode="register" aria-pressed="${registering ? "true" : "false"}">创建账号</button>
      </div>
      <span class="eyebrow">统一科研账号</span>
      <h2>${registering ? "创建账号" : "欢迎回来"}</h2>
      <p class="auth-lead">${registering ? "创建账号后自动登录并进入科研主页。" : "登录后直接进入科研主页。"}</p>
      ${safeContinue ? '<p class="continue-tip">验证完成后将自动继续当前操作</p>' : ""}
      <form id="auth-form">
        ${registering ? `<label for="auth-name">姓名<span class="auth-input-wrap">${SVG_USER}<input id="auth-name" name="name" autocomplete="name" enterkeyhint="next" placeholder="请输入姓名" required maxlength="120"></span></label>` : ""}
        <label for="auth-email">邮箱<span class="auth-input-wrap">${SVG_MAIL}<input id="auth-email" name="email" type="email" autocomplete="username" spellcheck="false" autocapitalize="none" enterkeyhint="next" placeholder="name@example.com" required></span></label>
        ${passwordField("密码", "password", registering ? "new-password" : "current-password", registering)}
        ${registering ? '<small class="muted">密码至少 12 个字符，建议使用字母、数字与符号组合。</small>' : '<div class="auth-link-row"><button type="button" class="auth-link-btn" id="forgot-password">忘记密码？</button></div>'}
        <button type="submit" class="primary auth-submit">${registering ? "创建账号并进入" : "登录并进入"}<span class="auth-submit-arrow" aria-hidden="true">→</span></button>
      </form>
      <button type="button" class="auth-switch" id="auth-switch">${registering ? "已有账号？返回登录" : "第一次使用？创建账号"}</button>
      <div class="auth-trust">${SVG_SHIELD}<span>会话加密保护 · 研究项目与数据独立隔离</span></div>
    </section>
  </section>`;

  const selectStage = (index) => {
    const stage = RESEARCH_STAGES[index];
    const panel = document.querySelector("#research-stage-panel");
    if (!stage || !panel) return;
    activeStage = index;
    panel.innerHTML = renderStagePanel(stage);
    if (typeof document.querySelectorAll === "function") {
      for (const tab of document.querySelectorAll("[data-stage-tab]")) {
        tab.setAttribute(
          "aria-pressed",
          tab.dataset.stageTab === String(index) ? "true" : "false",
        );
      }
    }
  };

  const stageRoot = document.querySelector("#research-stage");
  if (stageRoot && typeof stageRoot.addEventListener === "function") {
    stageRoot.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-stage-tab]");
      if (!button) return;
      stageLocked = true;
      clearTimeout(stageTimer);
      selectStage(Number(button.dataset.stageTab));
    });
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reducedMotion) {
      let paused = false;
      stageRoot.addEventListener("mouseenter", () => {
        paused = true;
      });
      stageRoot.addEventListener("mouseleave", () => {
        paused = false;
      });
      stageRoot.addEventListener("focusin", () => {
        paused = true;
      });
      stageRoot.addEventListener("focusout", () => {
        paused = false;
      });
      const scheduleStage = () => {
        stageTimer = setTimeout(() => {
          if (!document.querySelector("#research-stage") || stageLocked) return;
          if (!paused) selectStage((activeStage + 1) % RESEARCH_STAGES.length);
          scheduleStage();
        }, 4500);
      };
      scheduleStage();
    }
  }

  if (typeof document.querySelectorAll === "function") {
    for (const tab of document.querySelectorAll("[data-auth-mode]")) {
      tab.onclick = () => authentication(tab.dataset.authMode);
    }
  }

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

function personalSettingsUrl(capabilities) {
  const destination = new URL(capabilities.openResearchAppUrl);
  destination.pathname = destination.pathname.replace(
    /\/projects\/?$/,
    "/settings/account",
  );
  destination.search = "";
  destination.hash = "";
  return destination.href;
}
function renderAccount(capabilities) {
  clearTimeout(stageTimer);
  document.body.classList.remove("auth-page");
  account.innerHTML = `<a href="${esc(personalSettingsUrl(capabilities))}">个人设置</a>`;
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
    if (capabilities.privateSpaces && capabilities.sharedOriginSpaces)
      fetch("/api/platform/personal-space", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        keepalive: true,
      }).catch(() => {});
    location.replace(capabilities.openResearchAppUrl);
    return;
  }
  location.replace(personalSettingsUrl(capabilities));
}

(resetToken ? Promise.resolve(recovery("reset")) : load()).catch((error) =>
  notice(error.message),
);
