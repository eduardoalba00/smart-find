const input = document.getElementById("key");
const status = document.getElementById("status");

chrome.storage.local.get("apiKey").then(({ apiKey }) => {
  if (apiKey) input.value = apiKey;
});

document.getElementById("save").addEventListener("click", async () => {
  const apiKey = input.value.trim();
  if (apiKey) await chrome.storage.local.set({ apiKey });
  else await chrome.storage.local.remove("apiKey");
  status.textContent = apiKey ? "Saved" : "Key removed";
  setTimeout(() => (status.textContent = ""), 2000);
});
