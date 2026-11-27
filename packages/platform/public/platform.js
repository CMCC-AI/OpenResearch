const app = document.querySelector("#app");
const account = document.querySelector("#account");
const dialog = document.querySelector("#detail");
const detail = document.querySelector("#detail-body");
let me = null;
let runtimeTimer;
let sceneFrame;
let sceneCleanup;
let bootLoginTimer;
function stopSceneMotion() {
  if (sceneFrame && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(sceneFrame);
    sceneFrame = 0;
  }
  if (sceneCleanup) {
    sceneCleanup();
    sceneCleanup = null;
  }
}
window.addEventListener("pagehide", () => {
  clearTimeout(runtimeTimer);
  clearTimeout(bootLoginTimer);
  stopSceneMotion();
});

async function hostedHome(capabilities) {
  stopSceneMotion();
  authMounted = false;
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

const SVG_EYE_OFF =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';
const SVG_EYE_ON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const SVG_BRAND_BLUE = (size, suffix) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 40 40" fill="none" aria-hidden="true"><defs><linearGradient id="mLeft-${suffix}" x1="4.8" y1="10.6" x2="4.8" y2="33" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1d6ef5"/><stop offset="1" stop-color="#3b8eff"/></linearGradient><linearGradient id="mTop-${suffix}" x1="2" y1="9" x2="30.4" y2="6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3898ff"/><stop offset="0.6" stop-color="#1d6ef5"/><stop offset="1" stop-color="#155ee0"/></linearGradient><linearGradient id="mRight-${suffix}" x1="19.5" y1="26" x2="36" y2="20" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2c84f8"/><stop offset="0.55" stop-color="#56a7ff"/><stop offset="1" stop-color="#7ec0ff"/></linearGradient></defs><path d="M2 10.4L7.6 13.5V33L2 29.8V10.4Z" fill="url(#mLeft-${suffix})"/><path d="M2 10.6L20 0.2L30.4 6.1V7.1L20 13.1L12.2 8.7L7.6 13.8L2 10.6Z" fill="url(#mTop-${suffix})"/><path d="M13 16.9L20.2 21V39.8L13 35.8V16.9Z" fill="#1d6ef5"/><path d="M20 21L26.8 17.1V27.8L32.6 24.4V8.8L34.4 7.4L38 9.5V29.4L20 39.8V21Z" fill="url(#mRight-${suffix})"/></svg>`;

const SCIENCE_SCENE_HTML = `<div class="auth-scene" id="auth-scene" aria-hidden="true">
  <svg class="auth-scene__trail" viewBox="0 0 460 270" fill="none">
    <path d="M74 214 C 52 134, 128 38, 258 46 C 350 52, 412 126, 366 196 C 330 250, 212 260, 118 228" stroke="#c3d9f6" stroke-width="1.5" stroke-dasharray="4 7" stroke-linecap="round"/>
  </svg>
  <div class="auth-scene__piece auth-scene__formula" data-piece="formula">
    <svg viewBox="0 0 112 126" fill="none">
      <rect x="1" y="1" width="110" height="124" rx="15" fill="#e8f1ff" stroke="#d5e5fb" stroke-width="1.5"/>
      <path d="M70 35 H42 L58 56 L42 77 H70" stroke="#1d6ef5" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="28" y="93" width="56" height="6" rx="3" fill="#b7d2f7"/>
      <rect x="36" y="105" width="40" height="5" rx="2.5" fill="#c9defa"/>
    </svg>
  </div>
  <div class="auth-scene__piece auth-scene__paper" data-piece="paper">
    <div class="auth-scene__sheet-back"></div>
    <svg class="auth-scene__sheet" viewBox="0 0 198 226" fill="none">
      <rect x="1" y="1" width="196" height="224" rx="19" fill="#ffffff" stroke="#dce7f5" stroke-width="1.5"/>
      <g stroke="#1d6ef5" stroke-width="2" stroke-linejoin="round" fill="#e6f0ff">
        <polygon points="34,26 42,30.5 42,39.5 34,44 26,39.5 26,30.5"/>
        <polygon points="48,34.5 55,38.5 55,46.5 48,50.5 41,46.5 41,38.5"/>
      </g>
      <rect x="74" y="29" width="90" height="8" rx="4" fill="#b9d4f8"/>
      <rect x="74" y="44" width="60" height="6" rx="3" fill="#d9e7fb"/>
      <rect x="25" y="70" width="148" height="104" rx="12" fill="#f7faff" stroke="#e4eefb"/>
      <line x1="39" y1="100" x2="159" y2="100" stroke="#e7f0fc" stroke-width="1"/>
      <line x1="39" y1="126" x2="159" y2="126" stroke="#e7f0fc" stroke-width="1"/>
      <line x1="39" y1="152" x2="159" y2="152" stroke="#e7f0fc" stroke-width="1"/>
      <defs>
        <linearGradient id="sciCurveFill" x1="0" y1="88" x2="0" y2="162" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#3b8eff" stop-opacity="0.28"/>
          <stop offset="1" stop-color="#3b8eff" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="M38 156 C 58 152, 68 112, 86 116 C 102 120, 108 144, 122 126 C 135 109, 144 88, 160 100 L160 162 L38 162 Z" fill="url(#sciCurveFill)"/>
      <path d="M38 156 C 58 152, 68 112, 86 116 C 102 120, 108 144, 122 126 C 135 109, 144 88, 160 100" stroke="#1d6ef5" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="86" cy="116" r="3.5" fill="#ffffff" stroke="#1d6ef5" stroke-width="2"/>
      <circle cx="148" cy="96" r="3.5" fill="#1d6ef5"/>
      <rect x="26" y="188" width="96" height="6" rx="3" fill="#d3e3f9"/>
      <rect x="26" y="201" width="66" height="5" rx="2.5" fill="#e2edfc"/>
    </svg>
  </div>
  <div class="auth-scene__piece auth-scene__flask" data-piece="flask">
    <svg viewBox="0 0 132 142" fill="none">
      <g stroke="#1d6ef5" stroke-width="2" stroke-linecap="round">
        <line x1="30" y1="22" x2="45" y2="30"/>
        <line x1="30" y1="22" x2="22" y2="36"/>
        <line x1="45" y1="30" x2="57" y2="21"/>
      </g>
      <circle cx="30" cy="22" r="5" fill="#60a5fa" stroke="#1d6ef5" stroke-width="1.8"/>
      <circle cx="45" cy="30" r="4" fill="#dbeafe" stroke="#1d6ef5" stroke-width="1.8"/>
      <circle cx="22" cy="36" r="4" fill="#93c5fd" stroke="#1d6ef5" stroke-width="1.8"/>
      <circle cx="57" cy="21" r="3.5" fill="#1d6ef5"/>
      <circle cx="77" cy="14" r="3.2" fill="#93c5fd"/>
      <circle cx="86" cy="23" r="2.2" fill="#bfdbfe"/>
      <defs>
        <linearGradient id="flaskLiquid" x1="60" y1="86" x2="108" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#3b8eff"/>
          <stop offset="1" stop-color="#155ee0"/>
        </linearGradient>
        <linearGradient id="flaskGlass" x1="56" y1="36" x2="108" y2="128" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ffffff" stop-opacity="0.88"/>
          <stop offset="1" stop-color="#dbeafe" stop-opacity="0.72"/>
        </linearGradient>
      </defs>
      <path d="M68 40 H94 L88 47 V72 L114 114 C118 120 113 128 106 128 H56 C49 128 44 120 48 114 L74 72 V47 L68 40 Z" fill="url(#flaskGlass)" stroke="#2563eb" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M58 96 C 72 90, 88 102, 104 96 L112 113 C115 119 111 125 104 125 H58 C51 125 47 119 50 113 Z" fill="url(#flaskLiquid)"/>
      <path d="M60 95 C 73 90, 88 100, 103 95" stroke="#93c5fd" stroke-width="1.8" stroke-linecap="round"/>
      <rect x="64" y="34" width="34" height="6" rx="3" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
      <circle cx="73" cy="112" r="3" fill="#93c5fd" fill-opacity="0.7"/>
      <circle cx="88" cy="107" r="2.2" fill="#dbeafe" fill-opacity="0.8"/>
    </svg>
  </div>
  <div class="auth-scene__piece auth-scene__caption" data-piece="caption">
    <span class="auth-scene__caption-dot" aria-hidden="true"></span>
    <span>每一次探索都从一个问题开始</span>
  </div>
</div>`;

function bindSceneMotion() {
  stopSceneMotion();
  const scene = document.querySelector("#auth-scene");
  if (!scene || typeof scene.addEventListener !== "function") return;
  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion || typeof requestAnimationFrame !== "function") return;

  const pieces =
    typeof scene.querySelectorAll === "function"
      ? Array.from(scene.querySelectorAll(".auth-scene__piece"))
      : [];
  let targetX = 0;
  let targetY = 0;
  let curX = 0;
  let curY = 0;
  let activePiece = null;
  const pieceState = new Map(pieces.map((el) => [el, { lift: 0, turn: 0 }]));

  const tick = () => {
    curX += (targetX - curX) * 0.14;
    curY += (targetY - curY) * 0.14;
    scene.style.setProperty("--scene-x", `${curX.toFixed(2)}px`);
    scene.style.setProperty("--scene-y", `${curY.toFixed(2)}px`);
    let moving =
      Math.abs(targetX - curX) > 0.04 || Math.abs(targetY - curY) > 0.04;
    for (const el of pieces) {
      const state = pieceState.get(el);
      const hovered = el === activePiece;
      const goalLift = hovered ? 8 : 0;
      const goalTurn = hovered ? 3.5 : 0;
      state.lift += (goalLift - state.lift) * 0.16;
      state.turn += (goalTurn - state.turn) * 0.16;
      el.style.setProperty("--hover-lift", `${state.lift.toFixed(2)}px`);
      el.style.setProperty("--hover-turn", `${state.turn.toFixed(2)}deg`);
      if (
        Math.abs(goalLift - state.lift) > 0.04 ||
        Math.abs(goalTurn - state.turn) > 0.04
      ) {
        moving = true;
      }
    }
    if (moving) {
      sceneFrame = requestAnimationFrame(tick);
    } else {
      sceneFrame = 0;
    }
  };

  const wake = () => {
    if (!sceneFrame) sceneFrame = requestAnimationFrame(tick);
  };

  const onMove = (event) => {
    const rect = scene.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = (event.clientX - rect.left) / rect.width - 0.5;
    const ny = (event.clientY - rect.top) / rect.height - 0.5;
    targetX = Math.max(-12, Math.min(12, nx * 20));
    targetY = Math.max(-10, Math.min(10, ny * 16));
    const hovered = event.target?.closest?.(".auth-scene__piece") || null;
    activePiece = hovered;
    wake();
  };

  const onLeave = () => {
    targetX = 0;
    targetY = 0;
    activePiece = null;
    wake();
  };

  scene.addEventListener("pointermove", onMove);
  scene.addEventListener("pointerleave", onLeave);
  sceneCleanup = () => {
    scene.removeEventListener("pointermove", onMove);
    scene.removeEventListener("pointerleave", onLeave);
  };
}

