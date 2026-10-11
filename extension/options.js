const input = document.getElementById("key");
const status = document.getElementById("status");
const welcome = document.getElementById("welcome");

chrome.storage.local.get("apiKey").then(({ apiKey }) => {
  if (apiKey) input.value = apiKey;
  else welcome.hidden = false;
});

document.getElementById("save").addEventListener("click", async () => {
  const apiKey = input.value.trim();
  if (apiKey) await chrome.storage.local.set({ apiKey });
  else await chrome.storage.local.remove("apiKey");
  status.textContent = apiKey ? "Saved. Press Ctrl+Shift+Space on any page to try it." : "Key removed";
  welcome.hidden = Boolean(apiKey);
  setTimeout(() => (status.textContent = ""), 4000);
});
