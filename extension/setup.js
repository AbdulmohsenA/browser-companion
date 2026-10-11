const $ = (id) => document.getElementById(id);

function show(id, ok, text) {
  $(id).className = "result " + (ok ? "ok" : "bad");
  $(id).textContent = text;
}

$("mic").onclick = async () => {
  try {
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
    show("micResult", true, "Allowed ✓");
  } catch (e) {
    show("micResult", false, `${e.name}: ${e.message}`);
  }
};

$("check").onclick = async () => {
  const tokenUrl = $("tokenUrl").value.trim() || SARJY_DEFAULTS.tokenUrl;
  const accessKey = $("accessKey").value.trim();
  await chrome.storage.local.set({ tokenUrl, accessKey });
  try {
    const r = await fetch(tokenUrl, { headers: accessKey ? { Authorization: `Bearer ${accessKey}` } : {} });
    show("checkResult", r.ok, r.ok ? "Working ✓" : `HTTP ${r.status}`);
  } catch (e) {
    show("checkResult", false, e.message);
  }
};

$("done").onclick = () => window.close();

chrome.storage.local.get(["tokenUrl", "accessKey"]).then(({ tokenUrl, accessKey }) => {
  $("tokenUrl").value = tokenUrl || SARJY_DEFAULTS.tokenUrl;
  $("accessKey").value = accessKey || SARJY_DEFAULTS.accessKey;
});