function passwordField(label, name, autocomplete, minimum = false) {
  const fieldId = `password-${name}`;
  return `<label for="${fieldId}">${label}<span class="auth-input-wrap password-control"><input id="${fieldId}" name="${name}" type="password" autocomplete="${autocomplete}" enterkeyhint="done" placeholder="${minimum ? "至少 12 个字符" : "请输入密码"}" ${minimum ? 'minlength="12"' : ""} maxlength="256" required><button type="button" data-password-toggle="${fieldId}" aria-controls="${fieldId}" aria-label="显示${label}" aria-pressed="false">${SVG_EYE_OFF}</button></span></label>`;
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-password-toggle]");
  if (!button) return;
  const field = document.getElementById(button.dataset.passwordToggle);
  const visible = field.type === "password";
  field.type = visible ? "text" : "password";
  button.innerHTML = visible ? SVG_EYE_ON : SVG_EYE_OFF;
  button.setAttribute("aria-label", `${visible ? "隐藏" : "显示"}密码`);
  button.setAttribute("aria-pressed", String(visible));
});

function recovery(mode) {
  stopSceneMotion();
  authMounted = false;
  document.body.classList.add("auth-page");
  document.body.classList.remove("auth-login-view");
  account.innerHTML = "";
  const resetting = mode === "reset";
  app.removeAttribute?.("aria-busy");
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
  stopSceneMotion();
  authMounted = true;
  const registering = mode === "register";
  document.body.classList.add("auth-page", "auth-login-view");
  account.innerHTML = "";
  app.removeAttribute?.("aria-busy");
  // TODO(security): strictly static constant markup; kept compatible with account-ui.test.mjs minimal VM DOM mock.
  app.innerHTML = `<div class="auth-viewport">
    <section class="auth-shell" data-auth-mode-view="${registering ? "register" : "login"}">
      <div class="auth-story">
        <a href="/" class="auth-brand" aria-label="MobileSci 首页">
          ${SVG_BRAND_BLUE(32, "top")}
          <span>MobileSci</span>
        </a>
        <h1>从一个 Idea，<br>到一篇 <em>Paper。<svg class="auth-headline-underline" viewBox="0 0 180 14" fill="none" aria-hidden="true"><path d="M4 10 Q90 1 176 9" stroke="#93c5fd" stroke-width="5.5" stroke-linecap="round"/></svg></em></h1>
        <p class="auth-story-sub">智能体协同科研全链路，让科学假设加速验证成稿。</p>
        ${SCIENCE_SCENE_HTML}
      </div>
      <section class="auth auth-panel">
        <div class="auth-panel-mark" aria-hidden="true">${SVG_BRAND_BLUE(42, "form")}</div>
        <h2>${registering ? "创建 MobileSci 账号" : "欢迎使用 MobileSci"}</h2>
        <p class="auth-lead">${registering ? "创建账号后自动进入科研工作台。" : "中国移动 AI for Science 科研平台"}</p>
        ${safeContinue ? '<p class="continue-tip">验证完成后将自动继续当前操作</p>' : ""}
        <form id="auth-form">
          ${registering ? `<label for="auth-name">姓名<input id="auth-name" name="name" autocomplete="name" enterkeyhint="next" placeholder="请输入姓名" required maxlength="120"></label>` : ""}
          <label for="auth-email">账号<input id="auth-email" name="email" type="email" autocomplete="username" spellcheck="false" autocapitalize="none" enterkeyhint="next" placeholder="请输入邮箱账号" required></label>
          ${passwordField("密码", "password", registering ? "new-password" : "current-password", registering)}
          ${registering ? '<small class="muted">密码至少 12 个字符，建议使用字母、数字与符号组合。</small>' : '<div class="auth-link-row"><button type="button" class="auth-link-btn" id="forgot-password">忘记密码？</button></div>'}
          <button type="submit" class="primary auth-submit"><span>${registering ? "创建账号" : "登录"}</span><span class="auth-submit-arrow" aria-hidden="true">→</span></button>
        </form>
        <p class="auth-switch-row">${registering ? "已有账号？" : "还没有账号？"}<button type="button" class="auth-switch-link" id="auth-switch">${registering ? "立即登录" : "创建账号"}</button></p>
      </section>
    </section>
    <footer class="auth-footer">中国移动 · MobileSci</footer>
  </div>`;

  bindSceneMotion();
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
let authMounted = false;
function renderAccount(capabilities) {
  stopSceneMotion();
  authMounted = false;
  document.body.classList.remove("auth-page", "auth-login-view");
  account.innerHTML = `<a href="${esc(personalSettingsUrl(capabilities))}">个人设置</a>`;
}

async function administration(capabilities) {
  authMounted = false;
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
    clearTimeout(bootLoginTimer);
  } catch (error) {
    clearTimeout(bootLoginTimer);
    if (error.status !== 401) throw error;
    me = null;
    if (!authMounted) authentication();
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

function boot() {
  const params = new URLSearchParams(location.search);
  const explicitLogin = location.pathname === "/_account/login";
  if (explicitLogin) {
    authentication("login");
  } else if (!params.has("account") && !params.has("admin")) {
    // Render the login view immediately if /me does not settle within 100ms
    // so slow networks or cold backends never block first paint.
    bootLoginTimer = setTimeout(() => {
      if (!me && !authMounted) authentication("login");
    }, 100);
  }
  return load();
}

(resetToken ? Promise.resolve(recovery("reset")) : boot()).catch((error) =>
  notice(error.message),
);
