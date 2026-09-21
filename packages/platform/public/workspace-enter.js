const ticket = new URLSearchParams(location.hash.slice(1)).get("ticket");
history.replaceState(null, "", location.pathname);

if (!ticket) {
  document.querySelector("#status").textContent =
    "工作空间链接无效，请返回平台重新进入。";
} else {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/_platform/enter";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "ticket";
  input.value = ticket;
  form.append(input);
  document.body.append(form);
  form.submit();
}
